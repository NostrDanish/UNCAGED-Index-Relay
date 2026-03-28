import type {
  NostrEvent,
  NostrFilter,
  NostrRelayCLOSED,
  NostrRelayEOSE,
  NostrRelayEVENT,
  NRelay,
} from "@nostrify/nostrify";
import { NIP50, NKinds, NSchema as n } from "@nostrify/nostrify";
import type { ClientOptions } from "./opensearch-client.ts";
import { Client, Client as OpenSearchClient } from "./opensearch-client.ts";

import type { Config } from "./config.ts";
import { detectMedia } from "./media.ts";
import {
  opensearchBulkQueueGauge,
  opensearchEventsCounter,
  opensearchFlushDurationHistogram,
  opensearchQueriesCounter,
  opensearchQueryDurationHistogram,
} from "./metrics.ts";
import { buildSearchText } from "./search-text.ts";

/** The 7 core Nostr event fields — used as `_source` filter so OpenSearch
 *  only returns these fields in read queries, reducing JSON response size
 *  and parse overhead. */
const NOSTR_EVENT_FIELDS = [
  "id",
  "pubkey",
  "created_at",
  "kind",
  "tags",
  "content",
  "sig",
] as const;

/**
 * OpenSearch document structure for Nostr events
 */
interface NostrEventDocument extends NostrEvent {
  tags_map: Record<string, string[]>;
  /** Indexed full-text search field, built per-kind from event content. */
  search_text: string;
  deleted?: boolean;
  /** Whether this document is a historical version replaced by a newer event. */
  replaced?: boolean;
  protocol?: string;
  amount_msats?: number;
  language?: string;
  sentiment?: string;
  media: boolean;
  video: boolean;
  /** Parsed profile metadata fields for kind 0 events (name search). */
  metadata?: {
    name?: string;
    display_name?: string;
    nip05?: string;
    about?: string;
  };
  /** Number of followers (kind 0 profiles). */
  followers: number;
  /** Count of unique authors who engaged with this event (non-kind-0). */
  engagers: number;
  /** Count of kind 1/1111 referencing events (excludes quote reposts). */
  comment_cnt: number;
  /** Count of kind 7 referencing events. */
  reaction_cnt: number;
  /** Count of kind 6/16 referencing events. */
  repost_cnt: number;
  /** Count of kind 1 quote reposts referencing via `q` tag. */
  quote_cnt: number;
  /** Sum of amount_msats from kind 9735 zap receipts referencing this event. */
  zap_amount_msats: number;
  /** Count of kind 9735 zap receipts referencing this event. */
  zap_cnt: number;
}

/** Scores computed for a non-kind-0 event by {@link OpenSearchRelay.recomputeScores}. */
export interface EventScores {
  comment_cnt: number;
  reaction_cnt: number;
  repost_cnt: number;
  quote_cnt: number;
  zap_amount_msats: number;
  zap_cnt: number;
}

/** Result returned by {@link OpenSearchRelay.recomputeScores}. */
export interface RecomputeResult {
  /** Total number of dirty events processed. */
  count: number;
  /** Pubkey -> follower count for dirty kind 0 events. */
  userScores: Map<string, { followers: number }>;
  /** Event ID -> engagement scores for dirty non-kind-0 events. */
  eventScores: Map<string, EventScores>;
}

/** Pending bulk operation for an event. */
interface BulkEntry {
  event: NostrEvent;
  doc: NostrEventDocument;
  docId: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * OpenSearch-backed Nostr relay implementation
 * Handles event storage and querying with full-text search support (NIP-50)
 */
export class OpenSearchRelay implements NRelay, AsyncDisposable {
  /** Client used for read operations (search, count). */
  private client: Client;
  /** Client used for write operations (bulk, updateByQuery, deleteByQuery). Defaults to `client`. */
  private writeClient: Client;
  private indexName: string;

  /** Whether to preserve historical versions of replaceable/addressable events. */
  private historyEnabled: boolean;
  /** When set, only these kinds preserve history (whitelist takes precedence over exclude). */
  private historyKindsWhitelist: Set<number> | undefined;
  /** Kinds excluded from history preservation (ignored when whitelist is set). */
  private historyKindsExcluded: Set<number>;

  /** Bulk indexing queue. */
  private bulkQueue: BulkEntry[] = [];
  private bulkTimer: ReturnType<typeof setTimeout> | null = null;
  private bulkMaxSize: number;
  private bulkFlushMs: number;

  /**
   * In-memory sets of event IDs and pubkeys that need score recomputation.
   * Accumulated by {@link collectDirtyReferences} during bulk flushes and
   * drained by {@link recomputeScores} which fetches and processes them
   * directly from OpenSearch.
   *
   * This avoids a race condition where a referencing event (e.g. a repost)
   * and the event it references arrive in the same bulk batch. Because the
   * bulk flush uses `refresh: false`, the target event may not yet be
   * searchable immediately after flushing. By deferring to
   * `recomputeScores` (which runs every 5 s), the documents are guaranteed
   * to have been through multiple natural refresh cycles.
   */
  private pendingDirtyIds = new Set<string>();
  private pendingDirtyPubkeys = new Set<string>();

  /**
   * Optional callback invoked when engagement events reference addressable
   * events via `a` tags. Called with the set of `a` tag values (event
   * addresses like `30023:pubkey:slug`) that need NIP-85 stats updates.
   */
  onDirtyAddrs?: (addrs: Set<string>) => void;

  /**
   * Optional callback invoked when engagement events reference external
   * identifiers via `i` tags. Called with the set of `i` tag values
   * (NIP-73 identifiers) that need NIP-85 stats updates.
   */
  onDirtyIdentifiers?: (identifiers: Set<string>) => void;

  /**
   * Add event IDs to the pending dirty set for score recomputation.
   * Used by the background worker to inject dirty state received from the
   * main thread via `postMessage`.
   */
  addDirtyIds(ids: string[]): void {
    for (const id of ids) this.pendingDirtyIds.add(id);
  }

  /**
   * Add pubkeys to the pending dirty set for score recomputation.
   * Used by the background worker to inject dirty state received from the
   * main thread via `postMessage`.
   */
  addDirtyPubkeys(pubkeys: string[]): void {
    for (const pk of pubkeys) this.pendingDirtyPubkeys.add(pk);
  }

  /**
   * Drain the pending dirty sets and return their contents.
   * Public wrapper around the internal drain, used by the main thread to
   * collect dirty state after flush and forward it to the background worker.
   */
  drainDirty(): { ids: string[]; pubkeys: string[] } {
    const ids = [...this.pendingDirtyIds];
    this.pendingDirtyIds = new Set();
    const pubkeys = [...this.pendingDirtyPubkeys];
    this.pendingDirtyPubkeys = new Set();
    return { ids, pubkeys };
  }

  /** Kinds excluded from queries that don't explicitly request them (e.g. DMs, gift wraps). */
  private authKinds: Set<number>;

  /** Delay in ms before Phase 2 (replaceable slot resolution) runs, giving
   *  the natural refresh_interval time to make just-indexed docs visible.
   *  Set to 0 in tests where the mock client resolves synchronously. */
  private refreshDelayMs: number;

  constructor(
    client: Client,
    opts?: {
      indexName?: string;
      bulkMaxSize?: number;
      bulkFlushMs?: number;
      historyEnabled?: boolean;
      historyKindsWhitelist?: Set<number>;
      historyKindsExcluded?: Set<number>;
      authKinds?: Set<number>;
      /** Separate client for write operations. When provided, write-heavy
       *  operations (bulk indexing, updateByQuery, deleteByQuery) use this
       *  client so their connection pool cannot starve read queries. */
      writeClient?: Client;
      /** Delay in ms before Phase 2 replaceable slot resolution. Defaults to
       *  1000 (one refresh_interval cycle). Set to 0 in tests. */
      refreshDelayMs?: number;
    },
  ) {
    this.client = client;
    this.writeClient = opts?.writeClient ?? client;
    this.indexName = opts?.indexName || "nostr-events";
    this.bulkMaxSize = opts?.bulkMaxSize ?? 100;
    this.bulkFlushMs = opts?.bulkFlushMs ?? 200;
    this.historyEnabled = opts?.historyEnabled ?? true;
    this.historyKindsWhitelist = opts?.historyKindsWhitelist;
    this.historyKindsExcluded =
      opts?.historyKindsExcluded ?? new Set([30382, 30383, 30384, 30385]);
    this.authKinds = opts?.authKinds ?? new Set();
    this.refreshDelayMs = opts?.refreshDelayMs ?? 1_000;
  }

  /**
   * Create OpenSearchRelay from config
   */
  static fromConfig(config: Config): OpenSearchRelay {
    const clientOptions: ClientOptions = {
      node: config.opensearchNode,
    };

    if (config.opensearchUsername && config.opensearchPassword) {
      clientOptions.auth = {
        username: config.opensearchUsername,
        password: config.opensearchPassword,
      };
    }

    const client = new OpenSearchClient(clientOptions);
    return new OpenSearchRelay(client, {
      indexName: config.opensearchIndex,
      historyEnabled: config.historyEnabled,
      historyKindsWhitelist: config.historyKindsWhitelist,
      historyKindsExcluded: config.historyKindsExcluded,
      authKinds: config.authKinds,
    });
  }

  /**
   * Single-character tag names are always indexable (any character).
   * This covers all standard single-letter tags (a-z, A-Z) and special
   * characters like `-` (NIP-70).
   */
  private static SINGLE_CHAR_TAG_RE = /^.$/;

  /**
   * Whitelist of multi-letter tag names whose values make sense as keyword
   * fields (exact-match, terms queries, or existence checks).
   *
   * Only tags whose values are identifiers, enum-like strings, or numeric
   * strings used in range queries are included. Free-form text (alt, title,
   * subject, summary, name, etc.), URLs (image, clone, streaming, relay,
   * etc.), and niche protocol-specific tags are excluded since keyword
   * fields treat the entire value as a single opaque token.
   */
  static readonly MULTI_LETTER_TAG_WHITELIST: ReadonlySet<string> = new Set([
    // NIP-40: unix timestamp string, used in range queries for event expiry
    "expiration",
    // NIP-75: event id hex, same referencing pattern as `e` tag
    "goal",
    // NIP-48: external ID, used for exists checks and protocol detection
    "proxy",
    // NIP-52, NIP-53, NIP-69: enum-like values (live/ended/pending/active/sold/etc)
    "status",
    // NIP-89: client application identifier
    "client",
  ]);

  /** Maximum length of a single tag value stored in tags_map. */
  static readonly TAG_VALUE_MAX_LENGTH = 255;

  /**
   * Check whether a tag name is indexable.
   *
   * - All single-character tag names are allowed (covers a-z, A-Z, `-`, etc.).
   * - Multi-character tag names must appear in the whitelist of NIP-defined
   *   tags whose values are useful to index.
   */
  static isIndexableTagName(tagName: string): boolean {
    return (
      OpenSearchRelay.SINGLE_CHAR_TAG_RE.test(tagName) ||
      OpenSearchRelay.MULTI_LETTER_TAG_WHITELIST.has(tagName)
    );
  }

  /**
   * Build tags_map from tags array.
   *
   * Validates tag names and values:
   * - Single-character tag names are always allowed.
   * - Multi-character tag names must be in the whitelist of NIP-defined tags.
   * - Tag values must be ≤ 255 characters. Values that exceed the limit are
   *   skipped, but the tag name key is still created (with an empty array if
   *   no values pass).
   */
  private buildTagsMap(
    tags: string[][],
    kind: number,
  ): Record<string, string[]> {
    const tagsMap: Record<string, string[]> = {};

    for (const tag of tags) {
      if (tag.length >= 2) {
        const [tagName, value] = tag;

        if (!OpenSearchRelay.isIndexableTagName(tagName)) {
          continue;
        }

        if (!tagsMap[tagName]) {
          tagsMap[tagName] = [];
        }

        if (value.length <= OpenSearchRelay.TAG_VALUE_MAX_LENGTH) {
          tagsMap[tagName].push(value);
        }
      }
    }

    // NIP-25: For kind 7 reactions, the target event is the *last* e tag.
    // Only index the last value to avoid inflating stats for intermediate refs.
    if (kind === 7 && tagsMap["e"]?.length > 1) {
      tagsMap["e"] = [tagsMap["e"][tagsMap["e"].length - 1]];
    }

    return tagsMap;
  }

  /** Generate OpenSearch document ID for an event (the hex event ID). */
  private getDocumentId(event: NostrEvent): string {
    return event.id;
  }

  /**
   * Parse the amount in millisatoshis from a bolt11 invoice string.
   * Returns undefined if the invoice cannot be parsed.
   *
   * BOLT 11 encodes amounts in the human-readable prefix as `lnbc{number}{multiplier}`:
   * - `m` = milli-BTC (×100,000,000 msats)
   * - `u` = micro-BTC (×100,000 msats)
   * - `n` = nano-BTC  (×100 msats)
   * - `p` = pico-BTC  (×0.1 msats, must be multiple of 10)
   */
  static parseBolt11Amount(bolt11: string): number | undefined {
    const match = bolt11.match(/^lnbc(\d+)([munp])/);
    if (!match) return undefined;

    const num = Number.parseInt(match[1], 10);
    const multiplier = match[2];

    // 1 BTC = 10^8 sats = 10^11 msats
    // m (milli) = 10^-3 BTC = 10^5 sats = 10^8  msats
    // u (micro) = 10^-6 BTC = 10^2 sats = 10^5  msats
    // n (nano)  = 10^-9 BTC = 10^-1 sats = 10^2  msats
    // p (pico)  = 10^-12 BTC = 10^-4 sats = 10^-1 msats
    const msatsPerUnit: Record<string, number> = {
      m: 100_000_000,
      u: 100_000,
      n: 100,
      p: 0.1,
    };

    return Math.round(num * msatsPerUnit[multiplier]);
  }

  /**
   * Detect media attachments for an event.
   * Delegates to the shared `detectMedia()` function in `media.ts`.
   */
  static detectMedia = detectMedia;

  /**
   * Parse profile metadata from a kind 0 event's JSON content.
   * Returns an object with `name`, `display_name`, `nip05`, and `about`
   * fields, or `undefined` for non-kind-0 events or unparseable content.
   */
  static parseMetadata(
    event: NostrEvent,
  ):
    | { name?: string; display_name?: string; nip05?: string; about?: string }
    | undefined {
    if (event.kind !== 0) return undefined;
    const result = n.json().pipe(n.metadata()).safeParse(event.content);
    if (!result.success) return undefined;
    const { name, display_name, nip05, about } = result.data;
    // Only return if at least one field is present.
    if (!name && !display_name && !nip05 && !about) return undefined;
    return {
      ...(name && { name }),
      ...(display_name && { display_name }),
      ...(nip05 && { nip05 }),
      ...(about && { about }),
    };
  }

  /**
   * Convert NostrEvent to OpenSearch document.
   * When `analysis` is provided (from the worker pool), those pre-computed
   * values are used directly instead of detecting on the main thread.
   */
  private eventToDocument(
    event: NostrEvent,
    analysis?: {
      search_text?: string;
      language?: string;
      sentiment?: string;
      media?: boolean;
      video?: boolean;
    },
  ): NostrEventDocument {
    const tagsMap = this.buildTagsMap(event.tags, event.kind);

    // Extract protocol from proxy tag (NIP-48)
    // Format: ["proxy", <id>, <protocol>]
    const proxyTag = event.tags.find(
      (tag) => tag[0] === "proxy" && tag.length >= 3,
    );
    const protocol = proxyTag?.[2];

    // Extract zap amount from bolt11 for kind 9735 (zap receipts)
    let amount_msats: number | undefined;
    if (event.kind === 9735) {
      const bolt11Tag = event.tags.find((t) => t[0] === "bolt11" && t[1]);
      if (bolt11Tag) {
        amount_msats = OpenSearchRelay.parseBolt11Amount(bolt11Tag[1]);
      }
    }

    const language = analysis?.language;
    const sentiment = analysis?.sentiment;

    // Use pre-computed media detection from the analyze worker when available,
    // otherwise detect on the main thread (direct event() calls, eg tests).
    const mediaResult =
      analysis?.media !== undefined
        ? { media: analysis.media, video: analysis.video }
        : OpenSearchRelay.detectMedia(event);

    // Extract profile metadata for kind 0 events (name search).
    const metadata = OpenSearchRelay.parseMetadata(event);

    return {
      ...event,
      tags_map: tagsMap,
      search_text: analysis?.search_text ?? buildSearchText(event),
      deleted: false,
      replaced: false,
      ...(protocol && { protocol }),
      ...(amount_msats !== undefined && { amount_msats }),
      ...(language && { language }),
      ...(sentiment && { sentiment }),
      media: mediaResult.media ?? false,
      video: mediaResult.video ?? false,
      ...(metadata && { metadata }),
      followers: 0,
      engagers: 0,
      comment_cnt: 0,
      reaction_cnt: 0,
      repost_cnt: 0,
      quote_cnt: 0,
      zap_amount_msats: 0,
      zap_cnt: 0,
    };
  }

  /**
   * Check if the NIP-50 search string contains a distinct:author extension token.
   */
  private hasDistinctAuthor(filter: NostrFilter): boolean {
    if (!filter.search) return false;

    const tokens = NIP50.parseInput(filter.search);
    return tokens.some(
      (t) =>
        typeof t === "object" && t.key === "distinct" && t.value === "author",
    );
  }

  /**
   * Parse NIP-50 sort mode from search tokens
   */
  private parseSortMode(
    filter: NostrFilter,
  ): "top" | "hot" | "controversial" | "rising" | "zaps" | null {
    if (!filter.search) return null;

    const tokens = NIP50.parseInput(filter.search);
    const sortTokens = tokens.filter(
      (t) =>
        typeof t === "object" &&
        t.key === "sort" &&
        ["top", "hot", "controversial", "rising", "zaps"].includes(t.value),
    );

    // Multiple sort tokens - invalid query, will return 0 events
    if (sortTokens.length > 1) {
      return null;
    }

    if (sortTokens.length === 1) {
      const token = sortTokens[0];
      return typeof token === "object"
        ? (token.value as "top" | "hot" | "controversial" | "rising" | "zaps")
        : null;
    }

    // If no extension tokens are provided at all, default to sort:top.
    // Any extension token (eg sort:new, language:en) prevents this default.
    const hasExtensionTokens = tokens.some((t) => typeof t === "object");
    if (!hasExtensionTokens) {
      return "top";
    }

    return null;
  }

  /**
   * Check whether the filter targets only kind 0 (profile metadata) events.
   * When true, sort queries use follower-count / author-based ranking
   * instead of engagement scores.
   */
  private isKind0OnlyFilter(filter: NostrFilter): boolean {
    return (
      Array.isArray(filter.kinds) &&
      filter.kinds.length === 1 &&
      filter.kinds[0] === 0
    );
  }

  /**
   * Detect whether a filter should include historical (replaced) versions.
   *
   * Returns true for:
   * 1. ID-based queries (`{ ids: [...] }`) — clients asking for specific
   *    event IDs should always get them, even if they are replaced.
   * 2. naddr-shaped filters — exactly 1 replaceable/addressable kind +
   *    exactly 1 author (+ optionally 1 `#d` for addressable kinds),
   *    representable as a single `naddr`.
   */
  private isHistoryFilter(filter: NostrFilter): boolean {
    // Any filter with explicit IDs should include replaced docs — the
    // client asked for a specific event by ID and should get it.
    if (filter.ids && filter.ids.length > 0) {
      return true;
    }

    if (
      !filter.kinds ||
      filter.kinds.length !== 1 ||
      !filter.authors ||
      filter.authors.length !== 1
    ) {
      return false;
    }

    const kind = filter.kinds[0];

    if (NKinds.replaceable(kind)) {
      return true;
    }

    if (NKinds.addressable(kind)) {
      const dValues = (filter as Record<string, unknown>)["#d"];
      return Array.isArray(dValues) && dValues.length === 1;
    }

    return false;
  }

  /**
   * Query events using precomputed engagement scores.
   *
   * Each sort mode uses the building-block score fields (followers,
   * engagers, comment_cnt, reaction_cnt, repost_cnt, zap_amount_msats) that
   * are maintained by the background recomputeScores() job. Filters
   * are applied directly in the query, so results are correct for any
   * filter narrowing (kinds, tags, full-text search, etc.).
   *
   * When the filter targets only kind 0 (profile metadata), sort queries
   * use follower-count and author-based ranking instead. See the
   * `querySortTopKind0` etc. methods.
   */
  private async querySortedEvents(
    filter: NostrFilter,
    sortMode: "top" | "hot" | "controversial" | "rising" | "zaps",
    limit: number,
  ): Promise<NostrEvent[]> {
    try {
      let events: NostrEvent[];

      if (this.isKind0OnlyFilter(filter)) {
        switch (sortMode) {
          case "top":
            events = await this.querySortTopKind0(filter, limit);
            break;
          case "hot":
            events = await this.querySortHotKind0(filter, limit);
            break;
          case "controversial":
            events = await this.querySortControversialKind0(filter, limit);
            break;
          case "rising":
            events = await this.querySortRisingKind0(filter, limit);
            break;
          case "zaps":
            events = await this.querySortZapsKind0(filter, limit);
            break;
          default:
            return [];
        }
      } else {
        switch (sortMode) {
          case "top":
            events = await this.querySortTop(filter, limit);
            break;
          case "hot":
            events = await this.querySortHot(filter, limit);
            break;
          case "controversial":
            events = await this.querySortControversial(filter, limit);
            break;
          case "rising":
            events = await this.querySortRising(filter, limit);
            break;
          case "zaps":
            events = await this.querySortZaps(filter, limit);
            break;
          default:
            return [];
        }
      }

      // Apply distinct:author — keep only the highest-scored event per pubkey
      if (this.hasDistinctAuthor(filter)) {
        const seenPubkeys = new Set<string>();
        events = events.filter((event) => {
          if (seenPubkeys.has(event.pubkey)) return false;
          seenPubkeys.add(event.pubkey);
          return true;
        });
      }

      return events.slice(0, limit);
    } catch (error) {
      console.error("Sorted query failed:", error);
      throw error;
    }
  }

  /**
   * Extract hits from an OpenSearch response as NostrEvent[].
   */
  private hitsToEvents(
    // biome-ignore lint/suspicious/noExplicitAny: OpenSearch response typing
    response: any,
  ): NostrEvent[] {
    const hits = response.body.hits.hits;
    return hits
      .filter(
        (hit: { _source?: NostrEvent }) => hit._source !== undefined,
      )
      .map((hit: { _source: NostrEvent }) => hit._source);
  }

  /**
   * Query top events — sorted by precomputed `engagers` (unique authors
   * who referenced this event). Single OpenSearch query with the user's
   * filter applied directly.
   */
  private async querySortTop(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const query = this.buildQuery(filter) as {
      bool: { must: Record<string, unknown>[] };
    };
    query.bool.must.push({ range: { engagers: { gt: 0 } } });

    const response = await this.client.search({
      index: this.indexName,
      body: {
        _source: NOSTR_EVENT_FIELDS,
        query,
        sort: [{ engagers: { order: "desc" as const } }],
        size: limit,
      },
    });

    return this.hitsToEvents(response);
  }

  /**
   * Query hot events — engagers weighted by exponential time decay.
   * Score = engagers * 0.5^(age_in_hours / 24).
   * Uses a script_score query so OpenSearch computes and sorts server-side.
   */
  private async querySortHot(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const now = Math.floor(Date.now() / 1000);
    const query = this.buildQuery(filter) as {
      bool: { must: Record<string, unknown>[] };
    };
    query.bool.must.push({ range: { engagers: { gt: 0 } } });

    const response = await this.client.search({
      index: this.indexName,
      body: {
        _source: NOSTR_EVENT_FIELDS,
        query: {
          script_score: {
            query,
            script: {
              source: `
                double engagers = doc['engagers'].value;
                double ageHours = (params.now - doc['created_at'].value) / 3600.0;
                return engagers * Math.pow(0.5, ageHours / 24.0);
              `,
              params: { now },
            },
          },
        },
        size: limit,
      },
    });

    return this.hitsToEvents(response);
  }

  /**
   * Query controversial events — high engagement with balanced comments
   * vs reactions. Score = min(comment_cnt, reaction_cnt) * sqrt(total).
   */
  private async querySortControversial(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const query = this.buildQuery(filter) as {
      bool: { must: Record<string, unknown>[] };
    };
    // Require at least one comment AND one reaction for controversy
    query.bool.must.push({ range: { comment_cnt: { gt: 0 } } });
    query.bool.must.push({ range: { reaction_cnt: { gt: 0 } } });

    const response = await this.client.search({
      index: this.indexName,
      body: {
        _source: NOSTR_EVENT_FIELDS,
        query: {
          script_score: {
            query,
            script: {
              source: `
                double comments = doc['comment_cnt'].value;
                double reactions = doc['reaction_cnt'].value;
                double balanced = Math.min(comments, reactions);
                return balanced * Math.sqrt(comments + reactions);
              `,
            },
          },
        },
        size: limit,
      },
    });

    return this.hitsToEvents(response);
  }

  /**
   * Query rising events — gaining engagement quickly relative to age.
   * Score = (comment_cnt + reaction_cnt + repost_cnt + quote_cnt) / age_in_hours.
   * Uses all-time counts as the score basis.
   */
  private async querySortRising(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const now = Math.floor(Date.now() / 1000);
    const query = this.buildQuery(filter) as {
      bool: { must: Record<string, unknown>[] };
    };
    query.bool.must.push({ range: { engagers: { gt: 0 } } });

    const response = await this.client.search({
      index: this.indexName,
      body: {
        _source: NOSTR_EVENT_FIELDS,
        query: {
          script_score: {
            query,
            script: {
              source: `
                double total = doc['comment_cnt'].value + doc['reaction_cnt'].value + doc['repost_cnt'].value + doc['quote_cnt'].value;
                double ageHours = Math.max((params.now - doc['created_at'].value) / 3600.0, 0.1);
                return total / ageHours;
              `,
              params: { now },
            },
          },
        },
        size: limit,
      },
    });

    return this.hitsToEvents(response);
  }

  /**
   * Query most-zapped events — sorted by precomputed `zap_amount_msats`.
   */
  private async querySortZaps(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const query = this.buildQuery(filter) as {
      bool: { must: Record<string, unknown>[] };
    };
    query.bool.must.push({ range: { zap_amount_msats: { gt: 0 } } });

    const response = await this.client.search({
      index: this.indexName,
      body: {
        _source: NOSTR_EVENT_FIELDS,
        query,
        sort: [{ zap_amount_msats: { order: "desc" as const } }],
        size: limit,
      },
    });

    return this.hitsToEvents(response);
  }

  // ---------------------------------------------------------------------------
  // Kind-0 (profile) sort methods
  //
  // When the filter targets only kind 0, sort queries use follower-count
  // (stored in `followers`) and author-based ranking.  For modes that don't
  // apply directly to profiles (controversial, rising, zaps) we perform a
  // two-step query: first find top events by the sort mode across all kinds,
  // then return the kind 0 events for those authors.
  // ---------------------------------------------------------------------------

  /**
   * Sort kind 0 events by follower count.
   */
  private async querySortTopKind0(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const query = this.buildQuery(filter) as {
      bool: { must: Record<string, unknown>[] };
    };
    query.bool.must.push({ range: { followers: { gt: 0 } } });

    const response = await this.client.search({
      index: this.indexName,
      body: {
        _source: NOSTR_EVENT_FIELDS,
        query,
        sort: [{ followers: { order: "desc" as const } }],
        size: limit,
      },
    });

    return this.hitsToEvents(response);
  }

  /**
   * Sort kind 0 events by follower count with time decay.
   * Score = followers * 0.5^(age_hours / 24).
   */
  private async querySortHotKind0(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const now = Math.floor(Date.now() / 1000);
    const query = this.buildQuery(filter) as {
      bool: { must: Record<string, unknown>[] };
    };
    query.bool.must.push({ range: { followers: { gt: 0 } } });

    const response = await this.client.search({
      index: this.indexName,
      body: {
        _source: NOSTR_EVENT_FIELDS,
        query: {
          script_score: {
            query,
            script: {
              source: `
                double followers = doc['followers'].value;
                double ageHours = (params.now - doc['created_at'].value) / 3600.0;
                return followers * Math.pow(0.5, ageHours / 24.0);
              `,
              params: { now },
            },
          },
        },
        size: limit,
      },
    });

    return this.hitsToEvents(response);
  }

  /**
   * Two-step sort: find the most controversial events across all kinds,
   * extract unique author pubkeys, then return their kind 0 events
   * (respecting any search-text filter on the kind 0 content).
   */
  private async querySortControversialKind0(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    return this.querySortKind0ByAuthors(
      filter,
      limit,
      this.querySortControversial.bind(this),
    );
  }

  /**
   * Two-step sort: find rising events, extract authors, return kind 0s.
   */
  private async querySortRisingKind0(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    return this.querySortKind0ByAuthors(
      filter,
      limit,
      this.querySortRising.bind(this),
    );
  }

  /**
   * Sort kind 0 events by the total zap amount received across all of
   * an author's events.  Uses a terms aggregation on pubkey with a sum
   * sub-aggregation on zap_amount_msats.
   */
  private async querySortZapsKind0(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    // Phase 1: Aggregate total zap_amount_msats per author across all events.
    const aggResponse = await this.client.search({
      index: this.indexName,
      body: {
        query: {
          bool: {
            must: [
              { term: { deleted: false } },
              { range: { zap_amount_msats: { gt: 0 } } },
            ],
          },
        },
        size: 0,
        aggs: {
          top_authors: {
            terms: {
              field: "pubkey",
              size: limit * 5,
              order: { total_zaps: "desc" as const },
            },
            aggs: {
              total_zaps: {
                sum: { field: "zap_amount_msats" },
              },
            },
          },
        },
      },
    });

    const buckets =
      (
        aggResponse.body.aggregations?.top_authors as unknown as {
          buckets?: Array<{
            key: string;
            total_zaps?: { value: number };
          }>;
        }
      )?.buckets || [];

    if (buckets.length === 0) return [];

    // Ordered list of pubkeys by total zaps
    const orderedPubkeys = buckets.map((b) => b.key);

    // Phase 2: Fetch kind 0 events for those pubkeys (with search text filter).
    return this.fetchKind0ForAuthors(filter, orderedPubkeys, limit);
  }

  /**
   * Generic two-step helper for kind-0 sort modes that derive author
   * ordering from a non-kind-0 sort query.
   *
   * 1. Runs the provided `sortFn` WITHOUT the kinds:[0] constraint to
   *    find top-scoring events across all kinds.
   * 2. Extracts unique author pubkeys in score order.
   * 3. Fetches kind 0 events for those pubkeys, preserving the order.
   */
  private async querySortKind0ByAuthors(
    filter: NostrFilter,
    limit: number,
    sortFn: (filter: NostrFilter, limit: number) => Promise<NostrEvent[]>,
  ): Promise<NostrEvent[]> {
    // Build a filter without the kinds constraint so we search across all kinds.
    const { kinds: _kinds, ...filterWithoutKinds } = filter;

    // Over-fetch to account for deduplication by pubkey.
    const overFetchLimit = limit * 5;
    const events = await sortFn(filterWithoutKinds, overFetchLimit);

    // Extract unique author pubkeys in score order.
    const orderedPubkeys: string[] = [];
    const seenPubkeys = new Set<string>();
    for (const event of events) {
      if (!seenPubkeys.has(event.pubkey)) {
        seenPubkeys.add(event.pubkey);
        orderedPubkeys.push(event.pubkey);
      }
    }

    if (orderedPubkeys.length === 0) return [];

    // Fetch kind 0 events for those pubkeys (with search text filter).
    return this.fetchKind0ForAuthors(filter, orderedPubkeys, limit);
  }

  /**
   * Fetch kind 0 events for an ordered list of author pubkeys.
   *
   * Applies search-text and other filter constraints from the original
   * filter (except kinds and authors, which are overridden).  Results
   * are returned in the same order as `orderedPubkeys`.
   */
  private async fetchKind0ForAuthors(
    filter: NostrFilter,
    orderedPubkeys: string[],
    limit: number,
  ): Promise<NostrEvent[]> {
    // Override kinds and authors on the filter.
    const kind0Filter: NostrFilter = {
      ...filter,
      kinds: [0],
      authors: orderedPubkeys,
    };

    const query = this.buildQuery(kind0Filter);

    const response = await this.client.search({
      index: this.indexName,
      body: {
        _source: NOSTR_EVENT_FIELDS,
        query,
        size: orderedPubkeys.length, // one kind 0 per pubkey at most
      },
    });

    const events = this.hitsToEvents(response);

    // Re-order events to match the original pubkey ordering.
    const eventByPubkey = new Map<string, NostrEvent>();
    for (const event of events) {
      eventByPubkey.set(event.pubkey, event);
    }

    const ordered: NostrEvent[] = [];
    for (const pubkey of orderedPubkeys) {
      const event = eventByPubkey.get(pubkey);
      if (event) {
        ordered.push(event);
        if (ordered.length >= limit) break;
      }
    }

    return ordered;
  }

  /**
   * Build OpenSearch query from Nostr filter.
   *
   * When `includeReplaced` is true, historical (replaced) versions of
   * replaceable/addressable events are included in results. By default
   * they are excluded.
   */
  private buildQuery(
    filter: NostrFilter,
    opts?: { includeReplaced?: boolean },
  ): Record<string, unknown> {
    const must: Record<string, unknown>[] = [
      { term: { deleted: false } }, // Always exclude deleted events
    ];
    const mustNot: Record<string, unknown>[] = [];

    // Exclude replaced (historical) versions unless explicitly requested.
    if (!opts?.includeReplaced) {
      mustNot.push({ term: { replaced: true } });
    }

    // NIP-40: Exclude expired events
    const now = Math.floor(Date.now() / 1000);
    mustNot.push({
      range: { "tags_map.expiration": { lte: String(now) } },
    });

    // ID filter
    if (filter.ids && filter.ids.length > 0) {
      must.push({ terms: { id: filter.ids } });
    }

    // Author filter
    if (filter.authors && filter.authors.length > 0) {
      must.push({ terms: { pubkey: filter.authors } });
    }

    // Kind filter
    if (filter.kinds && filter.kinds.length > 0) {
      must.push({ terms: { kind: filter.kinds } });
    } else if (
      this.authKinds.size > 0 &&
      !(filter.ids && filter.ids.length > 0)
    ) {
      // Exclude auth-protected kinds from queries that don't explicitly request them.
      // When specific IDs are requested, skip exclusion — the relay layer handles auth.
      mustNot.push({ terms: { kind: [...this.authKinds] } });
    }

    // Time range filters (clamp to safe range for OpenSearch long type)
    if (filter.since || filter.until) {
      const range: Record<string, number> = {};
      if (filter.since)
        range.gte = Math.min(filter.since, Number.MAX_SAFE_INTEGER);
      if (filter.until)
        range.lte = Math.min(filter.until, Number.MAX_SAFE_INTEGER);
      must.push({ range: { created_at: range } });
    }

    // Tag filters using tags_map
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith("#") && Array.isArray(values) && values.length > 0) {
        const tagName = key.substring(1);
        must.push({ terms: { [`tags_map.${tagName}`]: values } });
      }
    }

    // Full-text search (NIP-50)
    if (filter.search) {
      const tokens = NIP50.parseInput(filter.search);
      const textTokens = tokens.filter((t) => typeof t === "string");

      // Split into positive and negative (prefixed with "-") search terms
      const positiveTerms = textTokens
        .filter((t) => !t.startsWith("-"))
        .join(" ");
      const negativeTerms = textTokens
        .filter((t) => t.startsWith("-"))
        .map((t) => t.slice(1))
        .filter((t) => t.length > 0);

      if (positiveTerms.trim()) {
        if (this.isKind0OnlyFilter(filter)) {
          // For kind 0 searches, match against parsed metadata name fields
          // using edge-ngram prefix matching for autocomplete-style queries.
          must.push({
            multi_match: {
              query: positiveTerms,
              fields: ["metadata.name", "metadata.display_name"],
              operator: "and",
            },
          });
        } else {
          must.push({
            multi_match: {
              query: positiveTerms,
              fields: ["search_text", "search_text.url"],
              operator: "and",
              type: "best_fields",
            },
          });
        }
      }

      // Add negative terms as must_not clauses
      for (const term of negativeTerms) {
        if (this.isKind0OnlyFilter(filter)) {
          mustNot.push({
            multi_match: {
              query: term,
              fields: ["metadata.name", "metadata.display_name"],
            },
          });
        } else {
          mustNot.push({
            multi_match: {
              query: term,
              fields: ["search_text", "search_text.url"],
            },
          });
        }
      }

      // Handle protocol: extension (NIP-48 + NIP-50)
      const protocolToken = tokens.find(
        (t) => typeof t === "object" && t.key === "protocol",
      );
      if (protocolToken && typeof protocolToken === "object") {
        if (protocolToken.value === "nostr") {
          mustNot.push({ exists: { field: "protocol" } });
        } else {
          must.push({
            term: { protocol: protocolToken.value },
          });
        }
      }

      // Handle language: extension (NIP-50)
      const languageToken = tokens.find(
        (t) => typeof t === "object" && t.key === "language",
      );
      if (languageToken && typeof languageToken === "object") {
        must.push({
          term: { language: languageToken.value },
        });
      }

      // Handle sentiment: extension (NIP-50)
      const sentimentToken = tokens.find(
        (t) => typeof t === "object" && t.key === "sentiment",
      );
      if (sentimentToken && typeof sentimentToken === "object") {
        must.push({
          term: { sentiment: sentimentToken.value },
        });
      }

      // Handle media: extension (NIP-50)
      const mediaToken = tokens.find(
        (t) => typeof t === "object" && t.key === "media",
      );
      if (mediaToken && typeof mediaToken === "object") {
        if (mediaToken.value === "true") {
          must.push({ term: { media: true } });
        } else if (mediaToken.value === "false") {
          mustNot.push({ term: { media: true } });
        }
      }

      // Handle video: extension (NIP-50)
      const videoToken = tokens.find(
        (t) => typeof t === "object" && t.key === "video",
      );
      if (videoToken && typeof videoToken === "object") {
        if (videoToken.value === "true") {
          must.push({ term: { video: true } });
        } else if (videoToken.value === "false") {
          mustNot.push({ term: { video: true } });
        }
      }
    }

    const bool: Record<string, unknown> = { must };
    if (mustNot.length > 0) {
      bool.must_not = mustNot;
    }
    return { bool };
  }

  /**
   * Query events from OpenSearch based on a single filter
   */
  private async queryFilter(
    filter: NostrFilter,
    _signal?: AbortSignal,
  ): Promise<NostrEvent[]> {
    // If limit is 0, skip the query (realtime-only subscription)
    if (filter.limit === 0) {
      return [];
    }

    // Default to 500, cap at 5000
    const limit = Math.min(filter.limit || 500, 5000);

    // Check if this is a sort query
    const sortMode = this.parseSortMode(filter);

    // Validate: multiple sort tokens return 0 events
    if (filter.search) {
      const tokens = NIP50.parseInput(filter.search);
      const sortTokenCount = tokens.filter(
        (t) => typeof t === "object" && t.key === "sort",
      ).length;
      if (sortTokenCount > 1) {
        return []; // Invalid query - multiple sort tokens
      }
    }

    if (sortMode) {
      opensearchQueriesCounter.inc();
      const sortEnd = opensearchQueryDurationHistogram.startTimer();
      try {
        const result = await this.querySortedEvents(filter, sortMode, limit);
        sortEnd();
        return result;
      } catch (error) {
        sortEnd();
        throw error;
      }
    }

    // Auto-include historical versions for naddr-shaped filters.
    const includeReplaced = this.isHistoryFilter(filter);
    const query = this.buildQuery(filter, { includeReplaced });
    const distinctAuthor = this.hasDistinctAuthor(filter);

    // Sort by created_at (newest first)
    const sort = [{ created_at: { order: "desc" as const } }];

    opensearchQueriesCounter.inc();
    const queryEnd = opensearchQueryDurationHistogram.startTimer();
    try {
      const searchBody: Record<string, unknown> = {
        _source: NOSTR_EVENT_FIELDS,
        query,
        sort,
        size: limit,
      };

      // Use OpenSearch field collapsing to return only 1 event per pubkey
      if (
        distinctAuthor &&
        !filter.kinds?.every((k) => NKinds.replaceable(k))
      ) {
        searchBody.collapse = { field: "pubkey" };
      }

      const response = await this.client.search({
        index: this.indexName,
        body: searchBody,
      });
      queryEnd();

      const hits = response.body.hits.hits;
      return hits
        .filter((hit: { _source?: NostrEvent }) => hit._source !== undefined)
        .map((hit: { _source: NostrEvent }) => hit._source);
    } catch (error) {
      queryEnd();
      console.error("OpenSearch query failed:", error);
      throw error;
    }
  }

  /**
   * Enqueue an event for bulk indexing.
   * The returned promise resolves once the event has been flushed to OpenSearch.
   *
   * When `opts.analysis` is provided (pre-computed by the analyze worker pool),
   * language and sentiment values are used directly instead of being detected
   * on the main thread.
   */
  async event(
    event: NostrEvent,
    opts?: {
      signal?: AbortSignal;
      analysis?: {
        search_text?: string;
        language?: string;
        sentiment?: string;
        media?: boolean;
        video?: boolean;
      };
    },
  ): Promise<void> {
    const doc = this.eventToDocument(event, opts?.analysis);
    const docId = this.getDocumentId(event);

    return new Promise<void>((resolve, reject) => {
      this.bulkQueue.push({ event, doc, docId, resolve, reject });
      opensearchBulkQueueGauge.set(this.bulkQueue.length);

      if (this.bulkQueue.length >= this.bulkMaxSize) {
        this.flush();
      } else if (!this.bulkTimer) {
        this.bulkTimer = setTimeout(() => this.flush(), this.bulkFlushMs);
      }
    });
  }

  /**
   * Flush the bulk queue to OpenSearch.
   *
   * All events are indexed uniformly under their hex event ID as the doc ID.
   * For replaceable/addressable events, after the bulk index, an
   * `updateByQuery` marks older versions of the same slot as
   * `replaced: true` and strips their score fields.
   *
   * Historical documents persist indefinitely unless explicitly deleted
   * (kind 5 or kind 62). For frequently-updated kinds (e.g. kind 0
   * profiles, kind 3 contact lists), this means storage grows with each
   * replacement. A TTL or max-versions-per-slot pruning strategy may be
   * needed in the future for high-churn relays.
   */
  async flush(): Promise<void> {
    if (this.bulkTimer) {
      clearTimeout(this.bulkTimer);
      this.bulkTimer = null;
    }

    if (this.bulkQueue.length === 0) return;

    const entries = this.bulkQueue.splice(0);
    opensearchBulkQueueGauge.set(this.bulkQueue.length);

    // --- Phase 1: Build bulk body. All events are plain index operations.
    const body: Array<Record<string, unknown>> = [];

    for (const entry of entries) {
      body.push({
        index: { _index: this.indexName, _id: entry.docId },
      });
      body.push(entry.doc as unknown as Record<string, unknown>);
    }

    const flushEnd = opensearchFlushDurationHistogram.startTimer();
    try {
      const response = await this.writeClient.bulk({ body });
      flushEnd();

      // Resolve/reject entries in chunks, yielding the event loop between
      // chunks.  Each resolve() triggers the awaiting handleEvent() which
      // calls broadcast() synchronously.  Without yields, resolving ~100
      // entries in a tight loop means ~100 broadcast() calls (each iterating
      // hundreds of subscribers) execute before any pending REQ can process,
      // causing 200-500ms p95 spikes.
      const FLUSH_CHUNK = 10;

      if (response.body.errors) {
        const items: Array<Record<string, { error?: unknown }>> =
          response.body.items;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const result = item.index as { error?: unknown } | undefined;
          if (result?.error) {
            entries[i].reject(
              new Error(`Bulk index failed: ${JSON.stringify(result.error)}`),
            );
          } else {
            opensearchEventsCounter.inc({ kind: entries[i].event.kind });
            entries[i].resolve();
          }
          if ((i + 1) % FLUSH_CHUNK === 0 && i + 1 < items.length) {
            await new Promise<void>((r) => setTimeout(r, 0));
          }
        }
      } else {
        for (let i = 0; i < entries.length; i++) {
          opensearchEventsCounter.inc({ kind: entries[i].event.kind });
          entries[i].resolve();
          if ((i + 1) % FLUSH_CHUNK === 0 && i + 1 < entries.length) {
            await new Promise<void>((r) => setTimeout(r, 0));
          }
        }
      }

      // Accumulate referenced event IDs for deferred score recomputation
      // by recomputeScores(), avoiding a race where a referencing event
      // and its target arrive in the same bulk batch.
      this.collectDirtyReferences(entries);
    } catch (error) {
      flushEnd();
      // Entire bulk request failed — reject all entries
      const err = error instanceof Error ? error : new Error(String(error));
      for (const entry of entries) {
        entry.reject(err);
      }
    }

    // --- Phase 2: Mark older replaceable/addressable versions as replaced.
    // Fire-and-forget so it doesn't block the event loop for incoming REQs.
    // Between Phase 1 and Phase 2 completion, queries may briefly return
    // both old and new versions — Nostr clients handle duplicate events.
    //
    // Phase 2 needs to search for the just-indexed documents. Rather than
    // forcing an expensive `refresh: true` on the bulk request (which holds
    // an HTTP connection for 1-2s and causes head-of-line blocking for read
    // queries), we wait for the next natural refresh cycle (refresh_interval
    // defaults to 1s) before running the slot resolution search.
    const hasReplaceable = entries.some(
      (e) =>
        NKinds.replaceable(e.event.kind) || NKinds.addressable(e.event.kind),
    );
    if (hasReplaceable) {
      if (this.refreshDelayMs > 0) {
        setTimeout(() => {
          this.resolveReplaceableSlots(entries).catch((err) =>
            console.warn("Phase 2 replaceable slot resolution failed:", err),
          );
        }, this.refreshDelayMs);
      } else {
        this.resolveReplaceableSlots(entries).catch((err) =>
          console.warn("Phase 2 replaceable slot resolution failed:", err),
        );
      }
    }
  }

  /**
   * Phase 2 of flush: for replaceable/addressable events, find the slot
   * winner and mark all losers as `replaced: true` (or delete them for
   * excluded kinds).  Runs asynchronously so it doesn't block the main
   * event loop.
   */
  private async resolveReplaceableSlots(entries: BulkEntry[]): Promise<void> {
    const slots = new Map<
      string,
      {
        kind: number;
        pubkey: string;
        dTag: string;
        eventId: string;
        createdAt: number;
      }
    >();

    for (const entry of entries) {
      if (
        !NKinds.replaceable(entry.event.kind) &&
        !NKinds.addressable(entry.event.kind)
      ) {
        continue;
      }

      const dTag = NKinds.addressable(entry.event.kind)
        ? entry.event.tags.find(([name]) => name === "d")?.[1] || ""
        : "";
      const slotKey = `${entry.event.kind}:${entry.event.pubkey}:${dTag}`;

      const existing = slots.get(slotKey);
      // If multiple events for the same slot in one batch, keep the newest
      // (or lowest ID at same timestamp) — that's the one that should remain
      // as the current version.
      if (
        !existing ||
        entry.event.created_at > existing.createdAt ||
        (entry.event.created_at === existing.createdAt &&
          entry.event.id < existing.eventId)
      ) {
        slots.set(slotKey, {
          kind: entry.event.kind,
          pubkey: entry.event.pubkey,
          dTag,
          eventId: entry.event.id,
          createdAt: entry.event.created_at,
        });
      }
    }

    // For each slot, find the actual current winner (newest non-deleted,
    // non-replaced event) and mark all others as replaced.
    for (const [, slot] of slots) {
      const slotMust: Record<string, unknown>[] = [
        { term: { kind: slot.kind } },
        { term: { pubkey: slot.pubkey } },
        { term: { deleted: false } },
        { term: { replaced: false } },
      ];

      if (NKinds.addressable(slot.kind)) {
        slotMust.push({ term: { "tags_map.d": slot.dTag } });
      }

      try {
        // Find the newest event in the slot to determine the true winner.
        const searchResponse = await this.client.search({
          index: this.indexName,
          body: {
            query: { bool: { must: slotMust } },
            sort: [{ created_at: { order: "desc" } }, { id: { order: "asc" } }],
            size: 1,
            _source: ["id"],
          },
        });

        const hits = searchResponse.body.hits.hits as Array<{
          _source?: { id: string };
        }>;
        if (!hits[0]?._source?.id) continue;

        const winnerId = hits[0]._source.id;

        // Remove old versions from the slot. For high-churn kinds in
        // HISTORY_EXCLUDED_KINDS, delete them outright to avoid storage
        // bloat. For all other kinds, mark them as `replaced: true` to
        // preserve queryable history.
        const loserQuery = {
          bool: {
            must: slotMust,
            must_not: [{ term: { id: winnerId } }],
          },
        };

        if (!this.shouldPreserveHistory(slot.kind)) {
          await this.writeClient.deleteByQuery({
            index: this.indexName,
            body: { query: loserQuery },
            refresh: false,
            conflicts: "proceed",
          });
        } else {
          await this.writeClient.updateByQuery({
            index: this.indexName,
            body: {
              query: loserQuery,
              script: {
                source: `
                  ctx._source.replaced = true;
                  ctx._source.followers = 0;
                  ctx._source.engagers = 0;
                  ctx._source.comment_cnt = 0;
                  ctx._source.reaction_cnt = 0;
                  ctx._source.repost_cnt = 0;
                  ctx._source.quote_cnt = 0;
                  ctx._source.zap_amount_msats = 0;
                  ctx._source.zap_cnt = 0;
                `,
                lang: "painless",
              },
            },
            refresh: false,
            conflicts: "proceed",
          });
        }
        // Mark kind 0 pubkey as dirty so follower count gets recomputed
        // on the next recomputeScores() cycle. Follower counts are
        // pubkey-based (from kind 3 contact lists), so they transfer
        // to the new profile event automatically.
        if (slot.kind === 0) {
          this.pendingDirtyPubkeys.add(slot.pubkey);
        }
      } catch (error) {
        // Non-fatal — the events are indexed, just not marked as replaced yet.
        // The next flush or a query with `replaced: false` filter will still
        // return the correct current version (newest by created_at).
        console.warn("Failed to mark old versions as replaced:", error);
      }
    }
  }

  /**
   * Determine whether a given kind should preserve historical versions
   * when replaced. The logic is:
   *
   * 1. If history is globally disabled → false
   * 2. If a whitelist is set → true only if the kind is in the whitelist
   * 3. Otherwise → true unless the kind is in the exclude list
   */
  private shouldPreserveHistory(kind: number): boolean {
    if (!this.historyEnabled) return false;
    if (this.historyKindsWhitelist) {
      return this.historyKindsWhitelist.has(kind);
    }
    return !this.historyKindsExcluded.has(kind);
  }

  /** Kinds whose `e`-tag references affect engagement scores. */
  private static REFERENCING_KINDS = new Set([1, 6, 7, 16, 17, 1111, 9735]);

  /**
   * After indexing referencing events, accumulate the target event IDs and
   * followed pubkeys into in-memory sets for deferred score recomputation.
   * {@link recomputeScores} drains these sets and fetches the events
   * directly — by that time all recently-indexed documents are searchable.
   *
   * Also notifies the NIP-85 publisher about dirty addressable event and
   * external identifier references via callbacks.
   */
  private collectDirtyReferences(entries: BulkEntry[]): void {
    const referencedAddrs = new Set<string>();
    const referencedIdentifiers = new Set<string>();

    for (const entry of entries) {
      // Engagement-referencing events: accumulate target event IDs,
      // and collect addressable event references via `a` tags.
      if (OpenSearchRelay.REFERENCING_KINDS.has(entry.event.kind)) {
        // NIP-25: For kind 7 reactions, only the last e tag is the target.
        if (entry.event.kind === 7) {
          for (let i = entry.event.tags.length - 1; i >= 0; i--) {
            if (entry.event.tags[i][0] === "e" && entry.event.tags[i][1]) {
              this.pendingDirtyIds.add(entry.event.tags[i][1]);
              break;
            }
          }
        }

        for (const tag of entry.event.tags) {
          if (tag[0] === "e" && tag[1] && entry.event.kind !== 7) {
            this.pendingDirtyIds.add(tag[1]);
          } else if (tag[0] === "q" && tag[1]) {
            // NIP-18: Quote reposts reference the quoted event via `q` tag.
            this.pendingDirtyIds.add(tag[1]);
          } else if (tag[0] === "a" && tag[1]) {
            referencedAddrs.add(tag[1]);
          } else if (tag[0] === "i" && tag[1]) {
            referencedIdentifiers.add(tag[1]);
          } else if (tag[0] === "I" && tag[1] && entry.event.kind === 1111) {
            referencedIdentifiers.add(tag[1]);
          }
        }
      }

      // Kind 3 (contact list): accumulate followed pubkeys so their
      // kind 0 events get marked dirty for follower count recomputation.
      if (entry.event.kind === 3) {
        for (const tag of entry.event.tags) {
          if (tag[0] === "p" && tag[1]) {
            this.pendingDirtyPubkeys.add(tag[1]);
          }
        }
      }
    }

    // Notify NIP-85 publisher about dirty addressable event references.
    if (referencedAddrs.size > 0) {
      this.onDirtyAddrs?.(referencedAddrs);
    }

    // Notify NIP-85 publisher about dirty external identifier references.
    if (referencedIdentifiers.size > 0) {
      this.onDirtyIdentifiers?.(referencedIdentifiers);
    }
  }

  /**
   * Drain the in-memory pending dirty sets and return their contents.
   * Replaces each set with a fresh empty one so that concurrent
   * `collectDirtyReferences()` calls from `flush()` are not affected.
   */
  private drainPendingDirty(): {
    ids: Set<string>;
    pubkeys: Set<string>;
  } {
    const ids = this.pendingDirtyIds;
    this.pendingDirtyIds = new Set();
    const pubkeys = this.pendingDirtyPubkeys;
    this.pendingDirtyPubkeys = new Set();
    return { ids, pubkeys };
  }

  /**
   * Query events from OpenSearch
   */
  async query(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<NostrEvent[]> {
    const allEvents: NostrEvent[] = [];
    const seenIds = new Set<string>();

    for (const filter of filters) {
      if (opts?.signal?.aborted) {
        break;
      }
      try {
        const events = await this.queryFilter(filter, opts?.signal);

        // Deduplicate events across filters
        for (const event of events) {
          if (!seenIds.has(event.id)) {
            seenIds.add(event.id);
            allEvents.push(event);
          }
        }
      } catch (error) {
        console.error("Query failed for filter:", filter, error);
      }
    }

    return allEvents;
  }

  /**
   * Stream events from OpenSearch (NRelay interface)
   */
  async *req(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<NostrRelayEVENT | NostrRelayEOSE | NostrRelayCLOSED> {
    // Query all filters
    for (const filter of filters) {
      try {
        const events = await this.queryFilter(filter, opts?.signal);
        for (const event of events) {
          if (opts?.signal?.aborted) {
            return;
          }
          yield ["EVENT", "req", event];
        }
      } catch (error) {
        console.error("Query failed for filter:", filter, error);
      }
    }
    yield ["EOSE", "req"];
  }

  /**
   * Count events matching the given filters (NIP-45)
   * Uses OpenSearch count API for efficiency. For multiple filters, sums the counts
   * and marks as approximate since we don't deduplicate across filters.
   *
   * When distinct:author is present, uses a cardinality aggregation on pubkey
   * to return the number of unique authors instead of total events.
   */
  async count(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ count: number; approximate?: boolean }> {
    let totalCount = 0;
    let approximate: boolean | undefined;

    for (const filter of filters) {
      if (opts?.signal?.aborted) {
        break;
      }

      try {
        const query = this.buildQuery(filter);

        if (
          this.hasDistinctAuthor(filter) &&
          !filter.kinds?.every((k) => NKinds.replaceable(k))
        ) {
          // Use cardinality aggregation for distinct author count.
          // precision_threshold controls HyperLogLog++ precision: lower values
          // are significantly faster on large result sets at the cost of some
          // accuracy (still very good for counts above the threshold).
          // A 10s timeout ensures the query returns partial results rather than
          // hanging indefinitely on broad filters.
          const response = await this.client.search({
            index: this.indexName,
            body: {
              query,
              size: 0,
              timeout: "5s",
              aggs: {
                unique_authors: {
                  cardinality: {
                    field: "pubkey",
                    precision_threshold: 100,
                  },
                },
              },
            },
          });

          const cardinality = response.body.aggregations?.unique_authors as
            | { value: number }
            | undefined;
          totalCount += cardinality?.value ?? 0;
          // Cardinality aggregation is inherently approximate
          approximate = true;
        } else {
          // Use count API - much more efficient than search, no document fetching
          const response = await this.client.count({
            index: this.indexName,
            body: { query },
          });

          totalCount += response.body.count;
        }
      } catch (error) {
        console.error("Count query failed for filter:", filter, error);
      }
    }

    // Mark as approximate if multiple filters or cardinality was used
    if (filters.length > 1) {
      approximate = true;
    }

    return {
      count: totalCount,
      approximate,
    };
  }

  /**
   * Remove events matching the given filters (soft delete using deleted field).
   * Also soft-deletes any `replaced: true` historical versions matching the
   * same filter criteria via `updateByQuery`.
   */
  async remove(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const docIdsToDelete: string[] = [];

    for (const filter of filters) {
      if (opts?.signal?.aborted) {
        break;
      }

      try {
        const events = await this.queryFilter(filter, opts?.signal);

        for (const event of events) {
          docIdsToDelete.push(this.getDocumentId(event));
        }
      } catch (error) {
        console.error("Failed to query events for deletion:", error);
      }
    }

    // Remove duplicates
    const uniqueDocIds = [...new Set(docIdsToDelete)];

    // Soft delete all matching documents by setting deleted: true
    if (uniqueDocIds.length > 0) {
      const body: Array<Record<string, unknown>> = [];

      for (const docId of uniqueDocIds) {
        body.push({
          update: {
            _index: this.indexName,
            _id: docId,
          },
        });
        body.push({
          doc: { deleted: true },
        });
      }

      try {
        const response = await this.writeClient.bulk({
          body,
          refresh: true, // Refresh to make deletions visible immediately
          // @ts-expect-error: signal not in types but supported by underlying HTTP client
          signal: opts?.signal,
        });

        if (response.body.errors) {
          const erroredDocuments = response.body.items.filter(
            (item: Record<string, unknown>) =>
              (item.update as Record<string, unknown>)?.error,
          );
          console.error(
            `Bulk update had ${erroredDocuments.length} errors:`,
            erroredDocuments.slice(0, 5),
          );
        } else {
          console.log(`🗑️  Soft deleted ${uniqueDocIds.length} events`);
        }
      } catch (error) {
        console.error("Bulk update failed:", error);
        throw error;
      }
    }

    // Also soft-delete historical (replaced) versions matching these filters.
    for (const filter of filters) {
      if (opts?.signal?.aborted) break;
      try {
        const historyQuery = this.buildQuery(filter, { includeReplaced: true });
        const wrappedQuery = {
          bool: {
            must: [historyQuery, { term: { replaced: true } }],
          },
        };
        await this.writeClient.updateByQuery({
           index: this.indexName,
           body: {
             query: wrappedQuery,
             script: {
               source: "ctx._source.deleted = true",
               lang: "painless",
            },
          },
          refresh: true,
          conflicts: "proceed",
        });
      } catch (error) {
        console.error("Failed to delete historical versions:", error);
      }
    }
  }

  /** Custom analyzer settings for edge-ngram prefix matching on profile names. */
  // biome-ignore lint/suspicious/noExplicitAny: OpenSearch settings types are dynamic
  static readonly ANALYZER_SETTINGS: Record<string, any> = {
    analysis: {
      analyzer: {
        edge_ngram_analyzer: {
          type: "custom",
          tokenizer: "edge_ngram_tokenizer",
          filter: ["lowercase"],
        },
        url_analyzer: {
          type: "custom",
          tokenizer: "uax_url_email",
          filter: ["lowercase"],
        },
      },
      tokenizer: {
        edge_ngram_tokenizer: {
          type: "edge_ngram",
          min_gram: 2,
          max_gram: 20,
          token_chars: ["letter", "digit"],
        },
      },
    },
  };

  /** Mapping properties for the Nostr events index. */
  // biome-ignore lint/suspicious/noExplicitAny: OpenSearch client types are overly strict for dynamic mappings
  static readonly MAPPING_PROPERTIES: Record<string, any> = {
    id: { type: "keyword" },
    pubkey: { type: "keyword" },
    created_at: { type: "long" },
    kind: { type: "integer" },
    tags: {
      type: "object",
      enabled: false,
    },
    tags_map: {
      type: "object",
      dynamic: "true",
    },
    content: {
      type: "object",
      enabled: false,
    },
    search_text: {
      type: "text",
      analyzer: "standard",
      fields: {
        url: {
          type: "text",
          analyzer: "url_analyzer",
        },
      },
    },
    sig: { type: "keyword" },
    deleted: { type: "boolean" },
    replaced: { type: "boolean" },
    protocol: { type: "keyword" },
    amount_msats: { type: "long" },
    language: { type: "keyword" },
    sentiment: { type: "keyword" },
    media: { type: "boolean" },
    video: { type: "boolean" },
    metadata: {
      type: "object",
      properties: {
        name: {
          type: "text",
          analyzer: "edge_ngram_analyzer",
          search_analyzer: "standard",
        },
        display_name: {
          type: "text",
          analyzer: "edge_ngram_analyzer",
          search_analyzer: "standard",
        },
        nip05: { type: "keyword" },
        about: { type: "text", analyzer: "standard" },
      },
    },
    followers: { type: "integer" },
    engagers: { type: "integer" },
    comment_cnt: { type: "integer" },
    reaction_cnt: { type: "integer" },
    repost_cnt: { type: "integer" },
    quote_cnt: { type: "integer" },
    zap_amount_msats: { type: "long" },
    zap_cnt: { type: "integer" },
  };

  /**
   * Initialize OpenSearch index with mappings, or update mappings on an
   * existing index.
   *
   * OpenSearch's `putMapping` is additive — it only introduces new fields
   * and never removes or alters existing ones — so it is safe to call on
   * every startup. This ensures that newly added fields (e.g. `sentiment`)
   * are available on indices that were created before the field existed.
   */
  async migrate(): Promise<void> {
    try {
      // Check if index or alias already exists
      const exists =
        (await this.writeClient.indices.exists({ index: this.indexName })).body ||
        (await this.writeClient.indices.existsAlias({ name: this.indexName })).body;

      if (exists) {
        // Add custom analyzer settings (requires close/open).
        // This is idempotent — if the analyzer already exists, the close/open
        // is a harmless no-op that briefly pauses writes.
        try {
          await this.writeClient.indices.close({ index: this.indexName });
          await this.writeClient.indices.putSettings({
            index: this.indexName,
            body: { settings: OpenSearchRelay.ANALYZER_SETTINGS },
          });
          await this.writeClient.indices.open({ index: this.indexName });
          console.log(`Updated analyzer settings for index ${this.indexName}`);
        } catch (e) {
          // Ensure the index is reopened even if putSettings fails.
          try {
            await this.writeClient.indices.open({ index: this.indexName });
          } catch {
            // Already open or unrecoverable — ignore.
          }
          console.warn(
            "Warning: could not update analyzer settings (may already exist):",
            e,
          );
        }

        // Update mappings so any new fields are added to the existing index.
        // This may fail if field types changed (e.g. content: text → object),
        // which requires a full reindex to resolve. Non-fatal — the relay can
        // still operate on the existing mapping.
        try {
          await this.writeClient.indices.putMapping({
            index: this.indexName,
            body: {
              properties: OpenSearchRelay.MAPPING_PROPERTIES,
            },
          });
          console.log(`Updated mappings for index ${this.indexName}`);
        } catch (e) {
          console.warn(
            "Warning: could not update mappings (may need reindex):",
            e,
          );
        }
        return;
      }

      // Create index with full settings and mappings.
      await this.writeClient.indices.create({
        index: this.indexName,
        body: {
          settings: {
            "sort.field": "created_at",
            "sort.order": "desc",
            number_of_shards: 3,
            number_of_replicas: 1,
            "index.max_result_window": 100000,
            ...OpenSearchRelay.ANALYZER_SETTINGS,
          },
          mappings: {
            dynamic: "strict",
            dynamic_templates: [
              {
                tags_map_keyword: {
                  path_match: "tags_map.*",
                  mapping: { type: "keyword" },
                },
              },
            ],
            properties: OpenSearchRelay.MAPPING_PROPERTIES,
          },
        },
      });

      console.log(`✅ Created index ${this.indexName}`);
    } catch (error) {
      console.error("Failed to create index:", error);
      throw error;
    }
  }

  /**
   * Recompute engagement scores for dirty events.
   *
   * Drains the in-memory pending dirty sets (event IDs and followed
   * pubkeys accumulated by {@link collectDirtyReferences}), fetches the
   * corresponding documents from OpenSearch, aggregates their referencing
   * events to compute `followers`, `engagers`, `comment_cnt`, `reaction_cnt`,
   * `repost_cnt`, and `zap_amount_msats`, then writes the scores back.
   *
   * For kind 0 (profile) events, `followers` is set to the follower count:
   * the number of unique kind 3 (contact list) events whose `p` tags
   * include this profile's pubkey.
   *
   * Designed to be called periodically (e.g. via setInterval).
   * Returns the computed scores so callers (e.g. NIP-85) can publish them.
   */
  async recomputeScores(batchSize = 5000): Promise<RecomputeResult> {
    // Phase 1: Drain in-memory pending dirty sets and fetch the
    // corresponding events from OpenSearch. By now these documents have
    // been through multiple natural refresh cycles and are searchable.
    const pending = this.drainPendingDirty();

    if (pending.ids.size === 0 && pending.pubkeys.size === 0) {
      return { count: 0, userScores: new Map(), eventScores: new Map() };
    }

    type DirtyHit = { id: string; kind: number; pubkey: string };
    const searches: Promise<DirtyHit[]>[] = [];

    // (a) Events referenced by engagement events (by event ID).
    // Exclude replaced (historical) versions — scores only apply to the
    // current version of each event.
    if (pending.ids.size > 0) {
      searches.push(
        this.client
          .search({
            index: this.indexName,
            body: {
              query: {
                bool: {
                  must: [{ terms: { id: [...pending.ids] } }],
                  must_not: [{ term: { replaced: true } }],
                },
              },
              _source: ["id", "kind", "pubkey"],
              size: pending.ids.size,
            },
          })
          .then((r) => {
            const hits = r.body.hits.hits as Array<{ _source?: DirtyHit }>;
            return hits.filter((h) => h._source?.id).map((h) => h._source!);
          }),
      );
    }

    // (b) Kind 0 profiles for followed pubkeys from contact lists.
    if (pending.pubkeys.size > 0) {
      searches.push(
        this.client
          .search({
            index: this.indexName,
            body: {
              query: {
                bool: {
                  must: [
                    { term: { kind: 0 } },
                    { terms: { pubkey: [...pending.pubkeys] } },
                  ],
                  must_not: [{ term: { replaced: true } }],
                },
              },
              _source: ["id", "kind", "pubkey"],
              size: pending.pubkeys.size,
            },
          })
          .then((r) => {
            const hits = r.body.hits.hits as Array<{ _source?: DirtyHit }>;
            return hits.filter((h) => h._source?.id).map((h) => h._source!);
          }),
      );
    }

    const results = await Promise.all(searches);

    // Merge and deduplicate all dirty hits.
    const seen = new Set<string>();
    const dirtyKind0: Array<{ id: string; pubkey: string }> = [];
    const dirtyNonKind0Ids: string[] = [];

    for (const hits of results) {
      for (const hit of hits) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        if (hit.kind === 0) {
          dirtyKind0.push({ id: hit.id, pubkey: hit.pubkey });
        } else {
          dirtyNonKind0Ids.push(hit.id);
        }
      }
    }

    const allDirtyIds = [...dirtyKind0.map((d) => d.id), ...dirtyNonKind0Ids];

    if (allDirtyIds.length === 0) {
      return { count: 0, userScores: new Map(), eventScores: new Map() };
    }

    // Build score maps — initialize all dirty IDs with zeros.
    const scores = new Map<
      string,
      {
        followers: number;
        engagers: number;
        comment_cnt: number;
        reaction_cnt: number;
        repost_cnt: number;
        quote_cnt: number;
        zap_amount_msats: number;
        zap_cnt: number;
      }
    >();

    for (const id of allDirtyIds) {
      scores.set(id, {
        followers: 0,
        engagers: 0,
        comment_cnt: 0,
        reaction_cnt: 0,
        repost_cnt: 0,
        quote_cnt: 0,
        zap_amount_msats: 0,
        zap_cnt: 0,
      });
    }

    // Phase 2a: Compute follower counts for dirty kind 0 events.
    if (dirtyKind0.length > 0) {
      const kind0Pubkeys = dirtyKind0.map((d) => d.pubkey);

      // Count unique kind 3 events that p-tag each pubkey.
      const followerResponse = await this.client.search({
        index: this.indexName,
        body: {
          query: {
            bool: {
              must: [
                { term: { deleted: false } },
                { term: { replaced: false } },
                { term: { kind: 3 } },
                { terms: { "tags_map.p": kind0Pubkeys } },
              ],
            },
          },
          size: 0,
          aggs: {
            by_pubkey: {
              terms: {
                field: "tags_map.p",
                size: kind0Pubkeys.length,
                include: kind0Pubkeys,
              },
            },
          },
        },
      });

      const followerBuckets =
        (
          followerResponse.body.aggregations?.by_pubkey as unknown as {
            buckets?: Array<{ key: string; doc_count: number }>;
          }
        )?.buckets || [];

      // Map pubkey → follower count.
      const followerCounts = new Map<string, number>();
      for (const bucket of followerBuckets) {
        followerCounts.set(bucket.key, bucket.doc_count);
      }

      // Set followers count for each kind 0 event.
      for (const { id, pubkey } of dirtyKind0) {
        const s = scores.get(id);
        if (s) {
          s.followers = followerCounts.get(pubkey) ?? 0;
        }
      }
    }

    // Phase 2b: Aggregate engagement referencing events (kinds 1/6/7/16/1111)
    // scoped to just the non-kind-0 dirty event IDs.
    if (dirtyNonKind0Ids.length > 0) {
      const engagementResponse = await this.client.search({
        index: this.indexName,
        body: {
          query: {
            bool: {
              must: [
                { term: { deleted: false } },
                { term: { replaced: false } },
                { terms: { kind: [1, 6, 7, 16, 1111] } },
                { terms: { "tags_map.e": dirtyNonKind0Ids } },
              ],
            },
          },
          size: 0,
          aggs: {
            by_event: {
              terms: {
                field: "tags_map.e",
                size: dirtyNonKind0Ids.length,
                include: dirtyNonKind0Ids,
              },
              aggs: {
                unique_authors: {
                  cardinality: { field: "pubkey" },
                },
                by_kind: {
                  terms: { field: "kind", size: 10 },
                },
              },
            },
          },
        },
      });

      const engagementBuckets =
        (
          engagementResponse.body.aggregations?.by_event as unknown as {
            buckets?: Array<{
              key: string;
              doc_count: number;
              unique_authors?: { value: number };
              by_kind?: {
                buckets?: Array<{ key: number; doc_count: number }>;
              };
            }>;
          }
        )?.buckets || [];

      for (const bucket of engagementBuckets) {
        const s = scores.get(bucket.key);
        if (!s) continue;

        s.engagers = bucket.unique_authors?.value ?? 0;

        for (const kb of bucket.by_kind?.buckets || []) {
          switch (kb.key) {
            case 1:
            case 1111:
              s.comment_cnt += kb.doc_count;
              break;
            case 7:
              s.reaction_cnt += kb.doc_count;
              break;
            case 6:
            case 16:
              s.repost_cnt += kb.doc_count;
              break;
          }
        }
      }

      // Phase 3: Aggregate zap amounts (kind 9735) separately.
      const zapResponse = await this.client.search({
        index: this.indexName,
        body: {
          query: {
            bool: {
              must: [
                { term: { deleted: false } },
                { term: { replaced: false } },
                { term: { kind: 9735 } },
                { terms: { "tags_map.e": dirtyNonKind0Ids } },
              ],
            },
          },
          size: 0,
          aggs: {
            by_event: {
              terms: {
                field: "tags_map.e",
                size: dirtyNonKind0Ids.length,
                include: dirtyNonKind0Ids,
              },
              aggs: {
                total_msats: {
                  sum: { field: "amount_msats" },
                },
              },
            },
          },
        },
      });

      const zapBuckets =
        (
          zapResponse.body.aggregations?.by_event as unknown as {
            buckets?: Array<{
              key: string;
              doc_count: number;
              total_msats?: { value: number };
            }>;
          }
        )?.buckets || [];

      for (const bucket of zapBuckets) {
        const s = scores.get(bucket.key);
        if (s) {
          s.zap_amount_msats = bucket.total_msats?.value ?? 0;
          s.zap_cnt = bucket.doc_count;
        }
      }

      // Phase 3b: Aggregate quote reposts (kind 1 events referencing via `q` tag).
      const quoteResponse = await this.client.search({
        index: this.indexName,
        body: {
          query: {
            bool: {
              must: [
                { term: { deleted: false } },
                { term: { replaced: false } },
                { term: { kind: 1 } },
                { terms: { "tags_map.q": dirtyNonKind0Ids } },
              ],
            },
          },
          size: 0,
          aggs: {
            by_event: {
              terms: {
                field: "tags_map.q",
                size: dirtyNonKind0Ids.length,
                include: dirtyNonKind0Ids,
              },
            },
          },
        },
      });

      const quoteBuckets =
        (
          quoteResponse.body.aggregations?.by_event as unknown as {
            buckets?: Array<{
              key: string;
              doc_count: number;
            }>;
          }
        )?.buckets || [];

      for (const bucket of quoteBuckets) {
        const s = scores.get(bucket.key);
        if (s) {
          s.quote_cnt = bucket.doc_count;
        }
      }
    }

    // Phase 4: Bulk update the dirty events with computed scores.
    const body: Array<Record<string, unknown>> = [];

    for (const [id, s] of scores) {
      body.push({
        update: {
          _index: this.indexName,
          _id: id,
        },
      });
      body.push({
        doc: {
          followers: s.followers,
          engagers: s.engagers,
          comment_cnt: s.comment_cnt,
          reaction_cnt: s.reaction_cnt,
          repost_cnt: s.repost_cnt,
          quote_cnt: s.quote_cnt,
          zap_amount_msats: s.zap_amount_msats,
          zap_cnt: s.zap_cnt,
        },
      });
    }

    if (body.length > 0) {
      const updateResponse = await this.writeClient.bulk({
        body,
        refresh: false,
      });

      // Some bulk updates may still fail for unexpected reasons.
      if (updateResponse.body.errors) {
        const items: Array<
          Record<string, { error?: unknown; status?: number }>
        > = updateResponse.body.items;

        for (let i = 0; i < items.length; i++) {
          const result = items[i].update;
          if (result?.error) {
            console.warn(
              `Score update failed for doc:`,
              JSON.stringify(result.error),
            );
          }
        }
      }
    }

    const kind0Count = dirtyKind0.length;
    const nonKind0Count = dirtyNonKind0Ids.length;
    console.log(
      `Recomputed scores for ${allDirtyIds.length} events (${kind0Count} profiles, ${nonKind0Count} engagement)`,
    );

    // Build result maps for callers (e.g. NIP-85 publisher).
    const userScores = new Map<string, { followers: number }>();
    for (const { id, pubkey } of dirtyKind0) {
      const s = scores.get(id);
      if (s) {
        userScores.set(pubkey, { followers: s.followers });
      }
    }

    const eventScores = new Map<string, EventScores>();
    for (const id of dirtyNonKind0Ids) {
      const s = scores.get(id);
      if (s) {
        eventScores.set(id, {
          comment_cnt: s.comment_cnt,
          reaction_cnt: s.reaction_cnt,
          repost_cnt: s.repost_cnt,
          quote_cnt: s.quote_cnt,
          zap_amount_msats: s.zap_amount_msats,
          zap_cnt: s.zap_cnt,
        });
      }
    }

    return { count: allDirtyIds.length, userScores, eventScores };
  }

  /**
   * Flush remaining events and close the OpenSearch connection(s).
   */
  async close(): Promise<void> {
    await this.flush();
    await this.client.close();
    if (this.writeClient !== this.client) {
      await this.writeClient.close();
    }
  }

  /**
   * Dispose resources
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
