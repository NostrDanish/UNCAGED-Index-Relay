import type { NRelay } from "@nostrify/nostrify";
import type { Filter, NostrEvent } from "nostr-tools";
import { verifyEvent } from "nostr-tools";

export interface OkResponse {
  eventId: string;
  accepted: boolean;
  message: string;
}

export interface ClosedResponse {
  subscriptionId: string;
  message: string;
}

/**
 * Handle an EVENT message according to NIP-01
 */
export async function handleEventMessage(
  event: NostrEvent,
  storage: NRelay,
): Promise<OkResponse> {
  // Verify event signature
  const isValid = verifyEvent(event);
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
            if (!Number.isNaN(kind)) {
              aTagFilters.push({
                kinds: [kind],
                authors: [pubkey],
                "#d": [dTag],
              });
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
      if (filters.length > 0 && storage.remove) {
        await storage.remove(filters);
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
    await storage.event(event);
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
 * Handle a REQ message according to NIP-01
 */
export async function handleReqMessage(
  subscriptionId: string,
  filters: Filter[],
  storage: NRelay,
  options: {
    maxFilters?: number;
    maxSubIdLength?: number;
  } = {},
): Promise<
  | { success: true; events: NostrEvent[] }
  | { success: false; error: ClosedResponse }
> {
  const { maxFilters = 100, maxSubIdLength = 100 } = options;

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
    const events = await storage.query(filters);
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
export function validateSubscriptionCount(
  currentCount: number,
  maxSubscriptions = 20,
): ClosedResponse | null {
  if (currentCount >= maxSubscriptions) {
    return {
      subscriptionId: "",
      message: "rate-limited: too many subscriptions",
    };
  }
  return null;
}
