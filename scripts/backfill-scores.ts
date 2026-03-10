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

const BATCH_SIZE = 5000;

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

interface ScoreEntry {
  engagers: number;
  comment_cnt: number;
  reaction_cnt: number;
  repost_cnt: number;
  quote_cnt: number;
  zap_amount_msats: number;
  zap_cnt: number;
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
      { onRetry: clearCache },
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
        engagers: bucket.unique_authors?.value ?? 0,
        comment_cnt: 0,
        reaction_cnt: 0,
        repost_cnt: 0,
        quote_cnt: 0,
        zap_amount_msats: 0,
        zap_cnt: 0,
      };

      for (const kb of bucket.by_kind?.buckets || []) {
        switch (kb.key) {
          case 1:
          case 1111:
            entry.comment_cnt += kb.doc_count;
            break;
          case 7:
            entry.reaction_cnt += kb.doc_count;
            break;
          case 6:
          case 16:
            entry.repost_cnt += kb.doc_count;
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
                  ctx._source.engagers = s.engagers;
                  ctx._source.comment_cnt = s.comment_cnt;
                  ctx._source.reaction_cnt = s.reaction_cnt;
                  ctx._source.repost_cnt = s.repost_cnt;
                  ctx._source.quote_cnt = s.quote_cnt;
                  ctx._source.zap_amount_msats = s.zap_amount_msats;
                  ctx._source.zap_cnt = s.zap_cnt;
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
    if (totalProcessed % 5_000 === 0) {
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
                must: [{ term: { deleted: false } }, { term: { kind: 9735 } }],
              },
            },
            size: 0,
            aggs: { by_event: compositeAgg },
          },
        }),
      { onRetry: clearCache },
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

    // Bulk update zap amounts and counts.
    const body: Array<Record<string, unknown>> = [];
    const idList: string[] = [];
    const zapData = new Map<string, { msats: number; cnt: number }>();

    for (const bucket of buckets) {
      const id = bucket.key.event_id;
      const msats = bucket.total_msats?.value ?? 0;
      const cnt = bucket.doc_count;
      if (msats <= 0 && cnt <= 0) continue;
      if (!isValidEventId(id)) continue;

      idList.push(id);
      zapData.set(id, { msats, cnt });

      body.push({
        update: { _index: indexName, _id: noteEncode(id) },
      });
      body.push({
        doc: { zap_amount_msats: msats, zap_cnt: cnt },
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
          const zapParams: Record<string, { msats: number; cnt: number }> = {};
          for (const id of failedIds) {
            const data = zapData.get(id);
            if (data) zapParams[id] = data;
          }

          await client.updateByQuery({
            index: indexName,
            body: {
              query: { terms: { id: failedIds } },
              script: {
                source: `
                  def z = params.zaps.get(ctx._source.id);
                  if (z != null) {
                    ctx._source.zap_amount_msats = z.msats;
                    ctx._source.zap_cnt = z.cnt;
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

    if (zapProcessed % 5_000 === 0) {
      await client.indices.clearCache({
        index: indexName,
        fielddata: true,
      });
    }

    await sleep(200);
  }

  // Phase 3: Quote reposts (kind 1 events referencing via `q` tag).
  console.log("\nComputing quote repost scores...\n");

  let quoteProcessed = 0;
  afterKey = undefined;

  while (true) {
    const compositeAgg: Record<string, unknown> = {
      composite: {
        size: BATCH_SIZE,
        sources: [{ event_id: { terms: { field: "tags_map.q" } } }],
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
                must: [{ term: { deleted: false } }, { term: { kind: 1 } }],
              },
            },
            size: 0,
            aggs: { by_event: compositeAgg },
          },
        }),
      { onRetry: clearCache },
    );

    const aggResult = response.body.aggregations?.by_event as {
      buckets: Array<{
        key: { event_id: string };
        doc_count: number;
      }>;
      after_key?: Record<string, string>;
    };

    const buckets = aggResult?.buckets || [];
    if (buckets.length === 0) break;

    // Bulk update quote counts.
    const body: Array<Record<string, unknown>> = [];
    const idList: string[] = [];
    const quoteCounts = new Map<string, number>();

    for (const bucket of buckets) {
      const id = bucket.key.event_id;
      if (!isValidEventId(id)) continue;

      idList.push(id);
      quoteCounts.set(id, bucket.doc_count);

      body.push({
        update: { _index: indexName, _id: noteEncode(id) },
      });
      body.push({
        doc: { quote_cnt: bucket.doc_count },
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
          const quoteParams: Record<string, number> = {};
          for (const id of failedIds) {
            const cnt = quoteCounts.get(id);
            if (cnt) quoteParams[id] = cnt;
          }

          await client.updateByQuery({
            index: indexName,
            body: {
              query: { terms: { id: failedIds } },
              script: {
                source: `
                  def cnt = params.quotes.get(ctx._source.id);
                  if (cnt != null) {
                    ctx._source.quote_cnt = cnt;
                  }
                `,
                lang: "painless",
                params: { quotes: quoteParams },
              },
            },
            refresh: false,
            conflicts: "proceed",
          });
        }
      }
    }

    quoteProcessed += buckets.length;
    afterKey = aggResult.after_key;

    console.log(
      `Processed ${quoteProcessed} quoted events (batch: ${buckets.length})`,
    );

    if (!afterKey) break;

    if (quoteProcessed % 5_000 === 0) {
      await client.indices.clearCache({
        index: indexName,
        fielddata: true,
      });
    }

    await sleep(200);
  }

  console.log(`\nBackfill complete:`);
  console.log(`  ${totalWithScores} events with engagement scores`);
  console.log(`  ${zapProcessed} events with zap amounts`);
  console.log(`  ${quoteProcessed} events with quote repost counts`);

  await relay.close();
}

main().catch((error) => {
  console.error("\nScores backfill failed:", error);
  process.exit(1);
});
