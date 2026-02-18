/**
 * Backfill script to detect and populate the `sentiment` field for existing
 * documents that don't have one yet.
 *
 * Like backfill-language.ts, this script runs client-side because sentiment
 * detection uses the `sentiment` JS library. It scrolls through all documents
 * missing a `sentiment` field whose kind is eligible for detection, runs the
 * analyzer, and bulk-updates the results.
 *
 * Kind 7 (reactions) receive special handling per NIP-25: `"+"` and `""` map
 * to `"positive"`, `"-"` maps to `"negative"`, emoji reactions are scored by
 * the sentiment library, and NIP-30 custom emoji shortcodes are skipped.
 *
 * Usage:
 *   bun run scripts/backfill-sentiment.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import Sentiment from "sentiment";
import { Config } from "../src/config.ts";
import { OpenSearchRelay } from "../src/opensearch.ts";

const sentimentAnalyzer = new Sentiment();

/** NIP-30 custom emoji shortcodes like `:soapbox:`. */
const CUSTOM_EMOJI_RE = /^:[\w-]+:$/;

/** Detect sentiment from a document's kind and content. */
function detectDocSentiment(kind: number, content: string): string | undefined {
  // Kind 7 reactions get special handling (NIP-25).
  if (kind === 7) {
    if (content === "+" || content === "") return "positive";
    if (content === "-") return "negative";
    if (CUSTOM_EMOJI_RE.test(content)) return undefined;
    const result = sentimentAnalyzer.analyze(content);
    if (result.comparative > OpenSearchRelay.SENTIMENT_THRESHOLD)
      return "positive";
    if (result.comparative < -OpenSearchRelay.SENTIMENT_THRESHOLD)
      return "negative";
    return "neutral";
  }

  // For text kinds, analyze full content.
  if (!OpenSearchRelay.TEXT_KINDS.has(kind)) return undefined;

  if (content.length < OpenSearchRelay.MIN_LANGUAGE_DETECT_LENGTH) {
    return undefined;
  }

  const result = sentimentAnalyzer.analyze(content);
  if (result.comparative > OpenSearchRelay.SENTIMENT_THRESHOLD)
    return "positive";
  if (result.comparative < -OpenSearchRelay.SENTIMENT_THRESHOLD)
    return "negative";
  return "neutral";
}

async function main() {
  console.log("Starting sentiment field backfill\n");

  const config = new Config({
    get(key: string) {
      return process.env[key];
    },
  });
  console.log(`OpenSearch Node: ${config.opensearchNode}`);
  console.log(`Index: ${config.opensearchIndex}\n`);

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

  try {
    // Add the sentiment field mapping if it doesn't already exist.
    try {
      await client.indices.putMapping({
        index: config.opensearchIndex,
        body: {
          properties: {
            sentiment: { type: "keyword" },
          },
        },
      });
      console.log("Ensured `sentiment` mapping exists on the index.\n");
    } catch (e) {
      console.warn("Warning: could not update mapping (may already exist):", e);
    }

    // Kind 7 (reactions) + text kinds are eligible for sentiment detection.
    // Kind 0 (metadata) is excluded.
    const eligibleKinds = [7, ...OpenSearchRelay.TEXT_KINDS];

    // Count documents missing the sentiment field
    const countResponse = await client.count({
      index: config.opensearchIndex,
      body: {
        query: {
          bool: {
            must: [{ terms: { kind: eligibleKinds } }],
            must_not: [{ exists: { field: "sentiment" } }],
          },
        },
      },
    });
    const total = (countResponse.body as { count: number }).count;
    console.log(
      `Found ${total.toLocaleString()} eligible documents without a sentiment field.\n`,
    );

    if (total === 0) {
      console.log("Nothing to do.");
      return;
    }

    // Scroll through documents missing the sentiment field
    const SCROLL_SIZE = 1000;
    const SCROLL_TTL = "2h";
    let updated = 0;
    let skipped = 0;

    const initialResponse = await client.search({
      index: config.opensearchIndex,
      scroll: SCROLL_TTL,
      body: {
        size: SCROLL_SIZE,
        _source: ["kind", "content"],
        query: {
          bool: {
            must: [{ terms: { kind: eligibleKinds } }],
            must_not: [{ exists: { field: "sentiment" } }],
          },
        },
      },
    });

    let scrollId = initialResponse.body._scroll_id as string;
    let hits = (
      initialResponse.body.hits as unknown as {
        hits: Array<{
          _id: string;
          _source: { kind: number; content: string };
        }>;
      }
    ).hits;

    while (hits.length > 0) {
      const bulkBody: Array<Record<string, unknown>> = [];

      for (const hit of hits) {
        const { kind, content } = hit._source;
        const sentiment = detectDocSentiment(kind, content);

        if (sentiment) {
          bulkBody.push({
            update: { _index: config.opensearchIndex, _id: hit._id },
          });
          bulkBody.push({ doc: { sentiment } });
        } else {
          skipped++;
        }
      }

      if (bulkBody.length > 0) {
        const bulkResponse = await client.bulk({
          body: bulkBody,
          refresh: false,
        });
        const bulkResult = bulkResponse.body as {
          errors: boolean;
          items: Array<{ update?: { error?: unknown } }>;
        };

        const batchUpdated = bulkResult.items.filter(
          (item) => !item.update?.error,
        ).length;
        updated += batchUpdated;

        if (bulkResult.errors) {
          const failures = bulkResult.items.filter(
            (item) => item.update?.error,
          );
          console.warn(`  ${failures.length} items failed in batch`);
        }
      }

      const processed = updated + skipped;
      const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : "0.0";
      console.log(
        `  Progress: ${processed.toLocaleString()} / ${total.toLocaleString()} (${pct}%) — ${updated.toLocaleString()} updated, ${skipped.toLocaleString()} skipped`,
      );

      // Fetch next batch
      const scrollResponse = await client.scroll({
        scroll_id: scrollId,
        scroll: SCROLL_TTL,
      });
      scrollId = scrollResponse.body._scroll_id as string;
      hits = (
        scrollResponse.body.hits as unknown as {
          hits: Array<{
            _id: string;
            _source: { kind: number; content: string };
          }>;
        }
      ).hits;
    }

    // Clean up scroll context
    try {
      await client.clearScroll({ scroll_id: scrollId });
    } catch {
      // Scroll may have already expired
    }

    console.log(
      `\nBackfill completed: ${updated.toLocaleString()} documents updated, ${skipped.toLocaleString()} skipped (content too short or undetectable)`,
    );
  } catch (error) {
    console.error("\nBackfill failed:");
    if (error && typeof error === "object" && "meta" in error) {
      const meta = (error as { meta?: { body?: unknown } }).meta;
      console.error(JSON.stringify(meta?.body, null, 2));
    } else {
      console.error(error);
    }
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
