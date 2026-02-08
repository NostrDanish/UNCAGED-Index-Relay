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
   * Build tags_map from tags array
   */
  private buildTagsMap(tags: string[][]): Record<string, string[]> {
    const tagsMap: Record<string, string[]> = {};

    for (const tag of tags) {
      if (tag.length >= 2) {
        const [tagName, ...values] = tag;
        if (!tagsMap[tagName]) {
          tagsMap[tagName] = [];
        }
        tagsMap[tagName].push(...values);
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

    return {
      ...event,
      tags_map: tagsMap,
      deleted: false,
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

    // Sort by created_at (newest first)
    const sort = [{ created_at: { order: "desc" as const } }];

    try {
      const response = await this.client.search({
        index: this.indexName,
        body: {
          query,
          sort,
          size: limit,
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
    if (NKinds.replaceable(event.kind) || NKinds.addressable(event.kind)) {
      try {
        const existing = await this.client.get({
          index: this.indexName,
          id: docId,
          _source: ["id", "created_at", "deleted"],
        });

        if (existing.body.found) {
          const existingDoc = existing.body._source as {
            id: string;
            created_at: number;
            deleted?: boolean;
          };

          // Skip if already deleted
          if (existingDoc.deleted) {
            return;
          }

          const existingEvent: NostrEvent = {
            id: existingDoc.id,
            created_at: existingDoc.created_at,
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
          const tagsMap = this.buildTagsMap(event.tags);
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
