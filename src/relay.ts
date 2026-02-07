import type { NostrRelayInfo } from "@nostrify/nostrify";
import type { ServerWebSocket } from "bun";
import type { Filter, NostrEvent } from "nostr-tools";
import {
  handleEventMessage,
  handleReqMessage,
  validateSubscriptionCount,
} from "./protocol.ts";
import type { EventStorage } from "./storage.ts";

// Track subscriptions per connection
export interface Subscription {
  id: string;
  filters: Filter[];
}

export interface WebSocketData {
  subscriptions: Map<string, Subscription>;
}

export class Relay {
  private storage: EventStorage;
  private relayInfo: NostrRelayInfo;

  constructor(storage: EventStorage, relayInfo?: Partial<NostrRelayInfo>) {
    this.storage = storage;
    this.relayInfo = {
      name: "Ditto Relay",
      description: "A Nostr relay backed by OpenSearch",
      pubkey: "",
      contact: "",
      supported_nips: [1, 9, 11, 50],
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
      ...relayInfo,
    };
  }

  getRelayInfo(): NostrRelayInfo {
    return this.relayInfo;
  }

  // Helper to send JSON message to client
  sendMessage(ws: ServerWebSocket<WebSocketData>, message: unknown[]) {
    ws.send(JSON.stringify(message));
  }

  // Handle EVENT message
  async handleEvent(ws: ServerWebSocket<WebSocketData>, event: NostrEvent) {
    try {
      const result = await handleEventMessage(event, this.storage);
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
      const limitError = validateSubscriptionCount(data.subscriptions.size);
      if (limitError) {
        this.sendMessage(ws, ["CLOSED", subscriptionId, limitError.message]);
        return;
      }

      // Process the REQ message
      const result = await handleReqMessage(
        subscriptionId,
        filters,
        this.storage,
      );

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
