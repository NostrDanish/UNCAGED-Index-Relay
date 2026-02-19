/**
 * Backfill engagement scores for all existing events.
 *
 * Instead of marking every event dirty and waiting for the background job,
 * this script directly aggregates ALL referencing events in paginated
 * batches using composite aggregation, then bulk-updates the referenced
 * events with their computed scores.
 *
 * Events that have never been referenced get no update (their scores
 * remain at 0, which is correct).
 *
 * Usage:
 *   bun run scripts/backfill-scores.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { noteEncode } from "nostr-tools/nip19";
import { Config } from "../src/config.ts";
import { OpenSearchRelay } from "../src/opensearch.ts";

const BATCH_SIZE = 1000;

/** Delay for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Check if a string is a valid 64-char lowercase hex event ID. */
function isValidEventId(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/** Run an async function with retries on 429/circuit breaker errors. */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  baseDelay = 30_000,
): Promise<T> {
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
        `Circuit breaker hit, waiting ${delay / 1000}s before retry...`,
      );
      await sleep(delay);
    }
  }
}

interface ScoreEntry {
  top_score: number;
  reply_count: number;
  reaction_count: number;
  repost_count: number;
  zap_amount_msats: number;
}

async function main() {
  console.log("Starting scores backfill\n");

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

  // Ensure the index has the new score field mappings.
  const relay = new OpenSearchRelay(client, { indexName });
  await relay.migrate();
  console.log("Index mappings updated\n");

  // Phase 1: Paginated composite aggregation over engagement events.
  // Groups by referenced event ID (`tags_map.e`), computes unique authors,
  // and breaks down by kind.
  console.log("Computing engagement scores...\n");

  let totalProcessed = 0;
  let totalWithScores = 0;
  let afterKey: Record<string, string> | undefined;

  while (true) {
    const compositeAgg: Record<string, unknown> = {
      composite: {
        size: BATCH_SIZE,
        sources: [{ event_id: { terms: { field: "tags_map.e" } } }],
        ...(afterKey && { after: afterKey }),
      },
      aggs: {
        unique_authors: { cardinality: { field: "pubkey" } },
        by_kind: { terms: { field: "kind", size: 10 } },
      },
    };

    const response = await withRetry(() =>
      // @ts-expect-error: composite aggregation not in client types
      client.search({
        index: indexName,
        body: {
          query: {
            bool: {
              must: [
                { term: { deleted: false } },
                { terms: { kind: [1, 6, 7, 16, 1111] } },
              ],
            },
          },
          size: 0,
          aggs: { by_event: compositeAgg },
        },
      }),
    );

    const aggResult = response.body.aggregations?.by_event as {
      buckets: Array<{
        key: { event_id: string };
        doc_count: number;
        unique_authors?: { value: number };
        by_kind?: { buckets?: Array<{ key: number; doc_count: number }> };
      }>;
      after_key?: Record<string, string>;
    };

    const buckets = aggResult?.buckets || [];
    if (buckets.length === 0) break;

    // Build scores for this batch.
    const scores = new Map<string, ScoreEntry>();

    for (const bucket of buckets) {
      const id = bucket.key.event_id;
      const entry: ScoreEntry = {
        top_score: bucket.unique_authors?.value ?? 0,
        reply_count: 0,
        reaction_count: 0,
        repost_count: 0,
        zap_amount_msats: 0,
      };

      for (const kb of bucket.by_kind?.buckets || []) {
        switch (kb.key) {
          case 1:
          case 1111:
            entry.reply_count += kb.doc_count;
            break;
          case 7:
            entry.reaction_count += kb.doc_count;
            break;
          case 6:
          case 16:
            entry.repost_count += kb.doc_count;
            break;
        }
      }

      scores.set(id, entry);
    }

    // Bulk update using noteEncode for document IDs.
    const body: Array<Record<string, unknown>> = [];

    for (const [id, s] of scores) {
      if (!isValidEventId(id)) continue;
      body.push({
        update: { _index: indexName, _id: noteEncode(id) },
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

    const updateResponse = await client.bulk({ body, refresh: false });

    // Handle failures (replaceable/addressable events with non-note1 IDs).
    if (updateResponse.body.errors) {
      const failedIds: string[] = [];
      const items: Array<Record<string, { error?: unknown }>> =
        updateResponse.body.items;
      const idList = [...scores.keys()];

      for (let i = 0; i < items.length; i++) {
        const result = items[i].update;
        if (result?.error) {
          failedIds.push(idList[i]);
        }
      }

      if (failedIds.length > 0) {
        // Batch fallback using update_by_query with a scores lookup map.
        const scoreParams: Record<string, ScoreEntry> = {};
        for (const id of failedIds) {
          const s = scores.get(id);
          if (s) scoreParams[id] = s;
        }

        await client.updateByQuery({
          index: indexName,
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

    totalProcessed += buckets.length;
    totalWithScores += scores.size;
    afterKey = aggResult.after_key;

    console.log(
      `Processed ${totalProcessed} referenced events (batch: ${buckets.length})`,
    );

    if (!afterKey) break;

    // Periodically clear fielddata cache to prevent circuit breaker.
    if (totalProcessed % 10_000 === 0) {
      await client.indices.clearCache({
        index: indexName,
        fielddata: true,
      });
    }

    // Small delay between batches to avoid fielddata accumulation
    // triggering the circuit breaker.
    await sleep(200);
  }

  // Phase 2: Same for zap amounts (kind 9735).
  console.log("\nComputing zap scores...\n");

  let zapProcessed = 0;
  afterKey = undefined;

  while (true) {
    const compositeAgg: Record<string, unknown> = {
      composite: {
        size: BATCH_SIZE,
        sources: [{ event_id: { terms: { field: "tags_map.e" } } }],
        ...(afterKey && { after: afterKey }),
      },
      aggs: {
        total_msats: { sum: { field: "amount_msats" } },
      },
    };

    const response = await withRetry(() =>
      // @ts-expect-error: composite aggregation not in client types
      client.search({
        index: indexName,
        body: {
          query: {
            bool: {
              must: [{ term: { deleted: false } }, { term: { kind: 9735 } }],
            },
          },
          size: 0,
          aggs: { by_event: compositeAgg },
        },
      }),
    );

    const aggResult = response.body.aggregations?.by_event as {
      buckets: Array<{
        key: { event_id: string };
        doc_count: number;
        total_msats?: { value: number };
      }>;
      after_key?: Record<string, string>;
    };

    const buckets = aggResult?.buckets || [];
    if (buckets.length === 0) break;

    // Bulk update zap amounts.
    const body: Array<Record<string, unknown>> = [];
    const idList: string[] = [];
    const zapAmounts = new Map<string, number>();

    for (const bucket of buckets) {
      const id = bucket.key.event_id;
      const msats = bucket.total_msats?.value ?? 0;
      if (msats <= 0) continue;
      if (!isValidEventId(id)) continue;

      idList.push(id);
      zapAmounts.set(id, msats);

      body.push({
        update: { _index: indexName, _id: noteEncode(id) },
      });
      body.push({
        doc: { zap_amount_msats: msats, scores_dirty: false },
      });
    }

    if (body.length > 0) {
      const updateResponse = await client.bulk({ body, refresh: false });

      if (updateResponse.body.errors) {
        const failedIds: string[] = [];
        const items: Array<Record<string, { error?: unknown }>> =
          updateResponse.body.items;

        for (let i = 0; i < items.length; i++) {
          if (items[i].update?.error) {
            failedIds.push(idList[i]);
          }
        }

        if (failedIds.length > 0) {
          const zapParams: Record<string, number> = {};
          for (const id of failedIds) {
            const msats = zapAmounts.get(id);
            if (msats) zapParams[id] = msats;
          }

          await client.updateByQuery({
            index: indexName,
            body: {
              query: { terms: { id: failedIds } },
              script: {
                source: `
                  def msats = params.zaps.get(ctx._source.id);
                  if (msats != null) {
                    ctx._source.zap_amount_msats = msats;
                    ctx._source.scores_dirty = false;
                  }
                `,
                lang: "painless",
                params: { zaps: zapParams },
              },
            },
            refresh: false,
            conflicts: "proceed",
          });
        }
      }
    }

    zapProcessed += buckets.length;
    afterKey = aggResult.after_key;

    console.log(
      `Processed ${zapProcessed} zapped events (batch: ${buckets.length})`,
    );

    if (!afterKey) break;

    if (zapProcessed % 10_000 === 0) {
      await client.indices.clearCache({
        index: indexName,
        fielddata: true,
      });
    }

    await sleep(200);
  }

  // Phase 3: Clear dirty flag on remaining events that were never referenced.
  console.log("\nClearing dirty flag on unreferenced events...");

  const clearResponse = await client.updateByQuery({
    index: indexName,
    body: {
      query: { term: { scores_dirty: true } },
      script: {
        source: "ctx._source.scores_dirty = false",
        lang: "painless",
      },
    },
    refresh: false,
    conflicts: "proceed",
    wait_for_completion: false,
  });

  const clearBody = clearResponse.body as unknown as {
    task?: string;
    updated?: number;
  };

  if (clearBody.task) {
    console.log(`Cleanup task started: ${clearBody.task}`);
  } else {
    console.log(`Cleared ${clearBody.updated ?? 0} remaining dirty events`);
  }

  console.log(`\nBackfill complete:`);
  console.log(`  ${totalWithScores} events with engagement scores`);
  console.log(`  ${zapProcessed} events with zap amounts`);

  await relay.close();
}

main().catch((error) => {
  console.error("\nScores backfill failed:", error);
  process.exit(1);
});
