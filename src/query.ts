import type { Client } from "@opensearch-project/opensearch";
import type { Filter, NostrEvent } from "nostr-tools";

interface StoredEvent extends NostrEvent {
  tags_map: Record<string, string[]>;
  d_tag?: string;
  deleted: boolean;
}

type QueryObject = Record<string, unknown>;

interface SearchHit<T> {
  _source?: T;
}

interface SearchResponse<T> {
  hits: {
    hits: SearchHit<T>[];
  };
}

export class EventQuery {
  constructor(
    private client: Client,
    private indexName: string,
  ) {}

  async query(filters: Filter[]): Promise<NostrEvent[]> {
    if (filters.length === 0) {
      return [];
    }

    const queries = filters.map((filter) => this.buildQuery(filter));

    const response = await this.client.search({
      index: this.indexName,
      body: {
        query: {
          bool: {
            should: queries,
            minimum_should_match: 1,
          },
        },
        size: this.getLimit(filters),
        sort: [{ created_at: "desc" }],
      },
    });

    const searchResponse = response.body as SearchResponse<StoredEvent>;

    return searchResponse.hits.hits
      .map((hit) => {
        const source = hit._source;
        if (!source) {
          return null;
        }
        // Reconstruct original event (without tags_map, d_tag, deleted)
        const event: NostrEvent = {
          id: source.id,
          pubkey: source.pubkey,
          created_at: source.created_at,
          kind: source.kind,
          tags: source.tags,
          content: source.content,
          sig: source.sig,
        };
        return event;
      })
      .filter((event): event is NostrEvent => event !== null)
      .filter((event: NostrEvent) => {
        // Additional client-side filtering if needed
        return filters.some((filter) => this.matchesFilter(event, filter));
      });
  }

  private buildQuery(filter: Filter): QueryObject {
    const must: QueryObject[] = [{ term: { deleted: false } }];
    const should: QueryObject[] = [];

    // Filter by IDs
    if (filter.ids && filter.ids.length > 0) {
      must.push({ terms: { id: filter.ids } });
    }

    // Filter by authors
    if (filter.authors && filter.authors.length > 0) {
      must.push({ terms: { pubkey: filter.authors } });
    }

    // Filter by kinds
    if (filter.kinds && filter.kinds.length > 0) {
      must.push({ terms: { kind: filter.kinds } });
    }

    // Filter by time
    if (filter.since || filter.until) {
      const range: { gte?: number; lte?: number } = {};
      if (filter.since) {
        range.gte = filter.since;
      }
      if (filter.until) {
        range.lte = filter.until;
      }
      must.push({ range: { created_at: range } });
    }

    // Filter by tags
    // Standard tags: #e, #p, #a, etc.
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith("#") && Array.isArray(values) && values.length > 0) {
        const tagName = key.substring(1);
        // Use nested query for tag matching
        must.push({
          nested: {
            path: "tags",
            query: {
              bool: {
                must: [
                  { term: { "tags.0": tagName } },
                  { terms: { "tags.1": values } },
                ],
              },
            },
          },
        });
      }
    }

    // NIP-50: Full-text search
    if (filter.search) {
      must.push({
        match: {
          content: {
            query: filter.search,
            operator: "and",
          },
        },
      });
    }

    return { bool: { must, should } };
  }

  private getLimit(filters: Filter[]): number {
    // Find the maximum limit from all filters
    const limits = filters
      .map((f) => f.limit)
      .filter((l): l is number => l !== undefined);

    if (limits.length === 0) {
      return 100; // Default limit
    }

    return Math.min(Math.max(...limits), 5000); // Cap at 5000
  }

  private matchesFilter(event: NostrEvent, filter: Filter): boolean {
    // Additional client-side validation
    if (filter.ids && !filter.ids.some((id) => event.id.startsWith(id))) {
      return false;
    }

    if (
      filter.authors &&
      !filter.authors.some((author) => event.pubkey.startsWith(author))
    ) {
      return false;
    }

    if (filter.kinds && !filter.kinds.includes(event.kind)) {
      return false;
    }

    if (filter.since && event.created_at < filter.since) {
      return false;
    }

    if (filter.until && event.created_at > filter.until) {
      return false;
    }

    // Check tag filters
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith("#") && Array.isArray(values)) {
        const tagName = key.substring(1);
        const hasMatchingTag = event.tags.some(
          (tag) =>
            tag[0] === tagName &&
            values.some((v) => {
              const tagValue = tag[1];
              const valueStr = String(v);
              return typeof tagValue === "string" &&
                tagValue.startsWith(valueStr);
            }),
        );
        if (!hasMatchingTag) {
          return false;
        }
      }
    }

    return true;
  }
}
