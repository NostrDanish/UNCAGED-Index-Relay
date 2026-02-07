import type { Filter, NostrEvent } from "nostr-tools";
import { verifyEvent } from "nostr-tools";
import type { EventStorage } from "./storage.ts";

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
  storage: EventStorage,
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

  // Handle deletion events (kind 5)
  if (event.kind === 5) {
    const deletedCount = await storage.deleteEvents(event);
    return {
      eventId: event.id,
      accepted: true,
      message: `deleted: ${deletedCount} events deleted`,
    };
  }

  // Store the event
  const stored = await storage.storeEvent(event);

  if (stored) {
    return {
      eventId: event.id,
      accepted: true,
      message: "",
    };
  }

  return {
    eventId: event.id,
    accepted: true,
    message: "duplicate: already have this event",
  };
}

/**
 * Handle a REQ message according to NIP-01
 */
export async function handleReqMessage(
  subscriptionId: string,
  filters: Filter[],
  storage: EventStorage,
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

  // Query and return existing events
  const events = await storage.query(filters);

  return { success: true, events };
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
