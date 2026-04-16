import type { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import type { NostrRelayInfo, NRelay } from "@nostrify/nostrify";
import { NKinds, NSchema as n } from "@nostrify/nostrify";
import type { ServerWebSocket } from "bun";
import type { Filter, NostrEvent } from "nostr-tools";
import { matchFilter, verifyEvent } from "nostr-tools";

import type { AnalyzeResult } from "./analyze-pool.ts";
import {
  relayBroadcastQueueGauge,
  relayConnectionsGauge,
  relayEventsCounter,
  relayMessagesCounter,
  relayReqDurationHistogram,
} from "./metrics.ts";

/** Pre-computed analysis data that can be passed alongside an event to avoid redundant work. */
export interface EventAnalysis {
  search_text?: string;
  language?: string;
  sentiment?: string;
  media?: boolean;
  video?: boolean;
}

/** Extended NRelay that accepts pre-computed analysis data on event ingestion. */
export interface AnalyzableRelay extends NRelay {
  event(
    event: NostrEvent,
    opts?: { signal?: AbortSignal; analysis?: EventAnalysis },
  ): Promise<void>;
}

/** Function that analyzes a Nostr event off the main thread (verify, detect language/sentiment). */
export type AnalyzeFn = (
  event: NostrEvent,
) => AnalyzeResult | Promise<AnalyzeResult>;

/** Default analyze function that only verifies (no language/sentiment detection). */
const defaultAnalyze: AnalyzeFn = (event) => ({
  verified: verifyEvent(event),
});

/** Lenience in seconds added to time-based checks to tolerate minor clock skew. */
const TIME_FUZZ = 60;

/**
 * Default `until` to the current time (plus optional fuzz) for a filter, so
 * future-dated events are hidden until their `created_at` arrives. Skipped
 * when the caller already provides `until`, or when `since` is in the future
 * (which signals an intentional query for future events).
 */
export function clampUntil(filter: Filter, fuzz = 0): Filter {
  if (typeof filter.until === "number") return filter;

  const now = Math.floor(Date.now() / 1000);

  if (typeof filter.since === "number" && filter.since > now) return filter;

  return { ...filter, until: now + fuzz };
}

// Track subscriptions per connection
export interface Subscription {
  id: string;
  filters: Filter[];
}

export interface WebSocketData {
  subscriptions: Map<string, Subscription>;
  /** The current AUTH challenge string for this connection. */
  challenge: string;
  /** Whether the AUTH challenge has been sent to the client. */
  challengeSent: boolean;
  /** Set of pubkeys that have been authenticated on this connection. */
  authedPubkeys: Set<string>;
}

/** A single filter entry in the subscription index. */
interface IndexedFilter {
  ws: ServerWebSocket<WebSocketData>;
  subscriptionId: string;
  filter: Filter;
}

export class Relay {
  public storage: AnalyzableRelay;
  private relayInfo: NostrRelayInfo;
  private analyze: AnalyzeFn;
  /** The relay's public URL, used for NIP-42 AUTH verification. */
  private relayUrl: string;
  /** Kinds that require AUTH for REQ/COUNT queries and are excluded from unscoped queries. */
  private authKinds: Set<number>;
  /** Maximum number of entries allowed in any single filter array field. */
  private maxFilterValues: number;

  /** All open WebSocket connections. */
  private connections = new Set<ServerWebSocket<WebSocketData>>();

  /** Kind → indexed filters for that kind. */
  private kindIndex = new Map<number, Set<IndexedFilter>>();
  /** Filters with no `kinds` constraint (must be checked against every event). */
  private catchAll = new Set<IndexedFilter>();
  /** Reverse map: ws → all IndexedFilter entries for that connection (for fast cleanup). */
  private connectionFilters = new Map<
    ServerWebSocket<WebSocketData>,
    Set<IndexedFilter>
  >();

  /** Queue of events pending broadcast, drained asynchronously with yields. */
  private broadcastQueue: NostrEvent[] = [];
  /** Whether the async drain loop is currently running. */
  private drainingBroadcasts = false;

  constructor(
    storage: AnalyzableRelay,
    opts: {
      relayInfo?: Partial<NostrRelayInfo>;
      analyze?: AnalyzeFn;
      relayUrl: string;
      authKinds?: Set<number>;
      /**
       * Maximum size (bytes) of a single WebSocket message. Advertised via
       * NIP-11 `limitation.max_message_length`. Must match the transport-layer
       * limit (`Bun.serve` `maxPayloadLength`) so the advertised value is
       * actually enforced. Default: 4_000_000 (4 MB).
       */
      maxMessageLength?: number;
      /**
       * Maximum number of entries allowed in any single filter array field
       * (`ids`, `authors`, `kinds`, or any `#<tag>`). Filters that exceed
       * this cap are rejected. Advertised via NIP-11
       * `limitation.max_filter_values`. Default: 5000.
       */
      maxFilterValues?: number;
    },
  ) {
    this.storage = storage;
    this.analyze = opts.analyze ?? defaultAnalyze;
    this.relayUrl = opts.relayUrl;
    this.authKinds = opts.authKinds ?? new Set();
    this.maxFilterValues = opts.maxFilterValues ?? 5000;
    this.relayInfo = {
      name: "Ditto Relay",
      description: "A Nostr relay backed by OpenSearch",
      supported_nips: [1, 9, 11, 40, 42, 45, 50, 62, 70],
      software: "https://gitlab.com/soapbox-pub/ditto-relay",
      version: "0.1.0",
      limitation: {
        max_message_length: opts.maxMessageLength ?? 4_000_000,
        max_subscriptions: 20,
        max_filters: 100,
        max_limit: 5000,
        max_subid_length: 100,
        max_event_tags: 2000,
        max_content_length: 102400,
        min_pow_difficulty: 0,
        auth_required: false,
        payment_required: false,
        // Non-standard: advertises per-field array cap so clients can
        // split large `authors`/`ids`/#tag filters before sending.
        max_filter_values: this.maxFilterValues,
      } as NostrRelayInfo["limitation"] & { max_filter_values: number },
      ...opts?.relayInfo,
    };
  }

  /**
   * Check if any array-valued filter field exceeds the configured cap.
   * Returns the name of the offending field, or null if all are within limits.
   */
  private exceedsFilterValueCap(filter: Filter): string | null {
    if (filter.ids && filter.ids.length > this.maxFilterValues) {
      return "ids";
    }
    if (filter.authors && filter.authors.length > this.maxFilterValues) {
      return "authors";
    }
    if (filter.kinds && filter.kinds.length > this.maxFilterValues) {
      return "kinds";
    }
    for (const [key, values] of Object.entries(filter)) {
      if (
        key.startsWith("#") &&
        Array.isArray(values) &&
        values.length > this.maxFilterValues
      ) {
        return key;
      }
    }
    return null;
  }

  getRelayInfo(): NostrRelayInfo {
    return this.relayInfo;
  }

  // Helper to send JSON message to client
  private sendMessage(ws: ServerWebSocket<WebSocketData>, message: unknown[]) {
    ws.send(JSON.stringify(message));
  }

  /**
   * Add a subscription's filters to the broadcast index.
   * Call removeFromIndex first if replacing an existing subscription.
   */
  private addToIndex(
    ws: ServerWebSocket<WebSocketData>,
    subscriptionId: string,
    filters: Filter[],
  ): void {
    let connFilters = this.connectionFilters.get(ws);
    if (!connFilters) {
      connFilters = new Set();
      this.connectionFilters.set(ws, connFilters);
    }

    for (const filter of filters) {
      const entry: IndexedFilter = { ws, subscriptionId, filter };
      connFilters.add(entry);

      if (filter.kinds && filter.kinds.length > 0) {
        for (const kind of filter.kinds) {
          let kindSet = this.kindIndex.get(kind);
          if (!kindSet) {
            kindSet = new Set();
            this.kindIndex.set(kind, kindSet);
          }
          kindSet.add(entry);
        }
      } else {
        this.catchAll.add(entry);
      }
    }
  }

  /**
   * Remove indexed filters for a connection, optionally scoped to a single subscription.
   */
  private removeFromIndex(
    ws: ServerWebSocket<WebSocketData>,
    subscriptionId?: string,
  ): void {
    const connFilters = this.connectionFilters.get(ws);
    if (!connFilters) return;

    const toRemove: IndexedFilter[] = [];
    for (const entry of connFilters) {
      if (
        subscriptionId === undefined ||
        entry.subscriptionId === subscriptionId
      ) {
        toRemove.push(entry);
      }
    }

    for (const entry of toRemove) {
      connFilters.delete(entry);

      if (entry.filter.kinds && entry.filter.kinds.length > 0) {
        for (const kind of entry.filter.kinds) {
          const kindSet = this.kindIndex.get(kind);
          if (kindSet) {
            kindSet.delete(entry);
            if (kindSet.size === 0) {
              this.kindIndex.delete(kind);
            }
          }
        }
      } else {
        this.catchAll.delete(entry);
      }
    }

    if (connFilters.size === 0) {
      this.connectionFilters.delete(ws);
    }
  }

  /**
   * Queue an event for broadcast to matching subscriptions.
   * The actual broadcast work is drained asynchronously — one event at a time
   * with `setTimeout(0)` yields between each — so pending REQ handlers can
   * interleave and avoid p95 latency spikes caused by back-to-back broadcasts.
   */
  broadcast(event: NostrEvent): void {
    this.broadcastQueue.push(event);
    if (!this.drainingBroadcasts) {
      this.drainingBroadcasts = true;
      this.drainBroadcasts();
    }
  }

  /**
   * Synchronously drain all pending broadcasts. Used in tests to verify
   * broadcast delivery without waiting for async drain.
   */
  flushBroadcasts(): void {
    while (this.broadcastQueue.length > 0) {
      const event = this.broadcastQueue.shift()!;
      this.broadcastOne(event);
    }
    this.drainingBroadcasts = false;
  }

  /**
   * Async drain loop: processes up to a budget of broadcasts per event-loop
   * tick, then yields with `setTimeout(0)` so pending REQs and other I/O
   * callbacks can execute.
   *
   * The budget is time-based: drain events until 5ms have elapsed in this
   * tick, then yield.  This balances throughput (draining many events when
   * they're cheap) against responsiveness (yielding before REQs starve).
   */
  private drainBroadcasts(): void {
    const BUDGET_MS = 5;
    const start = performance.now();
    let count = 0;

    while (this.broadcastQueue.length > 0) {
      const event = this.broadcastQueue.shift()!;
      this.broadcastOne(event);
      count++;

      // Check budget every 8 events to avoid calling performance.now() too often.
      if (count % 8 === 0 && performance.now() - start >= BUDGET_MS) {
        break;
      }
    }

    if (this.broadcastQueue.length === 0) {
      this.drainingBroadcasts = false;
      relayBroadcastQueueGauge.set(0);
      return;
    }

    relayBroadcastQueueGauge.set(this.broadcastQueue.length);
    // Yield before processing the next batch
    setTimeout(() => this.drainBroadcasts(), 0);
  }

  /**
   * Broadcast a single event to all subscriptions whose filters match.
   * Deduplicates so each (connection, subscriptionId) pair receives the event at most once,
   * even if multiple filters within the subscription match.
   */
  private broadcastOne(event: NostrEvent): void {
    // NIP-40: Don't broadcast expired events
    if (this.isExpired(event)) return;

    // Collect candidate indexed filters: kind-specific + catchAll
    const kindSet = this.kindIndex.get(event.kind);

    // Pre-serialize the event once.  The per-subscriber message is
    // `["EVENT","<subId>",<event>]` — we build it via string concatenation
    // so the expensive JSON.stringify of the event body happens only once
    // instead of once per matching subscription.
    const eventJson = JSON.stringify(event);

    // Track which (ws, subscriptionId) pairs have already been sent to.
    // Outer map uses ws reference identity, inner set is subscriptionId strings.
    const sent = new Map<ServerWebSocket<WebSocketData>, Set<string>>();

    const check = (entry: IndexedFilter) => {
      // Skip if already sent to this (ws, subId)
      const wsSent = sent.get(entry.ws);
      if (wsSent?.has(entry.subscriptionId)) return;

      // Exclude auth-protected kinds from subscriptions that didn't explicitly request them,
      // and verify the subscriber is a party to the event (author or p-tagged).
      if (this.authKinds.has(event.kind)) {
        const hasKind =
          entry.filter.kinds && entry.filter.kinds.includes(event.kind);
        if (!hasKind) return;
        if (!this.isAuthorizedForEvent(entry.ws, event)) return;
      }

      if (!matchFilter(clampUntil(entry.filter, TIME_FUZZ), event)) return;

      // Mark as sent
      if (wsSent) {
        wsSent.add(entry.subscriptionId);
      } else {
        sent.set(entry.ws, new Set([entry.subscriptionId]));
      }

      // Build the EVENT message via concatenation using the pre-serialized
      // event JSON, avoiding a full JSON.stringify per subscriber.
      entry.ws.send(
        `["EVENT",${JSON.stringify(entry.subscriptionId)},${eventJson}]`,
      );
    };

    if (kindSet) {
      for (const entry of kindSet) {
        check(entry);
      }
    }
    for (const entry of this.catchAll) {
      check(entry);
    }
  }

  /**
   * Check if an event is protected (NIP-70) by looking for the ["-"] tag.
   */
  private isProtectedEvent(event: NostrEvent): boolean {
    return event.tags.some((tag) => tag.length === 1 && tag[0] === "-");
  }

  /**
   * Check if an event has expired (NIP-40) by checking the "expiration" tag.
   * Returns true if the event has an expiration tag with a timestamp in the past.
   */
  private isExpired(event: NostrEvent): boolean {
    const expirationTag = event.tags.find(
      (tag) => tag[0] === "expiration" && tag.length >= 2,
    );
    if (!expirationTag) return false;
    const expiration = Number.parseInt(expirationTag[1], 10);
    if (Number.isNaN(expiration)) return false;
    return expiration <= Math.floor(Date.now() / 1000);
  }

  /**
   * Handle an EVENT message according to NIP-01
   */
  private async handleEventMessage(
    event: NostrEvent,
    ws: ServerWebSocket<WebSocketData>,
  ): Promise<{
    eventId: string;
    accepted: boolean;
    message: string;
  }> {
    // Analyze event off the main thread: verify signature, detect language/sentiment
    const analysis = await this.analyze(event);
    if (!analysis.verified) {
      return {
        eventId: event.id,
        accepted: false,
        message: "invalid: signature verification failed",
      };
    }

    // NIP-70: Reject protected events unless the author is authenticated
    if (this.isProtectedEvent(event)) {
      if (!this.isAuthenticated(ws, event.pubkey)) {
        // Send the AUTH challenge so the client can authenticate and retry
        this.ensureChallengeSent(ws);
        return {
          eventId: event.id,
          accepted: false,
          message:
            "auth-required: this event may only be published by its author",
        };
      }
    }

    // NIP-40: Reject events that are already expired
    if (this.isExpired(event)) {
      return {
        eventId: event.id,
        accepted: false,
        message: "invalid: event has expired",
      };
    }

    // Handle deletion events (kind 5) using NRelay's remove method
    // The deletion event itself is still stored below so it remains queryable.
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
                  // NIP-09: delete all versions up to the deletion request timestamp.
                  until: event.created_at,
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
      } catch (error) {
        console.error("Failed to process deletion event:", error);
        return {
          eventId: event.id,
          accepted: false,
          message: `error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    // Handle Request to Vanish events (kind 62, NIP-62)
    // Delete all events from the pubkey up to created_at if our relay is tagged.
    if (event.kind === 62) {
      try {
        const relayTags = event.tags
          .filter((tag) => tag[0] === "relay" && tag.length >= 2)
          .map((tag) => tag[1]);

        // NIP-62: The tag list MUST include at least one relay value.
        if (relayTags.length === 0) {
          return {
            eventId: event.id,
            accepted: false,
            message:
              "invalid: kind 62 event must include at least one relay tag",
          };
        }

        // Check if this relay is targeted (exact URL match or ALL_RELAYS)
        const isTargeted = relayTags.some(
          (url) =>
            url === "ALL_RELAYS" || this.relayUrlMatches(url, this.relayUrl),
        );

        if (isTargeted && this.storage.remove) {
          // Delete all events from this pubkey up to created_at
          await this.storage.remove([
            {
              authors: [event.pubkey],
              until: event.created_at,
            },
          ]);

          // NIP-62: Relays SHOULD delete all NIP-59 Gift Wraps (kind 1059)
          // that p-tagged the pubkey.
          await this.storage.remove([
            {
              kinds: [1059],
              "#p": [event.pubkey],
              until: event.created_at,
            },
          ]);

          console.log(`🗑️  Processed vanish request from ${event.pubkey}`);
        }
      } catch (error) {
        console.error("Failed to process vanish request:", error);
        return {
          eventId: event.id,
          accepted: false,
          message: `error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    // NIP-01: Ephemeral events (kinds 20000-29999) are not stored, only broadcast.
    // Reject future-dated ephemeral events since they will never be delivered:
    // they aren't stored, so they can't be queried later when the time arrives.
    if (NKinds.ephemeral(event.kind)) {
      const now = Math.floor(Date.now() / 1000);
      if (event.created_at > now + TIME_FUZZ) {
        return {
          eventId: event.id,
          accepted: false,
          message: "invalid: ephemeral event is in the future",
        };
      }
      return {
        eventId: event.id,
        accepted: true,
        message: "",
      };
    }

    // Store the event, passing pre-computed analysis results to avoid
    // redundant detection on the main thread.
    try {
      const eventOpts = {
        analysis: {
          search_text: analysis.search_text,
          language: analysis.language,
          sentiment: analysis.sentiment,
          media: analysis.media,
          video: analysis.video,
        },
      };
      await this.storage.event(event, eventOpts);
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
   * Check whether filters involving auth-protected kinds are allowed on this connection.
   *
   * Rules:
   * 1. If a filter's `kinds` includes any auth kind, the filter MUST also have
   *    `authors` or `#p` where ALL entries are authenticated pubkeys.
   *    - If `authors`/`#p` are both absent and client is unauthenticated →
   *      CLOSED with "auth-required" and send the AUTH challenge.
   *    - If `authors`/`#p` are both absent and client is authenticated →
   *      CLOSED with "restricted".
   *    - If present but contain unauthenticated pubkeys → CLOSED with
   *      "auth-required" and send the AUTH challenge.
   * 2. Filters without explicit `kinds` (catch-all) pass through; the storage
   *    backend is responsible for excluding auth-protected kinds.
   * 3. Filters with explicit `kinds` that don't include any auth kind pass through.
   *
   * Returns the validated filters on success, or an error object.
   */
  private checkAuthKinds(
    ws: ServerWebSocket<WebSocketData>,
    subscriptionId: string,
    filters: Filter[],
  ):
    | { ok: true; filters: Filter[] }
    | { ok: false; error: { subscriptionId: string; message: string } } {
    if (this.authKinds.size === 0) {
      return { ok: true, filters };
    }

    const result: Filter[] = [];

    for (const filter of filters) {
      const hasExplicitKinds =
        Array.isArray(filter.kinds) && filter.kinds.length > 0;

      if (!hasExplicitKinds) {
        // Catch-all or no kinds specified: exclude auth kinds silently.
        result.push(filter);
        continue;
      }

      // Check if any requested kind is an auth kind.
      const hasAuthKind = filter.kinds!.some((k) => this.authKinds.has(k));

      if (!hasAuthKind) {
        // No auth kinds in this filter — pass through.
        result.push(filter);
        continue;
      }

      // Filter contains auth kind(s). Check authors / #p.
      const authors: string[] | undefined = filter.authors;
      const pTags: string[] | undefined = filter["#p"];

      if (
        (!authors || authors.length === 0) &&
        (!pTags || pTags.length === 0)
      ) {
        // No authors and no #p. If the client hasn't authenticated at all,
        // send a challenge and use auth-required. If they have, use restricted.
        const authed = ws.data.authedPubkeys;
        if (authed.size === 0) {
          this.ensureChallengeSent(ws);
          return {
            ok: false,
            error: {
              subscriptionId,
              message:
                "auth-required: auth-protected kinds require an authors or #p filter",
            },
          };
        }
        return {
          ok: false,
          error: {
            subscriptionId,
            message:
              "restricted: auth-protected kinds require an authors or #p filter",
          },
        };
      }

      // At least one of authors / #p is present.
      // ALL entries in whichever is provided must be auth'd pubkeys.
      const authed = ws.data.authedPubkeys;

      if (authors && authors.length > 0) {
        const allAuthed = authors.every((pk) => authed.has(pk));
        if (!allAuthed) {
          this.ensureChallengeSent(ws);
          return {
            ok: false,
            error: {
              subscriptionId,
              message: "auth-required: all authors must be authenticated",
            },
          };
        }
      }

      if (pTags && pTags.length > 0) {
        const allAuthed = pTags.every((pk) => authed.has(pk));
        if (!allAuthed) {
          this.ensureChallengeSent(ws);
          return {
            ok: false,
            error: {
              subscriptionId,
              message: "auth-required: all #p tags must be authenticated",
            },
          };
        }
      }

      // Passed auth checks — include filter.
      result.push(filter);
    }

    return { ok: true, filters: result };
  }

  /**
   * Check whether the connection is authorized to see the given auth-kind event.
   * Returns true if the connection has an authenticated pubkey that is either
   * the event's author or listed in a `p` tag.
   */
  private isAuthorizedForEvent(
    ws: ServerWebSocket<WebSocketData>,
    event: NostrEvent,
  ): boolean {
    const authed = ws.data.authedPubkeys;
    if (authed.has(event.pubkey)) return true;
    for (const tag of event.tags) {
      if (tag[0] === "p" && tag[1] && authed.has(tag[1])) return true;
    }
    return false;
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

      const result = await this.storage.count(
        filters.map((f) => clampUntil(f)),
      );
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
      const events = await this.storage.query(
        filters.map((f) => clampUntil(f)),
      );
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
    relayEventsCounter.inc({ kind: event.kind });
    try {
      const result = await this.handleEventMessage(event, ws);
      this.sendMessage(ws, [
        "OK",
        result.eventId,
        result.accepted,
        result.message,
      ]);

      // Broadcast to all matching subscriptions
      if (result.accepted) {
        this.broadcast(event);
      }
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
    const endReqTimer = relayReqDurationHistogram.startTimer();
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

      // Guard auth-protected kinds
      const authCheck = this.checkAuthKinds(ws, subscriptionId, filters);
      if (!authCheck.ok) {
        this.sendMessage(ws, [
          "CLOSED",
          authCheck.error.subscriptionId,
          authCheck.error.message,
        ]);
        return;
      }
      filters = authCheck.filters;

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

      // Check if any returned events are auth-kind events the client can't see.
      // If so, reject the entire request — don't send partial results.
      if (
        result.events.some(
          (e) =>
            this.authKinds.has(e.kind) && !this.isAuthorizedForEvent(ws, e),
        )
      ) {
        this.ensureChallengeSent(ws);
        this.sendMessage(ws, [
          "CLOSED",
          subscriptionId,
          "auth-required: some results require authentication",
        ]);
        return;
      }

      // Store subscription (remove old one first if replacing)
      this.removeFromIndex(ws, subscriptionId);
      data.subscriptions.set(subscriptionId, { id: subscriptionId, filters });
      this.addToIndex(ws, subscriptionId, filters);

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
    } finally {
      endReqTimer();
    }
  }

  // Handle COUNT message
  async handleCount(
    ws: ServerWebSocket<WebSocketData>,
    subscriptionId: string,
    filters: Filter[],
  ) {
    try {
      // Guard auth-protected kinds
      const authCheck = this.checkAuthKinds(ws, subscriptionId, filters);
      if (!authCheck.ok) {
        this.sendMessage(ws, [
          "CLOSED",
          authCheck.error.subscriptionId,
          authCheck.error.message,
        ]);
        return;
      }
      filters = authCheck.filters;

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
    this.removeFromIndex(ws, subscriptionId);
  }

  /** Generate a random challenge string for NIP-42 AUTH. */
  private generateChallenge(): string {
    return randomBytes(32).toString("hex");
  }

  /** Send the AUTH challenge to the client if it hasn't been sent yet. */
  private ensureChallengeSent(ws: ServerWebSocket<WebSocketData>): void {
    if (!ws.data.challengeSent) {
      this.sendMessage(ws, ["AUTH", ws.data.challenge]);
      ws.data.challengeSent = true;
    }
  }

  /**
   * Compare two relay URLs, tolerating a missing trailing slash
   * when the path is the root `/`.
   */
  private relayUrlMatches(url: string, expected: string): boolean {
    if (url === expected) return true;
    // "wss://host" and "wss://host/" both represent the root path.
    // Only tolerate this when the shorter URL has no path at all
    // (no `/` after the authority), meaning the `/` is the root path.
    const shorter = url.length < expected.length ? url : expected;
    const longer = url.length < expected.length ? expected : url;
    if (longer !== `${shorter}/`) return false;
    // Ensure the shorter form has no path component (just scheme + authority).
    const afterScheme = shorter.indexOf("://");
    if (afterScheme === -1) return false;
    return !shorter.includes("/", afterScheme + 3);
  }

  /**
   * Check if a pubkey is authenticated on this connection.
   */
  isAuthenticated(ws: ServerWebSocket<WebSocketData>, pubkey: string): boolean {
    return ws.data.authedPubkeys.has(pubkey);
  }

  /**
   * Handle an AUTH message from a client (NIP-42).
   * Validates the kind 22242 event and marks the pubkey as authenticated.
   */
  async handleAuth(
    ws: ServerWebSocket<WebSocketData>,
    event: NostrEvent,
  ): Promise<void> {
    // Verify signature (AUTH events don't need language/sentiment analysis)
    const { verified } = await this.analyze(event);
    if (!verified) {
      this.sendMessage(ws, [
        "OK",
        event.id,
        false,
        "invalid: signature verification failed",
      ]);
      return;
    }

    // Must be kind 22242
    if (event.kind !== 22242) {
      this.sendMessage(ws, [
        "OK",
        event.id,
        false,
        "invalid: AUTH event must be kind 22242",
      ]);
      return;
    }

    // Check created_at is within ~10 minutes
    const now = Math.floor(Date.now() / 1000);
    const timeDiff = Math.abs(now - event.created_at);
    if (timeDiff > 600) {
      this.sendMessage(ws, [
        "OK",
        event.id,
        false,
        "invalid: AUTH event timestamp is too far from current time",
      ]);
      return;
    }

    // Check challenge tag matches
    const challengeTag = event.tags.find((t) => t[0] === "challenge");
    if (!challengeTag || challengeTag[1] !== ws.data.challenge) {
      this.sendMessage(ws, [
        "OK",
        event.id,
        false,
        "invalid: AUTH challenge does not match",
      ]);
      return;
    }

    // Check relay tag - if we have a configured relay URL, verify it matches exactly
    const relayTag = event.tags.find((t) => t[0] === "relay");
    if (!relayTag || !relayTag[1]) {
      this.sendMessage(ws, [
        "OK",
        event.id,
        false,
        "invalid: AUTH event missing relay tag",
      ]);
      return;
    }

    if (!this.relayUrlMatches(relayTag[1], this.relayUrl)) {
      this.sendMessage(ws, [
        "OK",
        event.id,
        false,
        "invalid: AUTH relay URL does not match",
      ]);
      return;
    }

    // Authentication successful - add this pubkey to the authenticated set
    ws.data.authedPubkeys.add(event.pubkey);

    this.sendMessage(ws, ["OK", event.id, true, ""]);
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
          relayMessagesCounter.inc({ verb: "EVENT" });
          if (params.length !== 1) {
            this.sendMessage(ws, [
              "NOTICE",
              "invalid: EVENT message must have exactly 1 parameter",
            ]);
            return;
          }
          {
            // Schema-validate the event object before touching any of its
            // fields on the main thread. This strips unknown keys (including
            // __proto__ payloads), ensures correct types, and front-loads
            // rejection so malformed events never reach the verify worker.
            const parsed = n.event().safeParse(params[0]);
            if (!parsed.success) {
              // If the caller sent a 64-hex `id`, reply OK/false so conforming
              // clients get per-event feedback; otherwise fall back to NOTICE.
              const raw = params[0] as { id?: unknown };
              const id =
                typeof raw?.id === "string" && /^[0-9a-f]{64}$/.test(raw.id)
                  ? raw.id
                  : undefined;
              const reason = "invalid: event failed schema validation";
              if (id) {
                this.sendMessage(ws, ["OK", id, false, reason]);
              } else {
                this.sendMessage(ws, ["NOTICE", reason]);
              }
              return;
            }
            await this.handleEvent(ws, parsed.data);
          }
          break;

        case "REQ": {
          relayMessagesCounter.inc({ verb: "REQ" });
          if (params.length < 2) {
            this.sendMessage(ws, [
              "NOTICE",
              "invalid: REQ message must have subscription ID and at least 1 filter",
            ]);
            return;
          }
          const [subId, ...rawFilters] = params;
          // Validate filter shapes: enforces numeric kinds, 64-hex ids/authors,
          // nonneg since/until/limit, array shapes on #tags. Unknown top-level
          // keys are stripped by NSchema.filter()'s transform.
          const parsedFilters: Filter[] = [];
          for (const raw of rawFilters) {
            const parsed = n.filter().safeParse(raw);
            if (!parsed.success) {
              this.sendMessage(ws, [
                "CLOSED",
                typeof subId === "string" ? subId : "",
                "invalid: filter failed schema validation",
              ]);
              return;
            }
            const filter = parsed.data as Filter;
            const over = this.exceedsFilterValueCap(filter);
            if (over !== null) {
              this.sendMessage(ws, [
                "CLOSED",
                typeof subId === "string" ? subId : "",
                `invalid: filter field "${over}" exceeds max_filter_values (${this.maxFilterValues})`,
              ]);
              return;
            }
            parsedFilters.push(filter);
          }
          await this.handleReq(ws, subId as string, parsedFilters);
          break;
        }

        case "COUNT": {
          relayMessagesCounter.inc({ verb: "COUNT" });
          if (params.length < 2) {
            this.sendMessage(ws, [
              "NOTICE",
              "invalid: COUNT message must have subscription ID and at least 1 filter",
            ]);
            return;
          }
          const [countSubId, ...rawCountFilters] = params;
          const parsedCountFilters: Filter[] = [];
          for (const raw of rawCountFilters) {
            const parsed = n.filter().safeParse(raw);
            if (!parsed.success) {
              this.sendMessage(ws, [
                "CLOSED",
                typeof countSubId === "string" ? countSubId : "",
                "invalid: filter failed schema validation",
              ]);
              return;
            }
            const filter = parsed.data as Filter;
            const over = this.exceedsFilterValueCap(filter);
            if (over !== null) {
              this.sendMessage(ws, [
                "CLOSED",
                typeof countSubId === "string" ? countSubId : "",
                `invalid: filter field "${over}" exceeds max_filter_values (${this.maxFilterValues})`,
              ]);
              return;
            }
            parsedCountFilters.push(filter);
          }
          await this.handleCount(ws, countSubId as string, parsedCountFilters);
          break;
        }

        case "AUTH":
          relayMessagesCounter.inc({ verb: "AUTH" });
          if (params.length !== 1) {
            this.sendMessage(ws, [
              "NOTICE",
              "invalid: AUTH message must have exactly 1 parameter",
            ]);
            return;
          }
          {
            // Same structural validation as EVENT. AUTH has no OK-style
            // response, so rejections always go back as NOTICE.
            const parsed = n.event().safeParse(params[0]);
            if (!parsed.success) {
              this.sendMessage(ws, [
                "NOTICE",
                "invalid: AUTH event failed schema validation",
              ]);
              return;
            }
            await this.handleAuth(ws, parsed.data);
          }
          break;

        case "CLOSE":
          relayMessagesCounter.inc({ verb: "CLOSE" });
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
  handleOpen(ws: ServerWebSocket<WebSocketData>) {
    this.connections.add(ws);
    relayConnectionsGauge.set(this.connections.size);
    // Generate NIP-42 AUTH challenge (sent lazily when needed)
    ws.data.challenge = this.generateChallenge();
    console.log("WebSocket connection opened");
  }

  // Handle WebSocket close
  handleCloseConnection(ws: ServerWebSocket<WebSocketData>) {
    console.log("WebSocket connection closed");
    this.connections.delete(ws);
    relayConnectionsGauge.set(this.connections.size);
    this.removeFromIndex(ws);
    ws.data?.subscriptions.clear();
  }
}
