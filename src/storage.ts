import { NSchema } from "@nostrify/nostrify";
import type { Client } from "@opensearch-project/opensearch";
import type { NostrEvent } from "nostr-tools";

interface StoredEvent extends NostrEvent {
  tags_map: Record<string, string[]>;
  d_tag?: string;
  deleted?: boolean;
}

interface OpenSearchError extends Error {
  meta?: {
    statusCode: number;
  };
}

interface UpdateByQueryResponse {
  updated?: number;
}

export class EventStorage {
  constructor(
    private client: Client,
    private indexName: string,
  ) {}

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

  private getDTag(event: NostrEvent): string | undefined {
    const dTag = event.tags.find((tag) => tag[0] === "d");
    return dTag?.[1];
  }

  private isReplaceableEvent(kind: number): boolean {
    // Replaceable events: 0, 3, and 10000-19999
    return kind === 0 || kind === 3 || (kind >= 10000 && kind <= 19999);
  }

  private isParameterizedReplaceableEvent(kind: number): boolean {
    // Parameterized replaceable events: 30000-39999
    return kind >= 30000 && kind <= 39999;
  }

  async storeEvent(event: NostrEvent): Promise<boolean> {
    // Validate event using NSchema
    try {
      NSchema.event().parse(event);
    } catch (error) {
      throw new Error(`Invalid event: ${error}`);
    }

    const tagsMap = this.buildTagsMap(event.tags);
    const dTag = this.getDTag(event);

    const storedEvent: StoredEvent = {
      ...event,
      tags_map: tagsMap,
      d_tag: dTag,
      deleted: false,
    };

    // Handle replaceable events
    if (this.isReplaceableEvent(event.kind)) {
      // Check if a newer event already exists
      const existing = await this.client.search({
        index: this.indexName,
        body: {
          query: {
            bool: {
              must: [
                { term: { pubkey: event.pubkey } },
                { term: { kind: event.kind } },
                { term: { deleted: false } },
              ],
            },
          },
          size: 1,
          sort: [{ created_at: "desc" }],
        },
      });

      if (existing.body.hits.hits.length > 0) {
        const existingEvent = existing.body.hits.hits[0]._source as StoredEvent;
        if (existingEvent && existingEvent.created_at >= event.created_at) {
          return false; // Older event, reject
        }
        // Delete older event
        await this.client.delete({
          index: this.indexName,
          id: existing.body.hits.hits[0]._id,
        });
      }
    }

    // Handle parameterized replaceable events
    if (this.isParameterizedReplaceableEvent(event.kind)) {
      if (!dTag) {
        throw new Error("Parameterized replaceable event must have a d tag");
      }

      // Check if a newer event already exists with same pubkey, kind, and d tag
      const existing = await this.client.search({
        index: this.indexName,
        body: {
          query: {
            bool: {
              must: [
                { term: { pubkey: event.pubkey } },
                { term: { kind: event.kind } },
                { term: { d_tag: dTag } },
                { term: { deleted: false } },
              ],
            },
          },
          size: 1,
          sort: [{ created_at: "desc" }],
        },
      });

      if (existing.body.hits.hits.length > 0) {
        const existingEvent = existing.body.hits.hits[0]._source as StoredEvent;
        if (existingEvent && existingEvent.created_at >= event.created_at) {
          return false; // Older event, reject
        }
        // Delete older event
        await this.client.delete({
          index: this.indexName,
          id: existing.body.hits.hits[0]._id,
        });
      }
    }

    // Store the event
    await this.client.index({
      index: this.indexName,
      id: event.id,
      body: storedEvent,
      refresh: true,
    });

    return true;
  }

  async deleteEvents(deletionEvent: NostrEvent): Promise<number> {
    // NIP-09: Event deletion
    // Validate that the event is kind 5
    if (deletionEvent.kind !== 5) {
      throw new Error("Deletion event must be kind 5");
    }

    const eventIdsToDelete: string[] = [];
    const coordinatesToDelete: Array<{
      kind: number;
      pubkey: string;
      d: string;
    }> = [];

    for (const tag of deletionEvent.tags) {
      if (tag[0] === "e" && tag[1]) {
        eventIdsToDelete.push(tag[1]);
      } else if (tag[0] === "a" && tag[1]) {
        // Coordinate format: kind:pubkey:d-tag
        const parts = tag[1].split(":");
        if (parts.length === 3) {
          const kind = parseInt(parts[0], 10);
          const pubkey = parts[1];
          const d = parts[2];
          coordinatesToDelete.push({ kind, pubkey, d });
        }
      }
    }

    let deletedCount = 0;

    // Delete by event ID
    for (const eventId of eventIdsToDelete) {
      try {
        const event = await this.client.get({
          index: this.indexName,
          id: eventId,
        });

        const eventData = event.body._source as StoredEvent;
        // Only allow deletion if the deletion request is from the same author
        if (eventData && eventData.pubkey === deletionEvent.pubkey) {
          await this.client.update({
            index: this.indexName,
            id: eventId,
            body: {
              doc: { deleted: true },
            },
            refresh: true,
          });
          deletedCount++;
        }
      } catch (error) {
        // Event not found or other error, continue
        const osError = error as OpenSearchError;
        if (osError.meta?.statusCode !== 404) {
          console.error(`Error deleting event ${eventId}:`, error);
        }
      }
    }

    // Delete by coordinate (kind:pubkey:d-tag)
    for (const coord of coordinatesToDelete) {
      // Only allow deletion if the deletion request is from the same author
      if (coord.pubkey === deletionEvent.pubkey) {
        const result = await this.client.updateByQuery({
          index: this.indexName,
          body: {
            query: {
              bool: {
                must: [
                  { term: { kind: coord.kind } },
                  { term: { pubkey: coord.pubkey } },
                  { term: { d_tag: coord.d } },
                ],
              },
            },
            script: {
              source: "ctx._source.deleted = true",
            },
          },
          refresh: true,
        });
        // Handle both response formats (direct response or task)
        const updateResponse = result.body as UpdateByQueryResponse;
        if (typeof updateResponse.updated === "number") {
          deletedCount += updateResponse.updated;
        }
      }
    }

    return deletedCount;
  }
}
