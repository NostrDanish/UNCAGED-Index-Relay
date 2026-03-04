/**
 * Backfill follower counts for kind 0 (profile) events.
 *
 * Aggregates kind 3 (contact list) events by their `tags_map.p` values
 * to count how many unique pubkeys follow each pubkey, then writes the
 * count into the `top_score` field on the corresponding kind 0 event.
 *
 * For kind 0 events, `top_score` represents follower count (the number
 * of unique kind 3 events whose `p` tags include the profile's pubkey).
 *
 * Usage:
 *   bun run scripts/backfill-followers.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";
import { OpenSearchRelay } from "../src/opensearch.ts";

const BATCH_SIZE = 5000;

/** Delay for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run an async function with retries on 429/circuit breaker errors. */
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxRetries?: number;
    baseDelay?: number;
    onRetry?: () => Promise<void>;
  } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelay = opts.baseDelay ?? 30_000;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isRetryable =
        msg.includes("circuit_breaking") ||
        msg.includes("429") ||
        msg.includes("Data too large") ||
        msg.includes("search_phase_execution_exception") ||
        msg.includes("too_many_requests");

      if (!isRetryable || attempt >= maxRetries) throw error;

      const delay = baseDelay * 2 ** attempt;
      console.log(
        `Circuit breaker hit, waiting ${delay / 1000}s before retry (attempt ${attempt + 1}/${maxRetries})...`,
      );
      if (opts.onRetry) {
        try {
          await opts.onRetry();
        } catch (_) {
          // Ignore
        }
      }
      await sleep(delay);
    }
  }
}

async function main() {
  console.log("Starting follower count backfill\n");

  const config = new Config({
    get(key: string) {
      return process.env[key];
    },
  });

  const indexName = config.opensearchIndex;
  console.log(`OpenSearch Node: ${config.opensearchNode}`);
  console.log(`Index: ${indexName}\n`);

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

  // Ensure the index has the current mappings.
  const relay = new OpenSearchRelay(client, { indexName });
  await relay.migrate();
  console.log("Index mappings updated\n");

  // Phase 1: Paginated composite aggregation over kind 3 events.
  // Groups by followed pubkey (`tags_map.p`), counting the number of
  // unique kind 3 events (each kind 3 is replaceable, so one per follower).
  console.log("Computing follower counts...\n");

  let totalProcessed = 0;
  let totalUpdated = 0;
  let afterKey: Record<string, string> | undefined;

  while (true) {
    const compositeAgg: Record<string, unknown> = {
      composite: {
        size: BATCH_SIZE,
        sources: [{ followed_pubkey: { terms: { field: "tags_map.p" } } }],
        ...(afterKey && { after: afterKey }),
      },
    };

    const clearCache = async () => {
      await client.indices.clearCache({ index: indexName, fielddata: true });
    };

    const response = await withRetry(
      () =>
        // @ts-expect-error: composite aggregation not in client types
        client.search({
          index: indexName,
          body: {
            query: {
              bool: {
                must: [{ term: { deleted: false } }, { term: { kind: 3 } }],
              },
            },
            size: 0,
            aggs: { by_pubkey: compositeAgg },
          },
        }),
      { onRetry: clearCache },
    );

    const aggResult = response.body.aggregations?.by_pubkey as {
      buckets: Array<{
        key: { followed_pubkey: string };
        doc_count: number;
      }>;
      after_key?: Record<string, string>;
    };

    const buckets = aggResult?.buckets || [];
    if (buckets.length === 0) break;

    // Build follower count map: pubkey -> follower count.
    const followerCounts = new Map<string, number>();
    for (const bucket of buckets) {
      const pubkey = bucket.key.followed_pubkey;
      // Each bucket's doc_count = number of kind 3 events that p-tag
      // this pubkey.  Since kind 3 is replaceable (one per author),
      // this equals the number of unique followers.
      followerCounts.set(pubkey, bucket.doc_count);
    }

    // Update kind 0 events for these pubkeys using update_by_query.
    // We can't use noteEncode because kind 0 documents use naddr encoding.
    const pubkeys = [...followerCounts.keys()];
    const countParams: Record<string, number> = {};
    for (const [pk, count] of followerCounts) {
      countParams[pk] = count;
    }

    await withRetry(
      () =>
        client.updateByQuery({
          index: indexName,
          body: {
            query: {
              bool: {
                must: [{ term: { kind: 0 } }, { terms: { pubkey: pubkeys } }],
              },
            },
            script: {
              source: `
                def count = params.counts.get(ctx._source.pubkey);
                if (count != null) {
                  ctx._source.top_score = count;
                }
              `,
              lang: "painless",
              params: { counts: countParams },
            },
          },
          refresh: false,
          conflicts: "proceed",
        }),
      { onRetry: clearCache },
    );

    totalProcessed += buckets.length;
    totalUpdated += followerCounts.size;
    afterKey = aggResult.after_key;

    console.log(
      `Processed ${totalProcessed} followed pubkeys (batch: ${buckets.length})`,
    );

    if (!afterKey) break;

    // Periodically clear fielddata cache to prevent circuit breaker.
    if (totalProcessed % 5_000 === 0) {
      await client.indices.clearCache({
        index: indexName,
        fielddata: true,
      });
    }

    await sleep(200);
  }

  console.log(`\nBackfill complete:`);
  console.log(`  ${totalUpdated} pubkeys with follower counts updated`);

  await relay.close();
}

main().catch((error) => {
  console.error("\nFollower count backfill failed:", error);
  process.exit(1);
});
