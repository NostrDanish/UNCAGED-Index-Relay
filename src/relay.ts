import type { Buffer } from "node:buffer";
import type { NostrRelayInfo, NRelay } from "@nostrify/nostrify";
import type { ServerWebSocket } from "bun";
import type { Filter, NostrEvent } from "nostr-tools";
import { verifyEvent } from "nostr-tools";

/** Function that verifies a Nostr event signature. */
export type VerifyFn = (event: NostrEvent) => boolean | Promise<boolean>;

// Track subscriptions per connection
export interface Subscription {
  id: string;
  filters: Filter[];
}

export interface WebSocketData {
  subscriptions: Map<string, Subscription>;
}

export class Relay {
  public storage: NRelay;
  private relayInfo: NostrRelayInfo;
  private verify: VerifyFn;

  constructor(
    storage: NRelay,
    opts?: { relayInfo?: Partial<NostrRelayInfo>; verify?: VerifyFn },
  ) {
    this.storage = storage;
    this.verify = opts?.verify ?? verifyEvent;
    this.relayInfo = {
      name: "Ditto Relay",
      description: "A Nostr relay backed by OpenSearch",
      pubkey: "",
      contact: "",
      supported_nips: [1, 9, 11, 45, 50],
      software: "ditto-relay",
      version: "1.0.0",
      limitation: {
        max_message_length: 128000,
        max_subscriptions: 20,
        max_filters: 100,
        max_limit: 5000,
        max_subid_length: 100,
        max_event_tags: 2000,
        max_content_length: 102400,
        min_pow_difficulty: 0,
        auth_required: false,
        payment_required: false,
      },
      relay_countries: [],
      language_tags: [],
      tags: [],
      posting_policy: "",
      ...opts?.relayInfo,
    };
  }

  getRelayInfo(): NostrRelayInfo {
    return this.relayInfo;
  }

  // Helper to send JSON message to client
  private sendMessage(ws: ServerWebSocket<WebSocketData>, message: unknown[]) {
    ws.send(JSON.stringify(message));
  }

  /**
   * Handle an EVENT message according to NIP-01
   */
  private async handleEventMessage(event: NostrEvent): Promise<{
    eventId: string;
    accepted: boolean;
    message: string;
  }> {
    // Verify event signature (may be async when using worker pool)
    const isValid = await this.verify(event);
    if (!isValid) {
      return {
        eventId: event.id,
        accepted: false,
        message: "invalid: signature verification failed",
      };
    }

    // Handle deletion events (kind 5) using NRelay's remove method
    if (event.kind === 5) {
      try {
        // Extract e and a tags for deletion
        const eTagValues = event.tags
          .filter((tag) => tag[0] === "e" && tag.length >= 2)
          .map((tag) => tag[1]);

        const aTagFilters: Filter[] = [];
        for (const tag of event.tags) {
          if (tag[0] === "a" && tag.length >= 2) {
            const parts = tag[1].split(":");
            if (parts.length === 3) {
              const [kindStr, pubkey, dTag] = parts;
              const kind = Number.parseInt(kindStr, 10);
              // NIP-09: Only allow deletion of own events (pubkey must match)
              if (!Number.isNaN(kind) && pubkey === event.pubkey) {
                const filter: Filter = {
                  kinds: [kind],
                  authors: [pubkey],
                };
                // Only add d-tag filter for addressable events (with non-empty d-tag)
                if (dTag) {
                  filter["#d"] = [dTag];
                }
                aTagFilters.push(filter);
              }
            }
          }
        }

        const filters: Filter[] = [];

        // Filter for event IDs
        if (eTagValues.length > 0) {
          filters.push({
            ids: eTagValues,
            authors: [event.pubkey], // Only delete own events
          });
        }

        // Add addressable event filters
        filters.push(...aTagFilters);

        // Remove matching events
        if (filters.length > 0 && this.storage.remove) {
          await this.storage.remove(filters);
        }

        return {
          eventId: event.id,
          accepted: true,
          message: "",
        };
      } catch (error) {
        console.error("Failed to process deletion event:", error);
        return {
          eventId: event.id,
          accepted: false,
          message: `error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    // Store the event using NRelay's event method
    try {
      await this.storage.event(event);
      return {
        eventId: event.id,
        accepted: true,
        message: "",
      };
    } catch (error) {
      console.error("Failed to store event:", error);
      return {
        eventId: event.id,
        accepted: false,
        message: `error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Handle a COUNT message according to NIP-45
   */
  private async handleCountMessage(
    subscriptionId: string,
    filters: Filter[],
  ): Promise<
    | { success: true; count: number; approximate?: boolean }
    | { success: false; error: { subscriptionId: string; message: string } }
  > {
    const maxFilters = this.relayInfo.limitation?.max_filters || 100;
    const maxSubIdLength = this.relayInfo.limitation?.max_subid_length || 100;

    // Validate subscription ID
    if (!subscriptionId || subscriptionId.length > maxSubIdLength) {
      return {
        success: false,
        error: {
          subscriptionId,
          message: "invalid: subscription ID too long or empty",
        },
      };
    }

    // Validate filters
    if (!Array.isArray(filters) || filters.length === 0) {
      return {
        success: false,
        error: {
          subscriptionId,
          message: "invalid: filters must be a non-empty array",
        },
      };
    }

    if (filters.length > maxFilters) {
      return {
        success: false,
        error: {
          subscriptionId,
          message: "invalid: too many filters",
        },
      };
    }

    // Count events using the storage backend
    try {
      if (!this.storage.count) {
        return {
          success: false,
          error: {
            subscriptionId,
            message: "error: COUNT not supported by this relay",
          },
        };
      }

      const result = await this.storage.count(filters);
      return { success: true, ...result };
    } catch (error) {
      console.error("Failed to count events:", error);
      return {
        success: false,
        error: {
          subscriptionId,
          message: `error: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  /**
   * Handle a REQ message according to NIP-01
   */
  private async handleReqMessage(
    subscriptionId: string,
    filters: Filter[],
  ): Promise<
    | { success: true; events: NostrEvent[] }
    | { success: false; error: { subscriptionId: string; message: string } }
  > {
    const maxFilters = this.relayInfo.limitation?.max_filters || 100;
    const maxSubIdLength = this.relayInfo.limitation?.max_subid_length || 100;

    // Validate subscription ID
    if (!subscriptionId || subscriptionId.length > maxSubIdLength) {
      return {
        success: false,
        error: {
          subscriptionId,
          message: "invalid: subscription ID too long or empty",
        },
      };
    }

    // Validate filters
    if (!Array.isArray(filters) || filters.length === 0) {
      return {
        success: false,
        error: {
          subscriptionId,
          message: "invalid: filters must be a non-empty array",
        },
      };
    }

    if (filters.length > maxFilters) {
      return {
        success: false,
        error: {
          subscriptionId,
          message: "invalid: too many filters",
        },
      };
    }

    // Query and return existing events using NRelay's query method
    try {
      const events = await this.storage.query(filters);
      return { success: true, events };
    } catch (error) {
      console.error("Failed to query events:", error);
      return {
        success: false,
        error: {
          subscriptionId,
          message: `error: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  /**
   * Validate subscription count before adding a new one
   */
  private validateSubscriptionCount(currentCount: number): {
    subscriptionId: string;
    message: string;
  } | null {
    const maxSubscriptions = this.relayInfo.limitation?.max_subscriptions || 20;
    if (currentCount >= maxSubscriptions) {
      return {
        subscriptionId: "",
        message: "rate-limited: too many subscriptions",
      };
    }
    return null;
  }

  // Handle EVENT message
  async handleEvent(ws: ServerWebSocket<WebSocketData>, event: NostrEvent) {
    try {
      const result = await this.handleEventMessage(event);
      this.sendMessage(ws, [
        "OK",
        result.eventId,
        result.accepted,
        result.message,
      ]);
    } catch (error) {
      console.error("Error handling EVENT:", error);
      const message = error instanceof Error ? error.message : String(error);
      this.sendMessage(ws, ["OK", event.id, false, `error: ${message}`]);
    }
  }

  // Handle REQ message
  async handleReq(
    ws: ServerWebSocket<WebSocketData>,
    subscriptionId: string,
    filters: Filter[],
  ) {
    try {
      const data = ws.data;

      // Check subscription limit before processing
      const limitError = this.validateSubscriptionCount(
        data.subscriptions.size,
      );
      if (limitError) {
        this.sendMessage(ws, ["CLOSED", subscriptionId, limitError.message]);
        return;
      }

      // Process the REQ message
      const result = await this.handleReqMessage(subscriptionId, filters);

      if (!result.success) {
        this.sendMessage(ws, [
          "CLOSED",
          result.error.subscriptionId,
          result.error.message,
        ]);
        return;
      }

      // Store subscription
      data.subscriptions.set(subscriptionId, { id: subscriptionId, filters });

      // Send existing events
      for (const event of result.events) {
        this.sendMessage(ws, ["EVENT", subscriptionId, event]);
      }

      // Send EOSE (End of Stored Events)
      this.sendMessage(ws, ["EOSE", subscriptionId]);
    } catch (error) {
      console.error("Error handling REQ:", error);
      const message = error instanceof Error ? error.message : String(error);
      this.sendMessage(ws, ["CLOSED", subscriptionId, `error: ${message}`]);
    }
  }

  // Handle COUNT message
  async handleCount(
    ws: ServerWebSocket<WebSocketData>,
    subscriptionId: string,
    filters: Filter[],
  ) {
    try {
      // Process the COUNT message
      const result = await this.handleCountMessage(subscriptionId, filters);

      if (!result.success) {
        this.sendMessage(ws, [
          "CLOSED",
          result.error.subscriptionId,
          result.error.message,
        ]);
        return;
      }

      // Send count response
      const response: { count: number; approximate?: boolean } = {
        count: result.count,
      };
      if (result.approximate !== undefined) {
        response.approximate = result.approximate;
      }

      this.sendMessage(ws, ["COUNT", subscriptionId, response]);
    } catch (error) {
      console.error("Error handling COUNT:", error);
      const message = error instanceof Error ? error.message : String(error);
      this.sendMessage(ws, ["CLOSED", subscriptionId, `error: ${message}`]);
    }
  }

  // Handle CLOSE message
  handleClose(ws: ServerWebSocket<WebSocketData>, subscriptionId: string) {
    const data = ws.data;
    data.subscriptions.delete(subscriptionId);
  }

  // Handle incoming WebSocket message
  async handleMessage(
    ws: ServerWebSocket<WebSocketData>,
    message: string | Buffer,
  ) {
    try {
      const msg = JSON.parse(message.toString());

      if (!Array.isArray(msg) || msg.length === 0) {
        this.sendMessage(ws, [
          "NOTICE",
          "invalid: message must be a non-empty JSON array",
        ]);
        return;
      }

      const [type, ...params] = msg;

      switch (type) {
        case "EVENT":
          if (params.length !== 1) {
            this.sendMessage(ws, [
              "NOTICE",
              "invalid: EVENT message must have exactly 1 parameter",
            ]);
            return;
          }
          await this.handleEvent(ws, params[0] as NostrEvent);
          break;

        case "REQ": {
          if (params.length < 2) {
            this.sendMessage(ws, [
              "NOTICE",
              "invalid: REQ message must have subscription ID and at least 1 filter",
            ]);
            return;
          }
          const [subId, ...filters] = params;
          await this.handleReq(ws, subId as string, filters as Filter[]);
          break;
        }

        case "COUNT": {
          if (params.length < 2) {
            this.sendMessage(ws, [
              "NOTICE",
              "invalid: COUNT message must have subscription ID and at least 1 filter",
            ]);
            return;
          }
          const [countSubId, ...countFilters] = params;
          await this.handleCount(
            ws,
            countSubId as string,
            countFilters as Filter[],
          );
          break;
        }

        case "CLOSE":
          if (params.length !== 1) {
            this.sendMessage(ws, [
              "NOTICE",
              "invalid: CLOSE message must have exactly 1 parameter",
            ]);
            return;
          }
          this.handleClose(ws, params[0] as string);
          break;

        default:
          this.sendMessage(ws, [
            "NOTICE",
            `invalid: unknown message type: ${type}`,
          ]);
      }
    } catch (error) {
      console.error("Error processing message:", error);
      this.sendMessage(ws, ["NOTICE", "error: failed to process message"]);
    }
  }

  // Handle WebSocket open
  handleOpen(_ws: ServerWebSocket<WebSocketData>) {
    console.log("WebSocket connection opened");
  }

  // Handle WebSocket close
  handleCloseConnection(ws: ServerWebSocket<WebSocketData>) {
    console.log("WebSocket connection closed");
    ws.data?.subscriptions.clear();
  }
}
