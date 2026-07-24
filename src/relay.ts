import type { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import type { NostrRelayInfo, NRelay } from "@nostrify/nostrify";
import { NKinds, NSchema as n } from "@nostrify/nostrify";
import type { Filter, NostrEvent } from "nostr-tools";
import { matchFilter, verifyEvent } from "nostr-tools";

import type { AnalyzeResult } from "./analyze.ts";
import { StorageOverloaded } from "./errors.ts";
import { clip, errFields, Logger } from "./log.ts";
import {
  relayBroadcastQueueGauge,
  relayConnectionsGauge,
  relayEventsCounter,
  relayMessagesCounter,
  relayNegentropySessionsGauge,
  relayOverloadCounter,
  relayReqDurationHistogram,
  reqEventsReturnedHistogram,
} from "./metrics.ts";
import {
  bytesToHex,
  hexToBytes,
  Negentropy,
  NegentropyStorageVector,
} from "./negentropy.ts";

/**
 * Cached zod schemas. NSchema.event() and NSchema.filter() construct a fresh
 * z.object each call; on a hot ingest path that adds up. Build once, reuse.
 */
const EVENT_SCHEMA = n.event();
const FILTER_SCHEMA = n.filter();

/**
 * Yield the event loop so pending I/O callbacks (e.g. an OpenSearch search
 * response that a REQ is awaiting) and timer callbacks (e.g. the broadcast
 * drain's `setTimeout(0)`) can run before we continue. `setImmediate` is the
 * right primitive here: it fires after I/O callbacks in the same tick and
 * before the next round of microtasks, which is exactly what we want to give
 * REQs and broadcasts a chance to interleave with EVENT-handler
 * continuations.
 */
function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Simple counting semaphore. Used per-connection to bound the number of
 * `handleEvent` Promises in flight for a single client. A Bluesky-bridge-
 * style client that fires 5000 events through one socket in a single tick
 * would otherwise queue 5000 microtask continuations after `await
 * analyze()`; those continuations run ahead of any timer/I/O callback,
 * starving REQs and the broadcast drain. Gating EVENT dispatch behind a
 * semaphore turns that unbounded fan-out into a bounded one without
 * dropping events.
 */
class Semaphore {
  private available: number;
  private queue: Array<() => void> = [];

  constructor(capacity: number) {
    this.available = capacity;
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      // Hand the slot directly to the next waiter without bumping the
      // counter — the slot was never returned to the pool.
      next();
    } else {
      this.available++;
    }
  }

  /** Current number of waiters (does not include holders). */
  get waiting(): number {
    return this.queue.length;
  }
}

/** Pre-computed analysis data that can be passed alongside an event to avoid redundant work. */
export interface EventAnalysis {
  search_text?: string;
  autocomplete_text?: string;
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
  /**
   * Query events. When `includeAuthKinds` is set, auth-protected kinds are
   * NOT stripped from catch-all (no explicit `kinds`) filters. Used to serve
   * master pubkeys, which have unconditional read access to all auth kinds.
   */
  query(
    filters: Filter[],
    opts?: { signal?: AbortSignal; includeAuthKinds?: boolean },
  ): Promise<NostrEvent[]>;
  /** Count events, with the same `includeAuthKinds` visibility override as {@link query}. */
  count?(
    filters: Filter[],
    opts?: { signal?: AbortSignal; includeAuthKinds?: boolean },
  ): Promise<{ count: number; approximate?: boolean }>;
}

/**
 * Optional storage capability required for NIP-77 Negentropy sync: fetch the
 * `(created_at, id)` pairs of events matching a filter, sorted ascending by
 * `created_at` with ties broken by `id` bytes ascending. A NIP-01 `limit`
 * on the filter bounds the set to the N newest matching events (still
 * returned in ascending order), matching strfry's NIP-77 semantics.
 */
export interface SyncableStorage {
  queryItems(
    filter: Filter,
    opts?: {
      maxItems?: number;
      signal?: AbortSignal;
      includeAuthKinds?: boolean;
    },
  ): Promise<Array<{ created_at: number; id: string }>>;
}

/** Runtime check for the {@link SyncableStorage} capability. */
function isSyncable(storage: unknown): storage is SyncableStorage {
  return (
    typeof (storage as { queryItems?: unknown })?.queryItems === "function"
  );
}

/** Function that analyzes a Nostr event (verify, detect language/sentiment). */
export type AnalyzeFn = (
  event: NostrEvent,
  opts?: { verifyOnly?: boolean },
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

/** A stateful NIP-77 Negentropy sync session (one per NEG-OPEN subscription). */
interface NegentropySession {
  neg: Negentropy;
  /** `Date.now()` of the last NEG-OPEN/NEG-MSG activity, for idle timeout. */
  lastActive: number;
}

export interface ConnData {
  subscriptions: Map<string, Subscription>;
  /** The current AUTH challenge string for this connection. */
  challenge: string;
  /** Whether the AUTH challenge has been sent to the client. */
  challengeSent: boolean;
  /** Set of pubkeys that have been authenticated on this connection. */
  authedPubkeys: Set<string>;
  /** Client IP from CF-Connecting-IP / X-Forwarded-For at upgrade time. */
  ip?: string;
  /** Client User-Agent header at upgrade time. */
  userAgent?: string;
  /** `Date.now()` when the connection opened (set in handleOpen). */
  openedAt?: number;
  /** Messages received on this connection (all verbs). */
  messageCount?: number;
  /** REQ messages received on this connection. */
  reqCount?: number;
  /** EVENT messages received on this connection. */
  eventCount?: number;
}

/**
 * Transport-agnostic handle for one client connection.
 *
 * The Relay never touches the WebSocket directly — it only reads/writes
 * per-connection protocol state via {@link ConnData} and emits finished
 * NIP-01 frames (already-serialized JSON strings) through {@link send}.
 * This is the seam that lets the protocol layer run either in-process
 * (send = `ws.send`) or inside a worker (send = postMessage back to the
 * socket-owning thread), and it is why every frame the Relay produces is
 * a string: strings cross thread boundaries as flat copies.
 */
export interface RelayConn {
  /**
   * Stable identifier for this connection, unique for the lifetime of the
   * process. Used to route frames back to the owning socket when the
   * protocol layer runs in a worker.
   */
  readonly id: number;
  /** Per-connection protocol state, owned by the protocol layer. */
  data: ConnData;
  /** Deliver one finished NIP-01 frame (serialized JSON array) to the client. */
  send(frame: string): void;
}

/** Create a fresh {@link ConnData} for a new connection. */
export function createConnData(init?: {
  ip?: string;
  userAgent?: string;
}): ConnData {
  return {
    subscriptions: new Map(),
    challenge: "",
    challengeSent: false,
    authedPubkeys: new Set(),
    ip: init?.ip,
    userAgent: init?.userAgent,
  };
}

/** A single filter entry in the subscription index. */
interface IndexedFilter {
  ws: RelayConn;
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
  /**
   * Pubkeys with unconditional read access to auth-protected kinds. A
   * connection authenticated as any of these bypasses all auth-kind gating.
   */
  private masterPubkeys: Set<string>;
  /** Maximum number of entries allowed in any single filter array field. */
  private maxFilterValues: number;
  /** Lowercased `t` tag values that cause an event to be rejected at ingestion. */
  private bannedHashtags: Set<string>;
  /** Kind numbers that are rejected at ingestion regardless of other policy. */
  private rejectedKinds: Set<number>;
  /** Structured logger, injected by the server entry point. */
  private log: Logger;
  /**
   * Called once for every locally-accepted EVENT (including ephemeral
   * events), after it has been queued for local broadcast. When the Relay
   * runs inside a protocol worker this is the fan-out hook: the worker
   * forwards accepted events to its siblings (via the main thread) so their
   * connections' subscriptions are matched too. Events arriving *from*
   * siblings go through {@link broadcast} directly and do not re-trigger
   * this hook, so fan-out cannot loop.
   */
  private onEventAccepted?: (event: NostrEvent) => void;

  /** All open WebSocket connections. */
  private connections = new Set<RelayConn>();

  /** Kind → indexed filters for that kind. */
  private kindIndex = new Map<number, Set<IndexedFilter>>();
  /** Filters with no `kinds` constraint (must be checked against every event). */
  private catchAll = new Set<IndexedFilter>();
  /** Reverse map: ws → all IndexedFilter entries for that connection (for fast cleanup). */
  private connectionFilters = new Map<RelayConn, Set<IndexedFilter>>();

  /** Queue of events pending broadcast, drained asynchronously with yields. */
  private broadcastQueue: NostrEvent[] = [];
  /** Whether the async drain loop is currently running. */
  private drainingBroadcasts = false;

  /**
   * Per-connection cap on concurrent `handleEvent` continuations. Bun's WS
   * `message()` callback fires events into `handleMessage` without awaiting,
   * so a single client (e.g. a Bluesky bridge) could otherwise enqueue
   * thousands of in-flight Promises whose post-`await analyze()`
   * continuations run as microtasks ahead of any I/O callback — starving
   * REQ HTTP responses and timer-based work (broadcast drain) on the main
   * thread. Gating EVENT dispatch behind a per-connection semaphore turns
   * that unbounded fan-out into a bounded one without dropping events.
   */
  private maxInflightPerConn: number;
  private connectionInflight = new WeakMap<RelayConn, Semaphore>();

  /**
   * NIP-77 Negentropy sync sessions, keyed by connection then subscription
   * ID. Each session holds a sealed in-memory vector of `(created_at, id)`
   * records (~40 bytes per record), so the per-session record count is
   * capped by {@link negentropyMaxRecords} and stale sessions are evicted
   * by an idle sweep.
   */
  private negSessions = new Map<RelayConn, Map<string, NegentropySession>>();
  /** Total active Negentropy sessions across all connections. */
  private negSessionCount = 0;
  /** Idle-sweep timer, running only while sessions exist. */
  private negSweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Maximum records a single NEG-OPEN may materialize. */
  private negentropyMaxRecords: number;

  /** Maximum total Negentropy sessions across all connections. */
  private static NEG_MAX_SESSIONS = 64;
  /** Sessions idle longer than this are closed with `NEG-ERR closed:`. */
  private static NEG_IDLE_TIMEOUT_MS = 5 * 60_000;
  /** How often the idle sweep runs while sessions exist. */
  private static NEG_SWEEP_INTERVAL_MS = 60_000;
  /**
   * Maximum size (bytes) of a binary Negentropy message produced by the
   * relay. Hex encoding doubles this on the wire, keeping NEG-MSG frames
   * well under the 4 MB default max_message_length.
   */
  private static NEG_FRAME_SIZE_LIMIT = 60_000;

  /**
   * Chunk size for the REQ EOSE send loop. Yields the event loop every
   * this-many events so a large REQ (up to `max_limit`) doesn't pin
   * the main thread for tens of milliseconds.
   */
  private static REQ_SEND_CHUNK = 50;

  constructor(
    storage: AnalyzableRelay,
    opts: {
      relayInfo?: Partial<NostrRelayInfo>;
      analyze?: AnalyzeFn;
      relayUrl: string;
      authKinds?: Set<number>;
      /**
       * Pubkeys granted unconditional read access to auth-protected kinds.
       * A connection authenticated (NIP-42) as any of these bypasses all
       * auth-kind gating on REQ/COUNT/NEG-OPEN and live subscriptions.
       * Default: empty.
       */
      masterPubkeys?: Set<string>;
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
      /**
       * Maximum number of events returned for a single REQ filter. Advertised
       * via NIP-11 `limitation.max_limit`. Must match the storage layer's
       * clamp so the advertised value is actually enforced. Default: 1000.
       */
      maxLimit?: number;
      /**
       * Maximum number of tags on a single event that the indexer will fully
       * project into `tags_map`. Only advertised via NIP-11
       * `limitation.max_event_tags` — events exceeding this are still
       * accepted and stored verbatim, but per-tag-name values beyond this
       * count are dropped from the searchable projection. Should match the
       * storage layer's `tagValueMaxCountPerName`. Default: 5000.
       */
      maxEventTags?: number;
      /**
       * Maximum number of in-flight `handleEvent` Promises per connection.
       * EVENT messages over the cap wait their turn via a per-connection
       * semaphore. Prevents one firehose client from flooding the main
       * thread's microtask queue and starving REQs from other connections.
       * Default: 32.
       */
      maxInflightPerConn?: number;
      /**
       * Set of lowercased `t` tag values that cause an event to be rejected at
       * ingestion. Matching is case-insensitive. Default: empty (none banned).
       */
      bannedHashtags?: Set<string>;
      /**
       * Set of kind numbers that are rejected at ingestion regardless of any
       * other policy. Events matching these kinds get an `OK: false` reply
       * with a `blocked:` message and are never stored. Default: empty.
       */
      rejectedKinds?: Set<number>;
      /**
       * Maximum number of records a single NIP-77 NEG-OPEN may materialize.
       * Larger queries are rejected with `NEG-ERR blocked:` (the cap is
       * included as the message's 4th element per NIP-77). Default: 1_000_000.
       */
      negentropyMaxRecords?: number;
      /**
       * Structured logger. Defaults to a fresh `info`-level Logger; the
       * server entry point injects one built from `Config.logLevel`.
       */
      logger?: Logger;
      /**
       * Hook invoked once per locally-accepted EVENT after it is queued for
       * local broadcast. Used by protocol workers to fan accepted events out
       * to sibling workers. See the field doc on {@link Relay.onEventAccepted}.
       */
      onEventAccepted?: (event: NostrEvent) => void;
    },
  ) {
    this.storage = storage;
    this.log = opts.logger ?? new Logger();
    this.onEventAccepted = opts.onEventAccepted;
    this.analyze = opts.analyze ?? defaultAnalyze;
    this.relayUrl = opts.relayUrl;
    this.authKinds = opts.authKinds ?? new Set();
    this.masterPubkeys = opts.masterPubkeys ?? new Set();
    this.maxFilterValues = opts.maxFilterValues ?? 5000;
    this.maxInflightPerConn = opts.maxInflightPerConn ?? 32;
    this.bannedHashtags = opts.bannedHashtags ?? new Set();
    this.rejectedKinds = opts.rejectedKinds ?? new Set();
    this.negentropyMaxRecords = opts.negentropyMaxRecords ?? 1_000_000;
    this.relayInfo = {
      name: "Ditto Relay",
      description: "A Nostr relay backed by OpenSearch",
      supported_nips: [1, 9, 11, 13, 40, 42, 45, 50, 62, 70, 77],
      software: "https://gitlab.com/soapbox-pub/ditto-relay",
      version: "0.1.0",
      limitation: {
        max_message_length: opts.maxMessageLength ?? 4_000_000,
        max_subscriptions: 20,
        max_filters: 100,
        max_limit: opts.maxLimit ?? 1000,
        max_subid_length: 100,
        max_event_tags: opts.maxEventTags ?? 5000,
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
  private sendMessage(ws: RelayConn, message: unknown[]) {
    ws.send(JSON.stringify(message));
  }

  /**
   * Add a subscription's filters to the broadcast index.
   * Call removeFromIndex first if replacing an existing subscription.
   */
  private addToIndex(
    ws: RelayConn,
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
  private removeFromIndex(ws: RelayConn, subscriptionId?: string): void {
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
      const event = this.broadcastQueue.shift();
      if (event === undefined) break;
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
      const event = this.broadcastQueue.shift();
      if (event === undefined) break;
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
    const sent = new Map<RelayConn, Set<string>>();

    const check = (entry: IndexedFilter) => {
      // Skip if already sent to this (ws, subId)
      const wsSent = sent.get(entry.ws);
      if (wsSent?.has(entry.subscriptionId)) return;

      // Exclude auth-protected kinds from subscriptions that didn't explicitly request them,
      // and verify the subscriber is a party to the event (author or p-tagged).
      // Master-authed connections bypass both checks — they receive every
      // auth-kind event, including via catch-all subscriptions.
      if (this.authKinds.has(event.kind) && !this.isMaster(entry.ws)) {
        const hasKind = entry.filter.kinds?.includes(event.kind);
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
   * Check if an event contains any banned hashtag (NIP-12 `t` tag).
   * Matching is case-insensitive. Returns false when no hashtags are banned.
   */
  private hasBannedHashtag(event: NostrEvent): boolean {
    if (this.bannedHashtags.size === 0) return false;
    return event.tags.some(
      (tag) =>
        tag[0] === "t" &&
        tag.length >= 2 &&
        this.bannedHashtags.has(tag[1].toLowerCase()),
    );
  }

  /**
   * Handle an EVENT message according to NIP-01
   */
  private async handleEventMessage(
    event: NostrEvent,
    ws: RelayConn,
  ): Promise<{
    eventId: string;
    accepted: boolean;
    message: string;
  }> {
    // Verify signature + derive language/sentiment/media. Runs inline on the
    // protocol worker (createAnalyzer), so this is CPU-bound local work.
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

    // Reject events whose kind is on the relay's rejected-kinds list.
    // NIP-59 seals (kind 13) are rejected by default: they are never meant
    // to be published on their own, only wrapped inside a gift wrap.
    if (this.rejectedKinds.has(event.kind)) {
      return {
        eventId: event.id,
        accepted: false,
        message: `blocked: kind ${event.kind} is not accepted by this relay`,
      };
    }

    // Reject events containing a banned hashtag (relay policy)
    if (this.hasBannedHashtag(event)) {
      return {
        eventId: event.id,
        accepted: false,
        message: "blocked: event contains a banned hashtag",
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

        // Resolve e-tagged events and authorize each deletion in code. A
        // single id-keyed query covers both cases: the deleter's own events
        // (regular NIP-09 deletion) and gift wraps addressed to the deleter.
        if (eTagValues.length > 0) {
          const matched = await this.storage.query([{ ids: eTagValues }]);
          const deletableIds = matched
            .filter((e) => {
              // NIP-59: A gift wrap (kind 1059) may only be deleted by the
              // p-tagged recipient — never by its author/signer (which may now
              // be a deterministic conversation key, see
              // nostr-protocol/nips#2396) nor by the shared key.
              if (e.kind === 1059) {
                return e.tags.some(
                  (tag) => tag[0] === "p" && tag[1] === event.pubkey,
                );
              }
              // NIP-09: every other kind may only be deleted by its author.
              return e.pubkey === event.pubkey;
            })
            .map((e) => e.id);

          if (deletableIds.length > 0) {
            filters.push({ ids: deletableIds });
          }
        }

        // Add addressable event filters
        filters.push(...aTagFilters);

        // Remove matching events
        if (filters.length > 0 && this.storage.remove) {
          await this.storage.remove(filters);
        }
      } catch (error) {
        this.log.error("deletion_failed", {
          id: event.id,
          ...errFields(error),
        });
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

          this.log.info("vanish_request", { pubkey: event.pubkey });
        }
      } catch (error) {
        this.log.error("vanish_failed", { id: event.id, ...errFields(error) });
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
          autocomplete_text: analysis.autocomplete_text,
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
      if (error instanceof StorageOverloaded) {
        relayOverloadCounter.inc({ source: "storage" });
        return {
          eventId: event.id,
          accepted: false,
          message: "error: relay overloaded, try again",
        };
      }
      this.log.error("store_failed", {
        id: event.id,
        kind: event.kind,
        ...errFields(error),
      });
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
   *    `authors` or `#p`, and ALL entries of at least ONE of those lists must
   *    be authenticated pubkeys. The filter is a conjunction — every matching
   *    event is authored by one of `authors` AND p-tags one of `#p` — so being
   *    authenticated as every listed author OR every listed recipient covers
   *    all possible results. This also permits the classic conversation-scoped
   *    DM query, eg `{kinds:[4], authors:[me], "#p":[them]}`.
   *    - If `authors`/`#p` are both absent and client is unauthenticated →
   *      CLOSED with "auth-required" and send the AUTH challenge.
   *    - If `authors`/`#p` are both absent and client is authenticated →
   *      CLOSED with "restricted".
   *    - If neither list is fully authenticated → CLOSED with "auth-required"
   *      and send the AUTH challenge.
   * 2. Filters without explicit `kinds` (catch-all) pass through; the storage
   *    backend is responsible for excluding auth-protected kinds.
   * 3. Filters with explicit `kinds` that don't include any auth kind pass through.
   *
   * Returns the validated filters on success, or an error object.
   */
  private checkAuthKinds(
    ws: RelayConn,
    subscriptionId: string,
    filters: Filter[],
  ):
    | { ok: true; filters: Filter[] }
    | { ok: false; error: { subscriptionId: string; message: string } } {
    if (this.authKinds.size === 0) {
      return { ok: true, filters };
    }

    // Master pubkeys have unconditional read access to all auth kinds; skip
    // every per-filter auth check.
    if (this.isMaster(ws)) {
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
      const hasAuthKind = filter.kinds?.some((k) => this.authKinds.has(k));

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

      // At least one of authors / #p is present. The filter is a conjunction,
      // so authenticating as ALL entries of EITHER list is sufficient to see
      // anything the filter can match.
      const authed = ws.data.authedPubkeys;

      const authorsAuthed =
        authors !== undefined &&
        authors.length > 0 &&
        authors.every((pk) => authed.has(pk));
      const pTagsAuthed =
        pTags !== undefined &&
        pTags.length > 0 &&
        pTags.every((pk) => authed.has(pk));

      if (!authorsAuthed && !pTagsAuthed) {
        this.ensureChallengeSent(ws);
        return {
          ok: false,
          error: {
            subscriptionId,
            message:
              "auth-required: all authors or all #p tags must be authenticated",
          },
        };
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
  private isAuthorizedForEvent(ws: RelayConn, event: NostrEvent): boolean {
    if (this.isMaster(ws)) return true;
    const authed = ws.data.authedPubkeys;
    if (authed.has(event.pubkey)) return true;
    for (const tag of event.tags) {
      if (tag[0] === "p" && tag[1] && authed.has(tag[1])) return true;
    }
    return false;
  }

  /**
   * Whether the connection has authenticated (NIP-42) as a configured master
   * pubkey. Master connections have unconditional read access to every user's
   * auth-protected events and bypass all auth-kind gating.
   */
  private isMaster(ws: RelayConn): boolean {
    if (this.masterPubkeys.size === 0) return false;
    for (const pk of ws.data.authedPubkeys) {
      if (this.masterPubkeys.has(pk)) return true;
    }
    return false;
  }

  /**
   * Handle a COUNT message according to NIP-45
   */
  private async handleCountMessage(
    subscriptionId: string,
    filters: Filter[],
    includeAuthKinds = false,
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
        { includeAuthKinds },
      );
      return { success: true, ...result };
    } catch (error) {
      this.log.error("count_query_failed", {
        filters: clip(JSON.stringify(filters)),
        ...errFields(error),
      });
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
    includeAuthKinds = false,
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
        { includeAuthKinds },
      );
      return { success: true, events };
    } catch (error) {
      this.log.error("req_query_failed", {
        filters: clip(JSON.stringify(filters)),
        ...errFields(error),
      });
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
  async handleEvent(ws: RelayConn, event: NostrEvent) {
    relayEventsCounter.inc({ kind: event.kind });
    try {
      const result = await this.handleEventMessage(event, ws);
      this.sendMessage(ws, [
        "OK",
        result.eventId,
        result.accepted,
        result.message,
      ]);

      if (this.log.levelEnabled("debug")) {
        this.log.debug("event", {
          ip: ws.data.ip,
          id: event.id,
          kind: event.kind,
          accepted: result.accepted,
          reason: result.message || undefined,
        });
      }

      // Broadcast to all matching subscriptions, and notify the fan-out
      // hook so sibling protocol workers can broadcast to theirs.
      if (result.accepted) {
        this.broadcast(event);
        this.onEventAccepted?.(event);
      }
    } catch (error) {
      this.log.error("event_error", {
        ip: ws.data.ip,
        id: event.id,
        kind: event.kind,
        ...errFields(error),
      });
      const message = error instanceof Error ? error.message : String(error);
      this.sendMessage(ws, ["OK", event.id, false, `error: ${message}`]);
    }
  }

  // Handle REQ message
  async handleReq(ws: RelayConn, subscriptionId: string, filters: Filter[]) {
    const endReqTimer = relayReqDurationHistogram.startTimer();
    const startMs = performance.now();
    try {
      const data = ws.data;

      // Check subscription limit before processing
      const limitError = this.validateSubscriptionCount(
        data.subscriptions.size,
      );
      if (limitError) {
        this.sendMessage(ws, ["CLOSED", subscriptionId, limitError.message]);
        this.log.debug("req_rejected", {
          ip: data.ip,
          sub: subscriptionId,
          reason: limitError.message,
        });
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
      const result = await this.handleReqMessage(
        subscriptionId,
        filters,
        this.isMaster(ws),
      );

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

      // Send existing events. Under firehose load this loop is the largest
      // single-tick CPU burst the main thread does for any one client — up to
      // `max_limit` JSON.stringify + ws.send calls back-to-back. Yield
      // every REQ_SEND_CHUNK events so other REQs, EVENT continuations, and
      // the broadcast drain can interleave; without this, a single big REQ
      // can pin the event loop for tens of milliseconds.
      //
      // Serialize the subscription ID once (it's constant across the loop)
      // and build each frame by concatenation around a single
      // `JSON.stringify(event)`, mirroring the broadcast path. This avoids
      // re-stringifying the constant `["EVENT", subId, …]` array wrapper for
      // every event — measurable in profiles where this loop dominates.
      const events = result.events;
      const subIdJson = JSON.stringify(subscriptionId);
      for (let i = 0; i < events.length; i++) {
        ws.send(`["EVENT",${subIdJson},${JSON.stringify(events[i])}]`);
        if ((i + 1) % Relay.REQ_SEND_CHUNK === 0 && i + 1 < events.length) {
          await yieldEventLoop();
        }
      }

      // Send EOSE (End of Stored Events)
      this.sendMessage(ws, ["EOSE", subscriptionId]);

      reqEventsReturnedHistogram.observe(events.length);
      if (this.log.levelEnabled("debug")) {
        this.log.debug("req", {
          ip: ws.data.ip,
          ua: ws.data.userAgent,
          sub: subscriptionId,
          filters: clip(JSON.stringify(filters)),
          returned: events.length,
          ms: Math.round(performance.now() - startMs),
        });
      }
    } catch (error) {
      this.log.error("req_error", {
        ip: ws.data.ip,
        sub: subscriptionId,
        ...errFields(error),
      });
      const message = error instanceof Error ? error.message : String(error);
      this.sendMessage(ws, ["CLOSED", subscriptionId, `error: ${message}`]);
    } finally {
      endReqTimer();
    }
  }

  // Handle COUNT message
  async handleCount(ws: RelayConn, subscriptionId: string, filters: Filter[]) {
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
      const result = await this.handleCountMessage(
        subscriptionId,
        filters,
        this.isMaster(ws),
      );

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

      if (this.log.levelEnabled("debug")) {
        this.log.debug("count", {
          ip: ws.data.ip,
          sub: subscriptionId,
          filters: clip(JSON.stringify(filters)),
          count: result.count,
        });
      }
    } catch (error) {
      this.log.error("count_error", {
        ip: ws.data.ip,
        sub: subscriptionId,
        ...errFields(error),
      });
      const message = error instanceof Error ? error.message : String(error);
      this.sendMessage(ws, ["CLOSED", subscriptionId, `error: ${message}`]);
    }
  }

  // Handle CLOSE message
  handleClose(ws: RelayConn, subscriptionId: string) {
    const data = ws.data;
    data.subscriptions.delete(subscriptionId);
    this.removeFromIndex(ws, subscriptionId);
  }

  // -------------------------------------------------------------------------
  // NIP-77 Negentropy sync
  // -------------------------------------------------------------------------

  /**
   * Send a NEG-ERR. Per NIP-77 the reason starts with a machine-readable
   * prefix (`blocked:` / `closed:` / NIP-01 prefixes); for `blocked:` reasons
   * the relay's record cap may be included as the 4th element.
   */
  private sendNegErr(
    ws: RelayConn,
    subscriptionId: string,
    reason: string,
    maxRecords?: number,
  ): void {
    const message: unknown[] = ["NEG-ERR", subscriptionId, reason];
    if (maxRecords !== undefined) {
      message.push(maxRecords);
    }
    this.sendMessage(ws, message);
  }

  /** Store a Negentropy session, replacing any existing one for the same subscription ID. */
  private setNegSession(
    ws: RelayConn,
    subscriptionId: string,
    session: NegentropySession,
  ): void {
    let sessions = this.negSessions.get(ws);
    if (!sessions) {
      sessions = new Map();
      this.negSessions.set(ws, sessions);
    }
    if (!sessions.has(subscriptionId)) {
      this.negSessionCount++;
    }
    sessions.set(subscriptionId, session);
    relayNegentropySessionsGauge.set(this.negSessionCount);
    this.ensureNegSweep();
  }

  /** Delete a single Negentropy session. Returns whether it existed. */
  private deleteNegSession(ws: RelayConn, subscriptionId: string): boolean {
    const sessions = this.negSessions.get(ws);
    if (!sessions?.delete(subscriptionId)) return false;
    this.negSessionCount--;
    if (sessions.size === 0) {
      this.negSessions.delete(ws);
    }
    relayNegentropySessionsGauge.set(this.negSessionCount);
    this.stopNegSweepIfIdle();
    return true;
  }

  /** Delete all Negentropy sessions for a connection (on close). */
  private clearNegSessions(ws: RelayConn): void {
    const sessions = this.negSessions.get(ws);
    if (!sessions) return;
    this.negSessionCount -= sessions.size;
    this.negSessions.delete(ws);
    relayNegentropySessionsGauge.set(this.negSessionCount);
    this.stopNegSweepIfIdle();
  }

  /** Start the idle sweep while sessions exist. The timer is unref'd so it
   *  never keeps the process alive on its own. */
  private ensureNegSweep(): void {
    if (this.negSweepTimer) return;
    this.negSweepTimer = setInterval(
      () => this.sweepNegSessions(),
      Relay.NEG_SWEEP_INTERVAL_MS,
    );
    (this.negSweepTimer as { unref?: () => void }).unref?.();
  }

  private stopNegSweepIfIdle(): void {
    if (this.negSessionCount === 0 && this.negSweepTimer) {
      clearInterval(this.negSweepTimer);
      this.negSweepTimer = null;
    }
  }

  /** Close sessions that have been idle longer than the timeout. */
  private sweepNegSessions(): void {
    const cutoff = Date.now() - Relay.NEG_IDLE_TIMEOUT_MS;
    for (const [ws, sessions] of this.negSessions) {
      for (const [subscriptionId, session] of sessions) {
        if (session.lastActive < cutoff) {
          this.deleteNegSession(ws, subscriptionId);
          this.sendNegErr(ws, subscriptionId, "closed: sync session timed out");
        }
      }
    }
  }

  /**
   * Handle a NEG-OPEN message (NIP-77): materialize the `(created_at, id)`
   * records matching the filter into a sealed in-memory vector, run the
   * first reconciliation round against the client's initial message, and
   * store the session for subsequent NEG-MSG rounds.
   */
  async handleNegOpen(
    ws: RelayConn,
    subscriptionId: string,
    rawFilter: unknown,
    initialMessageHex: unknown,
  ): Promise<void> {
    const maxSubIdLength = this.relayInfo.limitation?.max_subid_length || 100;

    if (
      typeof subscriptionId !== "string" ||
      !subscriptionId ||
      subscriptionId.length > maxSubIdLength
    ) {
      this.sendNegErr(
        ws,
        typeof subscriptionId === "string" ? subscriptionId : "",
        "invalid: subscription ID too long or empty",
      );
      return;
    }

    // Validate the filter exactly like REQ does.
    const parsed = FILTER_SCHEMA.safeParse(rawFilter);
    if (!parsed.success) {
      this.sendNegErr(
        ws,
        subscriptionId,
        "invalid: filter failed schema validation",
      );
      return;
    }
    let filter = parsed.data as Filter;

    const over = this.exceedsFilterValueCap(filter);
    if (over !== null) {
      this.sendNegErr(
        ws,
        subscriptionId,
        `invalid: filter field "${over}" exceeds max_filter_values (${this.maxFilterValues})`,
      );
      return;
    }

    // Guard auth-protected kinds with the same rules as REQ/COUNT.
    const authCheck = this.checkAuthKinds(ws, subscriptionId, [filter]);
    if (!authCheck.ok) {
      this.sendNegErr(ws, subscriptionId, authCheck.error.message);
      return;
    }
    filter = authCheck.filters[0];

    let initialMessage: Uint8Array;
    try {
      if (typeof initialMessageHex !== "string") throw new Error("not hex");
      initialMessage = hexToBytes(initialMessageHex);
    } catch {
      this.sendNegErr(
        ws,
        subscriptionId,
        "invalid: initial message is not valid hex",
      );
      return;
    }

    if (!isSyncable(this.storage)) {
      this.sendNegErr(
        ws,
        subscriptionId,
        "blocked: sync is not supported by this relay",
      );
      return;
    }

    // Session caps. Re-opening an existing subscription ID replaces it
    // (NIP-77), so it doesn't count against the caps.
    const connSessions = this.negSessions.get(ws);
    const replacing = connSessions?.has(subscriptionId) ?? false;
    if (!replacing) {
      const maxSubscriptions =
        this.relayInfo.limitation?.max_subscriptions || 20;
      if ((connSessions?.size ?? 0) >= maxSubscriptions) {
        this.sendNegErr(
          ws,
          subscriptionId,
          "blocked: too many concurrent sync subscriptions",
        );
        return;
      }
      if (this.negSessionCount >= Relay.NEG_MAX_SESSIONS) {
        this.sendNegErr(
          ws,
          subscriptionId,
          "blocked: relay sync capacity reached, try again later",
        );
        return;
      }
    }

    // Hide future-dated events (same as REQ). A filter `limit` bounds the
    // sync set to the N newest matching events (matching strfry's NIP-77
    // semantics); without one, the sync covers the full matching set,
    // bounded by negentropyMaxRecords.
    const syncFilter = clampUntil(filter);
    const limited =
      typeof syncFilter.limit === "number" &&
      syncFilter.limit <= this.negentropyMaxRecords;

    try {
      // Cheap pre-check via COUNT so oversized queries are rejected before
      // streaming any records. Skipped when `limit` already bounds the set
      // below the record cap.
      const includeAuthKinds = this.isMaster(ws);
      if (!limited && this.storage.count) {
        const { count } = await this.storage.count([syncFilter], {
          includeAuthKinds,
        });
        if (count > this.negentropyMaxRecords) {
          this.sendNegErr(
            ws,
            subscriptionId,
            `blocked: query matches too many records (${count} > ${this.negentropyMaxRecords})`,
            this.negentropyMaxRecords,
          );
          return;
        }
      }

      const items = await this.storage.queryItems(syncFilter, {
        maxItems: this.negentropyMaxRecords + 1,
        includeAuthKinds,
      });
      // COUNT can be approximate — re-check the real size.
      if (items.length > this.negentropyMaxRecords) {
        this.sendNegErr(
          ws,
          subscriptionId,
          `blocked: query matches too many records (> ${this.negentropyMaxRecords})`,
          this.negentropyMaxRecords,
        );
        return;
      }

      const vector = new NegentropyStorageVector();
      for (const item of items) {
        vector.insertHex(item.created_at, item.id);
      }
      vector.seal();

      const neg = new Negentropy(vector, Relay.NEG_FRAME_SIZE_LIMIT);

      let response: Uint8Array | null;
      try {
        ({ message: response } = neg.reconcile(initialMessage));
      } catch (error) {
        this.sendNegErr(
          ws,
          subscriptionId,
          `invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }

      // The server role always produces a message; null is initiator-only.
      if (response === null) {
        this.sendNegErr(ws, subscriptionId, "error: reconciliation failed");
        return;
      }

      this.setNegSession(ws, subscriptionId, {
        neg,
        lastActive: Date.now(),
      });

      this.sendMessage(ws, ["NEG-MSG", subscriptionId, bytesToHex(response)]);
    } catch (error) {
      this.log.error("neg_open_error", {
        ip: ws.data.ip,
        sub: subscriptionId,
        ...errFields(error),
      });
      this.deleteNegSession(ws, subscriptionId);
      const message = error instanceof Error ? error.message : String(error);
      this.sendNegErr(ws, subscriptionId, `error: ${message}`);
    }
  }

  /** Handle a NEG-MSG reconciliation round against an open session. */
  handleNegMsg(
    ws: RelayConn,
    subscriptionId: string,
    messageHex: unknown,
  ): void {
    const session = this.negSessions
      .get(ws)
      ?.get(typeof subscriptionId === "string" ? subscriptionId : "");
    if (!session || typeof subscriptionId !== "string") {
      this.sendNegErr(
        ws,
        typeof subscriptionId === "string" ? subscriptionId : "",
        "closed: unknown subscription ID",
      );
      return;
    }

    try {
      if (typeof messageHex !== "string") throw new Error("not hex");
      const message = hexToBytes(messageHex);
      const { message: response } = session.neg.reconcile(message);
      if (response === null) {
        throw new Error("reconciliation produced no response");
      }
      session.lastActive = Date.now();
      this.sendMessage(ws, ["NEG-MSG", subscriptionId, bytesToHex(response)]);
    } catch (error) {
      // Per NIP-77, the subscription is considered closed after a NEG-ERR.
      this.deleteNegSession(ws, subscriptionId);
      const message = error instanceof Error ? error.message : String(error);
      this.sendNegErr(ws, subscriptionId, `invalid: ${message}`);
    }
  }

  /** Handle NEG-CLOSE: release the session's resources. */
  handleNegClose(ws: RelayConn, subscriptionId: string): void {
    if (typeof subscriptionId !== "string") return;
    this.deleteNegSession(ws, subscriptionId);
  }

  /** Generate a random challenge string for NIP-42 AUTH. */
  private generateChallenge(): string {
    return randomBytes(32).toString("hex");
  }

  /** Send the AUTH challenge to the client if it hasn't been sent yet. */
  private ensureChallengeSent(ws: RelayConn): void {
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
  isAuthenticated(ws: RelayConn, pubkey: string): boolean {
    return ws.data.authedPubkeys.has(pubkey);
  }

  /**
   * Handle an AUTH message from a client (NIP-42).
   * Validates the kind 22242 event and marks the pubkey as authenticated.
   */
  async handleAuth(ws: RelayConn, event: NostrEvent): Promise<void> {
    // Verify signature (AUTH events don't need language/sentiment analysis).
    const { verified } = await this.analyze(event, { verifyOnly: true });
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
  async handleMessage(ws: RelayConn, message: string | Buffer) {
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

      const data = ws.data;
      data.messageCount = (data.messageCount ?? 0) + 1;
      if (type === "REQ") {
        data.reqCount = (data.reqCount ?? 0) + 1;
      } else if (type === "EVENT") {
        data.eventCount = (data.eventCount ?? 0) + 1;
      }

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
            const parsed = EVENT_SCHEMA.safeParse(params[0]);
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
            // Note: we await `handleEvent` here so callers of
            // `handleMessage` (including tests) see the OK response before
            // the returned Promise resolves. In production, `server.ts`
            // doesn't await `handleMessage` itself — Bun fires WS messages
            // in parallel — so events from the same connection still
            // interleave through analysis and batch together.
            //
            // The per-connection semaphore caps how many of those parallel
            // `handleEvent` Promises can be simultaneously in flight for
            // one socket. Without the cap, a firehose client (e.g. a
            // Bluesky bridge) would queue thousands of post-`await
            // analyze()` continuations as microtasks, which run ahead of
            // any I/O callback and starve REQs from other connections.
            // REQs/COUNT/AUTH/CLOSE bypass this gate — they're cheap and
            // we never want them queued behind EVENTs.
            const gate = this.getInflightSemaphore(ws);
            await gate.acquire();
            try {
              await this.handleEvent(ws, parsed.data);
            } finally {
              gate.release();
            }
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
          // nonneg since/until/limit, string arrays on #tags. Unknown
          // top-level keys are rejected by NSchema.filter().
          const parsedFilters: Filter[] = [];
          for (const raw of rawFilters) {
            const parsed = FILTER_SCHEMA.safeParse(raw);
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
            const parsed = FILTER_SCHEMA.safeParse(raw);
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
            const parsed = EVENT_SCHEMA.safeParse(params[0]);
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

        case "NEG-OPEN":
          relayMessagesCounter.inc({ verb: "NEG-OPEN" });
          if (params.length !== 3) {
            this.sendMessage(ws, [
              "NOTICE",
              "invalid: NEG-OPEN message must have subscription ID, filter, and initial message",
            ]);
            return;
          }
          await this.handleNegOpen(
            ws,
            params[0] as string,
            params[1],
            params[2],
          );
          break;

        case "NEG-MSG":
          relayMessagesCounter.inc({ verb: "NEG-MSG" });
          if (params.length !== 2) {
            this.sendMessage(ws, [
              "NOTICE",
              "invalid: NEG-MSG message must have subscription ID and message",
            ]);
            return;
          }
          this.handleNegMsg(ws, params[0] as string, params[1]);
          break;

        case "NEG-CLOSE":
          relayMessagesCounter.inc({ verb: "NEG-CLOSE" });
          if (params.length !== 1) {
            this.sendMessage(ws, [
              "NOTICE",
              "invalid: NEG-CLOSE message must have exactly 1 parameter",
            ]);
            return;
          }
          this.handleNegClose(ws, params[0] as string);
          break;

        default:
          this.sendMessage(ws, [
            "NOTICE",
            `invalid: unknown message type: ${type}`,
          ]);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        // Malformed JSON from a client — traffic noise, not a server fault.
        this.log.debug("invalid_json", { ip: ws.data?.ip });
      } else {
        this.log.error("message_error", {
          ip: ws.data?.ip,
          ...errFields(error),
        });
      }
      this.sendMessage(ws, ["NOTICE", "error: failed to process message"]);
    }
  }

  // Handle WebSocket open
  handleOpen(ws: RelayConn) {
    this.connections.add(ws);
    relayConnectionsGauge.set(this.connections.size);
    ws.data.openedAt = Date.now();
    // Generate NIP-42 AUTH challenge (sent lazily when needed)
    ws.data.challenge = this.generateChallenge();
    this.log.debug("ws_open", { ip: ws.data.ip, ua: ws.data.userAgent });
  }

  /**
   * Lazily allocate the per-connection in-flight semaphore. Stored in a
   * WeakMap keyed by ws so it disappears automatically on close without
   * needing explicit cleanup.
   */
  private getInflightSemaphore(ws: RelayConn): Semaphore {
    let sem = this.connectionInflight.get(ws);
    if (!sem) {
      sem = new Semaphore(this.maxInflightPerConn);
      this.connectionInflight.set(ws, sem);
    }
    return sem;
  }

  // Handle WebSocket close
  handleCloseConnection(ws: RelayConn) {
    const data = ws.data;
    if (this.log.levelEnabled("debug")) {
      this.log.debug("ws_close", {
        ip: data?.ip,
        ua: data?.userAgent,
        dur_s: data?.openedAt
          ? Math.round((Date.now() - data.openedAt) / 1000)
          : undefined,
        msgs: data?.messageCount ?? 0,
        reqs: data?.reqCount ?? 0,
        events: data?.eventCount ?? 0,
        subs: data?.subscriptions.size ?? 0,
      });
    }
    this.connections.delete(ws);
    relayConnectionsGauge.set(this.connections.size);
    this.removeFromIndex(ws);
    this.clearNegSessions(ws);
    ws.data?.subscriptions.clear();
  }
}
