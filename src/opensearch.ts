import type {
  NostrEvent,
  NostrFilter,
  NostrRelayCLOSED,
  NostrRelayEOSE,
  NostrRelayEVENT,
  NRelay,
} from "@nostrify/nostrify";
import { NIP50 } from "@nostrify/nostrify";
import type { Client, ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import type { Config } from "./config.ts";

/**
 * OpenSearch document structure for Nostr events
 */
interface NostrEventDocument {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  sig: string;
  tags: string[][];
  indexed_at: number;
  // Flattened tag fields for fast filtering
  tag_e?: string[];
  tag_p?: string[];
  tag_a?: string[];
  tag_d?: string[];
  tag_t?: string[];
  tag_r?: string[];
  tag_g?: string[];
  // Generic tag storage for all other tags
  tags_flat?: Array<{ name: string; value: string }>;
}

/**
 * Event kind categories based on NIP-01
 */
function isReplaceableEvent(kind: number): boolean {
  return (kind >= 10000 && kind < 20000) || kind === 0 || kind === 3;
}

function isAddressableEvent(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

/**
 * OpenSearch-backed Nostr relay implementation
 * Handles event storage and querying with full-text search support (NIP-50)
 */
export class OpenSearchRelay implements NRelay, AsyncDisposable {
  private client: Client;
  private indexName: string;

  constructor(client: Client, indexName?: string) {
    this.client = client;
    this.indexName = indexName || "nostr-events";
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
    return new OpenSearchRelay(client, config.opensearchIndex);
  }

  /**
   * Extract tag values for indexing
   */
  private extractTagValues(tags: string[][], tagName: string): string[] {
    return tags
      .filter((tag) => tag[0] === tagName && tag.length >= 2)
      .map((tag) => tag[1]);
  }

  /**
   * Get the first value of a specific tag, or empty string if not found
   */
  private getTagValue(tags: string[][], tagName: string): string {
    const values = this.extractTagValues(tags, tagName);
    return values.length > 0 ? values[0] : "";
  }

  /**
   * Generate OpenSearch document ID for an event
   * - Regular events: use event.id
   * - Replaceable events: use kind:pubkey:
   * - Addressable events: use kind:pubkey:d-tag
   * This ensures only the latest event is stored for replaceable/addressable events
   */
  private getDocumentId(event: NostrEvent): string {
    if (isAddressableEvent(event.kind)) {
      const dTag = this.getTagValue(event.tags, "d");
      return `${event.kind}:${event.pubkey}:${dTag}`;
    }
    if (isReplaceableEvent(event.kind)) {
      return `${event.kind}:${event.pubkey}:`;
    }
    // Regular and ephemeral events use their event ID
    return event.id;
  }

  /**
   * Convert NostrEvent to OpenSearch document
   */
  private eventToDocument(event: NostrEvent): NostrEventDocument {
    const doc: NostrEventDocument = {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      content: event.content,
      sig: event.sig,
      tags: event.tags,
      indexed_at: Math.floor(Date.now() / 1000),
    };

    // Index common tags for fast filtering
    const eValues = this.extractTagValues(event.tags, "e");
    if (eValues.length > 0) doc.tag_e = eValues;

    const pValues = this.extractTagValues(event.tags, "p");
    if (pValues.length > 0) doc.tag_p = pValues;

    const aValues = this.extractTagValues(event.tags, "a");
    if (aValues.length > 0) doc.tag_a = aValues;

    const dValues = this.extractTagValues(event.tags, "d");
    if (dValues.length > 0) doc.tag_d = dValues;

    const tValues = this.extractTagValues(event.tags, "t");
    if (tValues.length > 0) doc.tag_t = tValues;

    const rValues = this.extractTagValues(event.tags, "r");
    if (rValues.length > 0) doc.tag_r = rValues;

    const gValues = this.extractTagValues(event.tags, "g");
    if (gValues.length > 0) doc.tag_g = gValues;

    // Index all other tags in a flattened structure for generic queries
    const commonTags = new Set(["e", "p", "a", "d", "t", "r", "g"]);
    const otherTags = event.tags
      .filter((tag) => tag.length >= 2 && !commonTags.has(tag[0]))
      .map((tag) => ({ name: tag[0], value: tag[1] }));

    if (otherTags.length > 0) {
      doc.tags_flat = otherTags;
    }

    return doc;
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
   * Build OpenSearch query from Nostr filter
   */
  private buildQuery(filter: NostrFilter): Record<string, unknown> {
    const must: Record<string, unknown>[] = [];

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

    // Tag filters
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith("#") && Array.isArray(values) && values.length > 0) {
        const tagName = key.substring(1);

        // Use optimized fields for common tags
        const commonTags = new Set(["e", "p", "a", "d", "t", "r", "g"]);
        if (commonTags.has(tagName)) {
          must.push({ terms: { [`tag_${tagName}`]: values } });
        } else {
          // Use nested query for other tags
          must.push({
            nested: {
              path: "tags_flat",
              query: {
                bool: {
                  must: [
                    { term: { "tags_flat.name": tagName } },
                    { terms: { "tags_flat.value": values } },
                  ],
                },
              },
            },
          });
        }
      }
    }

    // Full-text search (NIP-50)
    if (filter.search) {
      const tokens = NIP50.parseInput(filter.search);
      const searchText = tokens.filter((t) => typeof t === "string").join(" ");

      // Use match query with boosting for better relevance if there's search text
      if (searchText.trim()) {
        must.push({
          match: {
            content: {
              query: searchText,
              operator: "and",
              fuzziness: "AUTO",
            },
          },
        });
      }
    }

    // If no conditions, match all
    if (must.length === 0) {
      return { match_all: {} };
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

    const query = this.buildQuery(filter);

    // For NIP-50 search queries with text, sort by relevance score first, then by created_at
    // For regular queries, sort by created_at only (newest first)
    const hasFullTextSearch = filter.search ? !!filter.search.trim() : false;
    const sort = hasFullTextSearch
      ? [
          { _score: { order: "desc" as const } },
          { created_at: { order: "desc" as const } },
        ]
      : [{ created_at: { order: "desc" as const } }];

    try {
      const response = await this.client.search({
        index: this.indexName,
        body: {
          query,
          sort,
          size: limit,
          _source: [
            "id",
            "pubkey",
            "created_at",
            "kind",
            "tags",
            "content",
            "sig",
          ],
        },
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
   * Check if a new event should replace an existing one
   * Returns true if newEvent is newer (higher created_at, or lower id if equal timestamps)
   */
  private shouldReplace(
    newEvent: NostrEvent,
    existingEvent: NostrEvent,
  ): boolean {
    if (newEvent.created_at > existingEvent.created_at) {
      return true;
    }
    if (newEvent.created_at === existingEvent.created_at) {
      // Lower ID wins (lexical order)
      return newEvent.id < existingEvent.id;
    }
    return false;
  }

  /**
   * Insert a single event into OpenSearch
   * For replaceable/addressable events, only stores if newer than existing
   */
  async event(
    event: NostrEvent,
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const doc = this.eventToDocument(event);
    const docId = this.getDocumentId(event);

    // For replaceable/addressable events, check if we should replace
    if (isReplaceableEvent(event.kind) || isAddressableEvent(event.kind)) {
      try {
        const existing = await this.client.get({
          index: this.indexName,
          id: docId,
          _source: ["id", "created_at"],
        });

        if (existing.body.found) {
          const existingDoc = existing.body._source as {
            id: string;
            created_at: number;
          };
          const existingEvent: NostrEvent = {
            id: existingDoc.id,
            created_at: existingDoc.created_at,
            // We only need id and created_at for comparison
          } as NostrEvent;

          // Only insert if new event should replace existing one
          if (!this.shouldReplace(event, existingEvent)) {
            return; // Don't replace - existing event is newer or equal
          }
        }
      } catch (error) {
        // Document doesn't exist, proceed with insert
        if ((error as { statusCode?: number }).statusCode !== 404) {
          throw error;
        }
      }
    }

    await this.client.index({
      index: this.indexName,
      id: docId,
      body: doc,
      refresh: false, // Don't refresh immediately for better performance
      // @ts-expect-error: signal not in types but supported by underlying HTTP client
      signal: opts?.signal,
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
   * Remove events matching the given filters
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

    // Delete all matching documents in bulk
    if (uniqueDocIds.length > 0) {
      const body: Array<Record<string, unknown>> = [];

      for (const docId of uniqueDocIds) {
        body.push({
          delete: {
            _index: this.indexName,
            _id: docId,
          },
        });
      }

      try {
        const response = await this.client.bulk({
          body,
          refresh: false,
          // @ts-expect-error: signal not in types but supported by underlying HTTP client
          signal: opts?.signal,
        });

        if (response.body.errors) {
          const erroredDocuments = response.body.items.filter(
            (item: Record<string, unknown>) =>
              (item.delete as Record<string, unknown>)?.error,
          );
          console.error(
            `Bulk delete had ${erroredDocuments.length} errors:`,
            erroredDocuments.slice(0, 5),
          );
        } else {
          console.log(`🗑️  Deleted ${uniqueDocIds.length} events`);
        }
      } catch (error) {
        console.error("Bulk delete failed:", error);
        throw error;
      }
    }
  }

  /**
   * Initialize OpenSearch index with optimized mappings
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

      // Create index with optimized mappings
      await this.client.indices.create({
        index: this.indexName,
        body: {
          settings: {
            number_of_shards: 3,
            number_of_replicas: 1,
            refresh_interval: "5s", // Batch refreshes for better write performance
            "index.mapping.total_fields.limit": 2000,
            analysis: {
              analyzer: {
                nostr_content_analyzer: {
                  type: "standard",
                  stopwords: "_none_", // Don't remove stop words for Nostr content
                },
              },
            },
          },
          mappings: {
            dynamic: "strict",
            properties: {
              id: {
                type: "keyword",
              },
              pubkey: {
                type: "keyword",
              },
              created_at: {
                type: "long",
              },
              kind: {
                type: "integer",
              },
              content: {
                type: "text",
                analyzer: "nostr_content_analyzer",
                // Also store as keyword for exact matching if needed
                fields: {
                  keyword: {
                    type: "keyword",
                    ignore_above: 256,
                  },
                },
              },
              sig: {
                type: "keyword",
              },
              tags: {
                type: "keyword",
                // Store full tag arrays
              },
              indexed_at: {
                type: "long",
              },
              // Optimized tag fields for common tags
              tag_e: {
                type: "keyword",
              },
              tag_p: {
                type: "keyword",
              },
              tag_a: {
                type: "keyword",
              },
              tag_d: {
                type: "keyword",
              },
              tag_t: {
                type: "keyword",
              },
              tag_r: {
                type: "keyword",
              },
              tag_g: {
                type: "keyword",
              },
              // Nested structure for all other tags
              tags_flat: {
                type: "nested",
                properties: {
                  name: {
                    type: "keyword",
                  },
                  value: {
                    type: "keyword",
                  },
                },
              },
            },
          },
        },
      });

      console.log(`✅ Created index ${this.indexName} with optimized mappings`);
    } catch (error) {
      console.error("Failed to create index:", error);
      throw error;
    }
  }

  /**
   * Close the OpenSearch connection
   */
  async close(): Promise<void> {
    await this.client.close();
  }

  /**
   * Dispose resources
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
