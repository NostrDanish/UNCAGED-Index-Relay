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

/**
 * OpenSearch document structure for Nostr events
 */
interface NostrEventDocument extends NostrEvent {
  tags_map: Record<string, string[]>;
  deleted?: boolean;
  protocol?: string;
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
   * Convert NostrEvent to OpenSearch document
   */
  private eventToDocument(event: NostrEvent): NostrEventDocument {
    const tagsMap = this.buildTagsMap(event.tags);

    // Extract protocol from proxy tag (NIP-48)
    // Format: ["proxy", <id>, <protocol>]
    const proxyTag = event.tags.find(
      (tag) => tag[0] === "proxy" && tag.length >= 3,
    );
    const protocol = proxyTag?.[2];

    return {
      ...event,
      tags_map: tagsMap,
      deleted: false,
      ...(protocol && { protocol }),
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
   * Query events with NIP-50 sort algorithms using aggregation-first approach.
   *
   * Each sort mode aggregates referencing events (with the appropriate time
   * window on the *referencing* events, not the targets), fetches the
   * referenced events applying the user's filter, then scores and sorts.
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
   * Fetch target events by IDs, applying the user's filter constraints.
   * Returns a map of event ID to NostrEvent for events that pass the filter.
   */
  private async fetchTargetEvents(
    eventIds: string[],
    filter: NostrFilter,
  ): Promise<Map<string, NostrEvent>> {
    const query = this.buildQuery(filter) as {
      bool: { must: Record<string, unknown>[] };
    };
    query.bool.must.push({ terms: { id: eventIds } });

    const response = await this.client.search({
      index: this.indexName,
      body: {
        query,
        size: Math.min(eventIds.length, 5000),
      },
    });

    const eventsById = new Map<string, NostrEvent>();
    for (const hit of response.body.hits.hits) {
      const h = hit as { _source?: NostrEventDocument };
      if (h._source) {
        const event = this.documentToEvent(h._source);
        eventsById.set(event.id, event);
      }
    }
    return eventsById;
  }

  /**
   * Query top events — most referenced of all time.
   * Scored by doc_count (total references).
   */
  private async querySortTop(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const bucketCount = Math.max(limit * 10, 1000);

    // Aggregate referencing events (no time window — all time)
    const aggMust: Record<string, unknown>[] = [
      { term: { deleted: false } },
      { terms: { kind: [1, 6, 7, 16, 1111] } },
    ];

    // If the user specified a time range, apply it to referencing events
    if (filter.since || filter.until) {
      const range: Record<string, number> = {};
      if (filter.since) range.gte = filter.since;
      if (filter.until) range.lte = filter.until;
      aggMust.push({ range: { created_at: range } });
    }

    const response = await this.client.search({
      index: this.indexName,
      body: {
        query: { bool: { must: aggMust } },
        size: 0,
        aggs: {
          by_event: {
            terms: {
              field: "tags_map.e",
              size: bucketCount,
              order: { _count: "desc" as const },
            },
          },
        },
      },
    });

    const buckets =
      (
        response.body.aggregations?.by_event as unknown as {
          buckets?: Array<{ key: string; doc_count: number }>;
        }
      )?.buckets || [];

    if (buckets.length === 0) return [];

    const refCountMap = new Map(buckets.map((b) => [b.key, b.doc_count]));
    const eventIds = buckets.map((b) => b.key);

    const eventsById = await this.fetchTargetEvents(eventIds, filter);
    if (eventsById.size === 0) return [];

    return [...eventsById.values()].sort(
      (a, b) => (refCountMap.get(b.id) || 0) - (refCountMap.get(a.id) || 0),
    );
  }

  /**
   * Query hot events — most engagement in a recent time window.
   * Time window is applied to the **referencing events**, not the targets.
   * Score = doc_count * decay_factor (half-life of 24 hours based on target age).
   */
  private async querySortHot(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const now = Math.floor(Date.now() / 1000);
    const bucketCount = Math.max(limit * 10, 1000);
    const timeWindow = 7 * 24 * 60 * 60; // 7 days

    const since = filter.since || now - timeWindow;
    const until = filter.until || now;

    const response = await this.client.search({
      index: this.indexName,
      body: {
        query: {
          bool: {
            must: [
              { term: { deleted: false } },
              { terms: { kind: [1, 6, 7, 16, 1111] } },
              { range: { created_at: { gte: since, lte: until } } },
            ],
          },
        },
        size: 0,
        aggs: {
          by_event: {
            terms: {
              field: "tags_map.e",
              size: bucketCount,
              order: { _count: "desc" as const },
            },
          },
        },
      },
    });

    const buckets =
      (
        response.body.aggregations?.by_event as unknown as {
          buckets?: Array<{ key: string; doc_count: number }>;
        }
      )?.buckets || [];

    if (buckets.length === 0) return [];

    const refCountMap = new Map(buckets.map((b) => [b.key, b.doc_count]));
    const eventIds = buckets.map((b) => b.key);

    const eventsById = await this.fetchTargetEvents(eventIds, filter);
    if (eventsById.size === 0) return [];

    // Score: doc_count * exponential decay (half-life 24h)
    return [...eventsById.values()]
      .map((event) => {
        const refCount = refCountMap.get(event.id) || 0;
        const ageInHours = (now - event.created_at) / 3600;
        const score = refCount * 0.5 ** (ageInHours / 24);
        return { event, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((item) => item.event);
  }

  /**
   * Query controversial events — high engagement with mixed reaction types.
   * Time window is applied to referencing events. Score rewards events
   * with balanced replies vs reactions.
   */
  private async querySortControversial(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const now = Math.floor(Date.now() / 1000);
    const bucketCount = Math.max(limit * 10, 1000);
    const timeWindow = 7 * 24 * 60 * 60; // 7 days

    const since = filter.since || now - timeWindow;
    const until = filter.until || now;

    const response = await this.client.search({
      index: this.indexName,
      body: {
        query: {
          bool: {
            must: [
              { term: { deleted: false } },
              { terms: { kind: [1, 6, 7, 16, 1111] } },
              { range: { created_at: { gte: since, lte: until } } },
            ],
          },
        },
        size: 0,
        aggs: {
          by_event: {
            terms: {
              field: "tags_map.e",
              size: bucketCount,
            },
            aggs: {
              by_kind: {
                terms: { field: "kind", size: 20 },
              },
            },
          },
        },
      },
    });

    const buckets =
      (
        response.body.aggregations?.by_event as unknown as {
          buckets?: Array<{
            key: string;
            doc_count: number;
            by_kind?: {
              buckets?: Array<{ key: number; doc_count: number }>;
            };
          }>;
        }
      )?.buckets || [];

    if (buckets.length === 0) return [];

    // Score: min(replies, reactions) * sqrt(total)
    const scoreMap = new Map<string, number>();
    for (const bucket of buckets) {
      const kindBuckets = bucket.by_kind?.buckets || [];
      let replies = 0;
      let engagement = 0;
      for (const kb of kindBuckets) {
        if (kb.key === 1) replies += kb.doc_count;
        else if (kb.key === 6 || kb.key === 7) engagement += kb.doc_count;
      }
      const balanced = Math.min(replies, engagement);
      const score = balanced * Math.sqrt(replies + engagement);
      if (score > 0) scoreMap.set(bucket.key, score);
    }

    const eventIds = [...scoreMap.keys()];
    if (eventIds.length === 0) return [];

    const eventsById = await this.fetchTargetEvents(eventIds, filter);
    if (eventsById.size === 0) return [];

    return [...eventsById.values()]
      .filter((e) => scoreMap.has(e.id))
      .sort((a, b) => (scoreMap.get(b.id) || 0) - (scoreMap.get(a.id) || 0));
  }

  /**
   * Query rising events — gaining engagement quickly in a short window.
   * Time window is applied to referencing events.
   * Score = doc_count / age_in_hours (references per hour).
   */
  private async querySortRising(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const now = Math.floor(Date.now() / 1000);
    const bucketCount = Math.max(limit * 10, 1000);
    const timeWindow = 48 * 60 * 60; // 48 hours

    const since = filter.since || now - timeWindow;
    const until = filter.until || now;

    const response = await this.client.search({
      index: this.indexName,
      body: {
        query: {
          bool: {
            must: [
              { term: { deleted: false } },
              { terms: { kind: [1, 6, 7, 16, 1111] } },
              { range: { created_at: { gte: since, lte: until } } },
            ],
          },
        },
        size: 0,
        aggs: {
          by_event: {
            terms: {
              field: "tags_map.e",
              size: bucketCount,
              order: { _count: "desc" as const },
            },
          },
        },
      },
    });

    const buckets =
      (
        response.body.aggregations?.by_event as unknown as {
          buckets?: Array<{ key: string; doc_count: number }>;
        }
      )?.buckets || [];

    if (buckets.length === 0) return [];

    const refCountMap = new Map(buckets.map((b) => [b.key, b.doc_count]));
    const eventIds = buckets.map((b) => b.key);

    const eventsById = await this.fetchTargetEvents(eventIds, filter);
    if (eventsById.size === 0) return [];

    return [...eventsById.values()]
      .map((event) => {
        const refCount = refCountMap.get(event.id) || 0;
        const ageInHours = Math.max((now - event.created_at) / 3600, 0.1);
        const score = refCount / ageInHours;
        return { event, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((item) => item.event);
  }

  /**
   * Query most-zapped events — ranked by number of zap receipts.
   * Since zap receipts (kind 9735) don't store the amount in tags_map,
   * we use zap receipt count as the score.
   */
  private async querySortZaps(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const bucketCount = Math.max(limit * 10, 1000);

    const aggMust: Record<string, unknown>[] = [
      { term: { deleted: false } },
      { term: { kind: 9735 } },
    ];

    // If the user specified a time range, apply it to zap receipts
    if (filter.since || filter.until) {
      const range: Record<string, number> = {};
      if (filter.since) range.gte = filter.since;
      if (filter.until) range.lte = filter.until;
      aggMust.push({ range: { created_at: range } });
    }

    const response = await this.client.search({
      index: this.indexName,
      body: {
        query: { bool: { must: aggMust } },
        size: 0,
        aggs: {
          by_event: {
            terms: {
              field: "tags_map.e",
              size: bucketCount,
              order: { _count: "desc" as const },
            },
          },
        },
      },
    });

    const buckets =
      (
        response.body.aggregations?.by_event as unknown as {
          buckets?: Array<{ key: string; doc_count: number }>;
        }
      )?.buckets || [];

    if (buckets.length === 0) return [];

    const zapCountMap = new Map(buckets.map((b) => [b.key, b.doc_count]));
    const eventIds = buckets.map((b) => b.key);

    const eventsById = await this.fetchTargetEvents(eventIds, filter);
    if (eventsById.size === 0) return [];

    return [...eventsById.values()].sort(
      (a, b) => (zapCountMap.get(b.id) || 0) - (zapCountMap.get(a.id) || 0),
    );
  }

  /**
   * Build OpenSearch query from Nostr filter
   */
  private buildQuery(filter: NostrFilter): Record<string, unknown> {
    const must: Record<string, unknown>[] = [
      { term: { deleted: false } }, // Always exclude deleted events
    ];

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
    }

    return { bool: { must } };
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
   */
  async event(
    event: NostrEvent,
    _opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const doc = this.eventToDocument(event);
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
    } catch (error) {
      // Entire bulk request failed — reject all entries
      const err = error instanceof Error ? error : new Error(String(error));
      for (const entry of entries) {
        entry.reject(err);
      }
    }
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

  /**
   * Initialize OpenSearch index with simple mappings
   */
  async migrate(): Promise<void> {
    try {
      // Check if index exists
      const indexExists = await this.client.indices.exists({
        index: this.indexName,
      });

      if (indexExists.body) {
        console.log(`Index ${this.indexName} already exists`);
        return;
      }

      // Create index with simple mappings
      await this.client.indices.create({
        index: this.indexName,
        body: {
          settings: {
            number_of_shards: 3,
            number_of_replicas: 1,
            "index.max_result_window": 100000,
          },
          mappings: {
            dynamic_templates: [
              {
                tags_map_keyword: {
                  path_match: "tags_map.*",
                  mapping: { type: "keyword" },
                },
              },
            ],
            properties: {
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
              },
              content: {
                type: "text",
                analyzer: "standard",
              },
              sig: { type: "keyword" },
              deleted: { type: "boolean" },
              protocol: { type: "keyword" },
            },
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
