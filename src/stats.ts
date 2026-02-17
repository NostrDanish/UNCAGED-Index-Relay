import type { NostrFilter } from "@nostrify/nostrify";
import type { Client } from "@opensearch-project/opensearch";

/** A single trending tag value with engagement metrics. */
export interface TrendingTagValue {
  /** The tag value (lowercased). */
  value: string;
  /** Number of distinct authors who used this tag value. */
  authors: number;
  /** Total number of uses across all events. */
  uses: number;
}

/**
 * Get trending tag values for given tag names in the specified time frame.
 *
 * Uses OpenSearch `terms` + `cardinality` aggregations on the `tags_map`
 * field to replicate the Postgres-based trending query from Ditto:
 *
 * - Groups by lowercased tag value
 * - Counts distinct authors (`cardinality` on `pubkey`)
 * - Counts total uses (`doc_count`)
 * - Sorts by authors desc, then uses desc
 */
export async function getTrendingTagValues(
  client: Client,
  indexName: string,
  /** Tag names to aggregate on, e.g. `["t"]` or `["e", "q"]`. */
  tagNames: string[],
  /** Nostr filter for eligible events (kinds, authors, since, until, limit). */
  filter: NostrFilter,
  /** If present, only these tag values are permitted to trend. */
  values?: string[],
): Promise<TrendingTagValue[]> {
  const limit = filter.limit ?? 20;

  // Build the bool/must query clauses
  const must: Record<string, unknown>[] = [{ term: { deleted: false } }];

  if (filter.kinds && filter.kinds.length > 0) {
    must.push({ terms: { kind: filter.kinds } });
  }
  if (filter.authors && filter.authors.length > 0) {
    must.push({ terms: { pubkey: filter.authors } });
  }
  if (typeof filter.since === "number" || typeof filter.until === "number") {
    const range: Record<string, number> = {};
    if (typeof filter.since === "number") range.gte = filter.since;
    if (typeof filter.until === "number") range.lte = filter.until;
    must.push({ range: { created_at: range } });
  }

  // We need to run one aggregation per tag name (e.g. "e" and "q"), then
  // merge the buckets client-side.  Each tag name maps to a different
  // `tags_map.<name>` keyword field in OpenSearch.
  const aggs: Record<string, unknown> = {};

  for (const tagName of tagNames) {
    const field = `tags_map.${tagName}`;

    // Optionally restrict to a set of allowed values
    const tagMust = [...must];
    if (values && values.length > 0) {
      tagMust.push({ terms: { [field]: values } });
    }

    aggs[`tag_${tagName}`] = {
      filter: { bool: { must: tagMust } },
      aggs: {
        values: {
          terms: {
            field,
            size: limit * tagNames.length, // over-fetch to allow merging
          },
          aggs: {
            unique_authors: {
              cardinality: { field: "pubkey" },
            },
          },
        },
      },
    };
  }

  const response = await client.search({
    index: indexName,
    body: {
      size: 0,
      query: { bool: { must } },
      aggs,
    } as Record<string, unknown>,
  });

  // Merge buckets across tag names.  The same value might appear under
  // both "e" and "q"; we sum uses and take the max authors (a rough
  // approximation — the exact distinct-author count across multiple tag
  // names would require a composite aggregation which is more complex).
  const merged = new Map<string, { authors: number; uses: number }>();

  for (const tagName of tagNames) {
    const aggResult = response.body.aggregations?.[`tag_${tagName}`] as
      | {
          values?: {
            buckets?: Array<{
              key: string;
              doc_count: number;
              unique_authors?: { value: number };
            }>;
          };
        }
      | undefined;

    const buckets = aggResult?.values?.buckets ?? [];

    for (const bucket of buckets) {
      const key = bucket.key.toLowerCase();
      const existing = merged.get(key);
      const authors = bucket.unique_authors?.value ?? 0;
      const uses = bucket.doc_count;

      if (existing) {
        existing.authors = Math.max(existing.authors, authors);
        existing.uses += uses;
      } else {
        merged.set(key, { authors, uses });
      }
    }
  }

  // Sort by authors desc, then uses desc (matching the Ditto query)
  const sorted = [...merged.entries()]
    .sort(([, a], [, b]) => b.authors - a.authors || b.uses - a.uses)
    .slice(0, limit);

  return sorted.map(([value, { authors, uses }]) => ({
    value,
    authors,
    uses,
  }));
}
