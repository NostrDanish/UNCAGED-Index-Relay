import type {
  NostrEvent,
  NostrFilter,
  NostrRelayCLOSED,
  NostrRelayEOSE,
  NostrRelayEVENT,
  NRelay,
} from "@nostrify/nostrify";
import { NIP50, NKinds } from "@nostrify/nostrify";
import type { Client, ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { naddrEncode, noteEncode } from "nostr-tools/nip19";
import type { Config } from "./config.ts";
import { detectMedia } from "./media.ts";

/**
 * OpenSearch document structure for Nostr events
 */
interface NostrEventDocument extends NostrEvent {
  tags_map: Record<string, string[]>;
  deleted?: boolean;
  protocol?: string;
  amount_msats?: number;
  language?: string;
  sentiment?: string;
  media: boolean;
  video: boolean;
  /** Unique authors who referenced this event (replies, reposts, reactions). */
  top_score: number;
  /** Count of kind 1/1111 referencing events. */
  reply_count: number;
  /** Count of kind 7 referencing events. */
  reaction_count: number;
  /** Count of kind 6/16 referencing events. */
  repost_count: number;
  /** Sum of amount_msats from kind 9735 zap receipts referencing this event. */
  zap_amount_msats: number;
  /** Whether engagement scores need recomputation. */
  scores_dirty: boolean;
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
  private client: Client;
  private indexName: string;

  /** Bulk indexing queue. */
  private bulkQueue: BulkEntry[] = [];
  private bulkTimer: ReturnType<typeof setTimeout> | null = null;
  private bulkMaxSize: number;
  private bulkFlushMs: number;

  constructor(
    client: Client,
    opts?: { indexName?: string; bulkMaxSize?: number; bulkFlushMs?: number },
  ) {
    this.client = client;
    this.indexName = opts?.indexName || "nostr-events";
    this.bulkMaxSize = opts?.bulkMaxSize ?? 100;
    this.bulkFlushMs = opts?.bulkFlushMs ?? 200;
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
    return new OpenSearchRelay(client, { indexName: config.opensearchIndex });
  }

  /** Tag name must be alphanumeric (plus hyphens and underscores) and at most 15 characters. */
  private static TAG_NAME_RE = /^[\w-]{1,15}$/;
  /** Maximum length of a single tag value stored in tags_map. */
  private static TAG_VALUE_MAX_LENGTH = 255;

  /**
   * Build tags_map from tags array.
   *
   * Validates tag names and values:
   * - Tag names must be alphanumeric (including hyphens) and ≤ 15 characters.
   *   Names that don't match are omitted entirely.
   * - Tag values must be ≤ 255 characters. Values that exceed the limit are
   *   skipped, but the tag name key is still created (with an empty array if
   *   no values pass).
   */
  private buildTagsMap(tags: string[][]): Record<string, string[]> {
    const tagsMap: Record<string, string[]> = {};

    for (const tag of tags) {
      if (tag.length >= 2) {
        const [tagName, value] = tag;

        if (!OpenSearchRelay.TAG_NAME_RE.test(tagName)) {
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

    return tagsMap;
  }

  /**
   * Generate OpenSearch document ID for an event using NIP-19 encoding
   * - Regular events: note1... (noteEncode)
   * - Replaceable events: naddr1... with kind:pubkey
   * - Addressable events: naddr1... with kind:pubkey:d-tag
   */
  private getDocumentId(event: NostrEvent): string {
    if (NKinds.replaceable(event.kind)) {
      return naddrEncode({
        kind: event.kind,
        pubkey: event.pubkey,
        identifier: "", // Empty identifier for non-parameterized replaceable events
      });
    }

    if (NKinds.addressable(event.kind)) {
      const identifier = event.tags.find(([name]) => name === "d")?.[1] || "";
      return naddrEncode({
        kind: event.kind,
        pubkey: event.pubkey,
        identifier,
      });
    }

    // All other events -> note1 (encoded event ID)
    return noteEncode(event.id);
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
   * Convert NostrEvent to OpenSearch document.
   * When `analysis` is provided (from the worker pool), those pre-computed
   * values are used directly instead of detecting on the main thread.
   */
  private eventToDocument(
    event: NostrEvent,
    analysis?: {
      language?: string;
      sentiment?: string;
      media?: boolean;
      video?: boolean;
    },
  ): NostrEventDocument {
    const tagsMap = this.buildTagsMap(event.tags);

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

    return {
      ...event,
      tags_map: tagsMap,
      deleted: false,
      ...(protocol && { protocol }),
      ...(amount_msats !== undefined && { amount_msats }),
      ...(language && { language }),
      ...(sentiment && { sentiment }),
      media: mediaResult.media ?? false,
      video: mediaResult.video ?? false,
      top_score: 0,
      reply_count: 0,
      reaction_count: 0,
      repost_count: 0,
      zap_amount_msats: 0,
      scores_dirty: false,
    };
  }

  /**
   * Convert OpenSearch document back to NostrEvent
   */
  private documentToEvent(doc: NostrEventDocument): NostrEvent {
    return {
      id: doc.id,
      pubkey: doc.pubkey,
      created_at: doc.created_at,
      kind: doc.kind,
      tags: doc.tags,
      content: doc.content,
      sig: doc.sig,
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

    return null;
  }

  /**
   * Query events using precomputed engagement scores.
   *
   * Each sort mode uses the building-block score fields (top_score,
   * reply_count, reaction_count, repost_count, zap_amount_msats) that
   * are maintained by the background recomputeScores() job. Filters
   * are applied directly in the query, so results are correct for any
   * filter narrowing (kinds, tags, full-text search, etc.).
   */
  private async querySortedEvents(
    filter: NostrFilter,
    sortMode: "top" | "hot" | "controversial" | "rising" | "zaps",
    limit: number,
  ): Promise<NostrEvent[]> {
    try {
      let events: NostrEvent[];

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
        (hit: { _source?: NostrEventDocument }) => hit._source !== undefined,
      )
      .map((hit: { _source: NostrEventDocument }) =>
        this.documentToEvent(hit._source),
      );
  }

  /**
   * Query top events — sorted by precomputed `top_score` (unique authors
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
    query.bool.must.push({ range: { top_score: { gt: 0 } } });

    const response = await this.client.search({
      index: this.indexName,
      body: {
        query,
        sort: [{ top_score: { order: "desc" as const } }],
        size: limit,
      },
    });

    return this.hitsToEvents(response);
  }

  /**
   * Query hot events — top_score weighted by exponential time decay.
   * Score = top_score * 0.5^(age_in_hours / 24).
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
    query.bool.must.push({ range: { top_score: { gt: 0 } } });

    const response = await this.client.search({
      index: this.indexName,
      body: {
        query: {
          script_score: {
            query,
            script: {
              source: `
                double topScore = doc['top_score'].value;
                double ageHours = (params.now - doc['created_at'].value) / 3600.0;
                return topScore * Math.pow(0.5, ageHours / 24.0);
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
   * Query controversial events — high engagement with balanced replies
   * vs reactions. Score = min(reply_count, reaction_count) * sqrt(total).
   */
  private async querySortControversial(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const query = this.buildQuery(filter) as {
      bool: { must: Record<string, unknown>[] };
    };
    // Require at least one reply AND one reaction for controversy
    query.bool.must.push({ range: { reply_count: { gt: 0 } } });
    query.bool.must.push({ range: { reaction_count: { gt: 0 } } });

    const response = await this.client.search({
      index: this.indexName,
      body: {
        query: {
          script_score: {
            query,
            script: {
              source: `
                double replies = doc['reply_count'].value;
                double reactions = doc['reaction_count'].value;
                double balanced = Math.min(replies, reactions);
                return balanced * Math.sqrt(replies + reactions);
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
   * Score = (reply_count + reaction_count + repost_count) / age_in_hours.
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
    query.bool.must.push({ range: { top_score: { gt: 0 } } });

    const response = await this.client.search({
      index: this.indexName,
      body: {
        query: {
          script_score: {
            query,
            script: {
              source: `
                double total = doc['reply_count'].value + doc['reaction_count'].value + doc['repost_count'].value;
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
        query,
        sort: [{ zap_amount_msats: { order: "desc" as const } }],
        size: limit,
      },
    });

    return this.hitsToEvents(response);
  }

  /**
   * Build OpenSearch query from Nostr filter
   */
  private buildQuery(filter: NostrFilter): Record<string, unknown> {
    const must: Record<string, unknown>[] = [
      { term: { deleted: false } }, // Always exclude deleted events
    ];
    const mustNot: Record<string, unknown>[] = [];

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
    }

    // Time range filters
    if (filter.since || filter.until) {
      const range: Record<string, number> = {};
      if (filter.since) range.gte = filter.since;
      if (filter.until) range.lte = filter.until;
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
      const searchText = tokens.filter((t) => typeof t === "string").join(" ");

      if (searchText.trim()) {
        must.push({
          match: {
            content: {
              query: searchText,
              operator: "and",
            },
          },
        });
      }

      // Handle protocol: extension (NIP-48 + NIP-50)
      const protocolToken = tokens.find(
        (t) => typeof t === "object" && t.key === "protocol",
      );
      if (protocolToken && typeof protocolToken === "object") {
        must.push({
          term: { protocol: protocolToken.value },
        });
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
      return this.querySortedEvents(filter, sortMode, limit);
    }

    const query = this.buildQuery(filter);
    const distinctAuthor = this.hasDistinctAuthor(filter);

    // Sort by created_at (newest first)
    const sort = [{ created_at: { order: "desc" as const } }];

    try {
      const searchBody: Record<string, unknown> = {
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

      const hits = response.body.hits.hits;
      return hits
        .filter((hit) => hit._source !== undefined)
        .map((hit) => this.documentToEvent(hit._source as NostrEventDocument));
    } catch (error) {
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

      if (this.bulkQueue.length >= this.bulkMaxSize) {
        this.flush();
      } else if (!this.bulkTimer) {
        this.bulkTimer = setTimeout(() => this.flush(), this.bulkFlushMs);
      }
    });
  }

  /**
   * Flush the bulk queue to OpenSearch.
   */
  async flush(): Promise<void> {
    if (this.bulkTimer) {
      clearTimeout(this.bulkTimer);
      this.bulkTimer = null;
    }

    if (this.bulkQueue.length === 0) return;

    const entries = this.bulkQueue.splice(0);
    const body: Array<Record<string, unknown>> = [];

    const replaceable_upsert_script = `
      if (ctx._source.deleted == true) {
        ctx.op = 'none';
      } else if (params.event.created_at > ctx._source.created_at) {
        ctx._source = params.event;
      } else if (params.event.created_at == ctx._source.created_at && 
                 params.event.id.compareTo(ctx._source.id) < 0) {
        ctx._source = params.event;
      } else {
        ctx.op = 'none';
      }
    `;

    for (const entry of entries) {
      if (
        NKinds.replaceable(entry.event.kind) ||
        NKinds.addressable(entry.event.kind)
      ) {
        // Scripted upsert for replaceable/addressable events
        body.push({
          update: { _index: this.indexName, _id: entry.docId },
        });
        body.push({
          script: {
            source: replaceable_upsert_script,
            lang: "painless",
            params: { event: entry.doc },
          },
          upsert: entry.doc,
        });
      } else {
        // Regular index
        body.push({
          index: { _index: this.indexName, _id: entry.docId },
        });
        body.push(entry.doc as unknown as Record<string, unknown>);
      }
    }

    try {
      const response = await this.client.bulk({ body, refresh: false });

      if (response.body.errors) {
        // Resolve/reject individual entries based on per-item results
        const items: Array<Record<string, { error?: unknown }>> =
          response.body.items;
        for (let i = 0; i < entries.length; i++) {
          const item = items[i];
          const result =
            (item.index as { error?: unknown } | undefined) ??
            (item.update as { error?: unknown } | undefined);
          if (result?.error) {
            entries[i].reject(
              new Error(`Bulk index failed: ${JSON.stringify(result.error)}`),
            );
          } else {
            entries[i].resolve();
          }
        }
      } else {
        for (const entry of entries) {
          entry.resolve();
        }
      }

      // Mark referenced events as scores_dirty when referencing events are indexed.
      // Referencing kinds: 1, 6, 7, 16, 1111 (engagement), 9735 (zaps).
      this.markReferencedEventsDirty(entries).catch((err) => {
        console.error("Failed to mark referenced events dirty:", err);
      });
    } catch (error) {
      // Entire bulk request failed — reject all entries
      const err = error instanceof Error ? error : new Error(String(error));
      for (const entry of entries) {
        entry.reject(err);
      }
    }
  }

  /** Kinds whose `e`-tag references affect engagement scores. */
  private static REFERENCING_KINDS = new Set([1, 6, 7, 16, 1111, 9735]);

  /**
   * After indexing referencing events, mark the target events they reference
   * as needing score recomputation by setting `scores_dirty: true`.
   */
  private async markReferencedEventsDirty(entries: BulkEntry[]): Promise<void> {
    const referencedIds = new Set<string>();

    for (const entry of entries) {
      if (!OpenSearchRelay.REFERENCING_KINDS.has(entry.event.kind)) continue;

      for (const tag of entry.event.tags) {
        if (tag[0] === "e" && tag[1]) {
          referencedIds.add(tag[1]);
        }
      }
    }

    if (referencedIds.size === 0) return;

    // Use update_by_query to set scores_dirty=true on all referenced events
    // in a single server-side operation (no round-trip for document IDs).
    await this.client.updateByQuery({
      index: this.indexName,
      body: {
        query: {
          bool: {
            must: [
              { terms: { id: [...referencedIds] } },
              { term: { scores_dirty: false } },
            ],
          },
        },
        script: {
          source: "ctx._source.scores_dirty = true",
          lang: "painless",
        },
      },
      // Don't wait for completion or refresh — this is best-effort and
      // the background job will catch anything missed.
      refresh: false,
      conflicts: "proceed",
    });
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
          // Use cardinality aggregation for distinct author count
          const response = await this.client.search({
            index: this.indexName,
            body: {
              query,
              size: 0,
              aggs: {
                unique_authors: {
                  cardinality: { field: "pubkey" },
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
   * Remove events matching the given filters (soft delete using deleted field)
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
        // Query events matching the filter
        const events = await this.queryFilter(filter, opts?.signal);

        // Get document IDs for matched events
        for (const event of events) {
          const docId = this.getDocumentId(event);
          docIdsToDelete.push(docId);
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
        const response = await this.client.bulk({
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
  }

  /** Mapping properties for the Nostr events index. */
  // biome-ignore lint/suspicious/noExplicitAny: OpenSearch client types are overly strict for dynamic mappings
  private static MAPPING_PROPERTIES: Record<string, any> = {
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
      type: "text",
      analyzer: "standard",
    },
    sig: { type: "keyword" },
    deleted: { type: "boolean" },
    protocol: { type: "keyword" },
    amount_msats: { type: "long" },
    language: { type: "keyword" },
    sentiment: { type: "keyword" },
    media: { type: "boolean" },
    video: { type: "boolean" },
    top_score: { type: "integer" },
    reply_count: { type: "integer" },
    reaction_count: { type: "integer" },
    repost_count: { type: "integer" },
    zap_amount_msats: { type: "long" },
    scores_dirty: { type: "boolean" },
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
        (await this.client.indices.exists({ index: this.indexName })).body ||
        (await this.client.indices.existsAlias({ name: this.indexName })).body;

      if (exists) {
        // Update mappings so any new fields are added to the existing index.
        await this.client.indices.putMapping({
          index: this.indexName,
          body: {
            properties: OpenSearchRelay.MAPPING_PROPERTIES,
          },
        });
        console.log(`Updated mappings for index ${this.indexName}`);
        return;
      }

      // Create index with full settings and mappings.
      await this.client.indices.create({
        index: this.indexName,
        body: {
          settings: {
            number_of_shards: 3,
            number_of_replicas: 1,
            "index.max_result_window": 100000,
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
   * Recompute engagement scores for events marked as dirty.
   *
   * Finds events where `scores_dirty: true`, aggregates their referencing
   * events to compute `top_score`, `reply_count`, `reaction_count`,
   * `repost_count`, and `zap_amount_msats`, then writes the scores back
   * and clears the dirty flag.
   *
   * Designed to be called periodically (e.g. via setInterval).
   * Returns the number of events whose scores were updated.
   */
  async recomputeScores(batchSize = 5000): Promise<number> {
    // Phase 1: Find dirty event IDs.
    const dirtyResponse = await this.client.search({
      index: this.indexName,
      body: {
        query: {
          bool: {
            must: [{ term: { scores_dirty: true } }],
          },
        },
        _source: ["id"],
        size: batchSize,
      },
    });

    const dirtyHits = dirtyResponse.body.hits.hits as unknown as Array<{
      _source?: { id: string };
    }>;
    if (dirtyHits.length === 0) return 0;

    const dirtyIds = dirtyHits
      .filter((h) => h._source?.id)
      .map((h) => h._source?.id as string);

    // Phase 2: Aggregate engagement referencing events (kinds 1/6/7/16/1111)
    // scoped to just these dirty event IDs.
    const engagementResponse = await this.client.search({
      index: this.indexName,
      body: {
        query: {
          bool: {
            must: [
              { term: { deleted: false } },
              { terms: { kind: [1, 6, 7, 16, 1111] } },
              { terms: { "tags_map.e": dirtyIds } },
            ],
          },
        },
        size: 0,
        aggs: {
          by_event: {
            terms: {
              field: "tags_map.e",
              size: dirtyIds.length,
              // Include only the dirty IDs in the aggregation
              include: dirtyIds,
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

    // Phase 3: Aggregate zap amounts (kind 9735) separately.
    const zapResponse = await this.client.search({
      index: this.indexName,
      body: {
        query: {
          bool: {
            must: [
              { term: { deleted: false } },
              { term: { kind: 9735 } },
              { terms: { "tags_map.e": dirtyIds } },
            ],
          },
        },
        size: 0,
        aggs: {
          by_event: {
            terms: {
              field: "tags_map.e",
              size: dirtyIds.length,
              include: dirtyIds,
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

    // Build score maps.
    const scores = new Map<
      string,
      {
        top_score: number;
        reply_count: number;
        reaction_count: number;
        repost_count: number;
        zap_amount_msats: number;
      }
    >();

    // Initialize all dirty IDs with zeros (events with no references get 0 scores).
    for (const id of dirtyIds) {
      scores.set(id, {
        top_score: 0,
        reply_count: 0,
        reaction_count: 0,
        repost_count: 0,
        zap_amount_msats: 0,
      });
    }

    // Fill in engagement scores.
    for (const bucket of engagementBuckets) {
      const s = scores.get(bucket.key);
      if (!s) continue;

      s.top_score = bucket.unique_authors?.value ?? 0;

      for (const kb of bucket.by_kind?.buckets || []) {
        switch (kb.key) {
          case 1:
          case 1111:
            s.reply_count += kb.doc_count;
            break;
          case 7:
            s.reaction_count += kb.doc_count;
            break;
          case 6:
          case 16:
            s.repost_count += kb.doc_count;
            break;
        }
      }
    }

    // Fill in zap amounts.
    for (const bucket of zapBuckets) {
      const s = scores.get(bucket.key);
      if (s) {
        s.zap_amount_msats = bucket.total_msats?.value ?? 0;
      }
    }

    // Phase 4: Bulk update the dirty events with computed scores.
    const body: Array<Record<string, unknown>> = [];

    for (const [id, s] of scores) {
      body.push({
        update: {
          _index: this.indexName,
          _id: noteEncode(id),
        },
      });
      body.push({
        doc: {
          top_score: s.top_score,
          reply_count: s.reply_count,
          reaction_count: s.reaction_count,
          repost_count: s.repost_count,
          zap_amount_msats: s.zap_amount_msats,
          scores_dirty: false,
        },
      });
    }

    if (body.length > 0) {
      const updateResponse = await this.client.bulk({
        body,
        refresh: false,
      });

      // Some updates may fail if the doc ID doesn't match (e.g. replaceable
      // events use naddr encoding). Fall back to update_by_query for those.
      if (updateResponse.body.errors) {
        const failedIds: string[] = [];
        const items: Array<
          Record<string, { error?: unknown; status?: number }>
        > = updateResponse.body.items;

        for (let i = 0; i < items.length; i++) {
          const result = items[i].update;
          if (result?.error) {
            failedIds.push(dirtyIds[i]);
          }
        }

        // Batch-clear dirty flag for failed IDs using a single Painless
        // script that looks up each event's scores from a params map.
        if (failedIds.length > 0) {
          const scoreParams: Record<
            string,
            {
              top_score: number;
              reply_count: number;
              reaction_count: number;
              repost_count: number;
              zap_amount_msats: number;
            }
          > = {};
          for (const id of failedIds) {
            const s = scores.get(id);
            if (s) scoreParams[id] = s;
          }

          await this.client.updateByQuery({
            index: this.indexName,
            body: {
              query: { terms: { id: failedIds } },
              script: {
                source: `
                  def s = params.scores.get(ctx._source.id);
                  if (s != null) {
                    ctx._source.top_score = s.top_score;
                    ctx._source.reply_count = s.reply_count;
                    ctx._source.reaction_count = s.reaction_count;
                    ctx._source.repost_count = s.repost_count;
                    ctx._source.zap_amount_msats = s.zap_amount_msats;
                    ctx._source.scores_dirty = false;
                  }
                `,
                lang: "painless",
                params: { scores: scoreParams },
              },
            },
            refresh: false,
            conflicts: "proceed",
          });
        }
      }
    }

    const withEngagement = engagementBuckets.length + zapBuckets.length;
    console.log(
      `Recomputed scores for ${dirtyIds.length} events (${withEngagement} with engagement)`,
    );

    return dirtyIds.length;
  }

  /**
   * Flush remaining events and close the OpenSearch connection.
   */
  async close(): Promise<void> {
    await this.flush();
    await this.client.close();
  }

  /**
   * Dispose resources
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
