/**
 * Backfill script to detect and populate the `language` field for existing
 * documents that don't have one yet.
 *
 * Unlike backfill-protocol.ts (which uses a Painless script), this script
 * must run client-side because language detection uses the `tinyld` JS
 * library.  It scrolls through all documents missing a `language` field,
 * builds the search text using the shared `buildSearchText` function,
 * runs tinyld on it, and bulk-updates the results.
 *
 * Usage:
 *   bun run scripts/backfill-language.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import type { NostrEvent } from "nostr-tools";
import { detect as detectLanguage } from "tinyld";
import { Config } from "../src/config.ts";
import { buildSearchText } from "../src/search-text.ts";

/** Minimum text length (in characters) required to attempt language detection. */
const MIN_LANGUAGE_DETECT_LENGTH = 10;

/** Detect language from a document using its search text. */
function detectDocLanguage(event: NostrEvent): string | undefined {
  const text = buildSearchText(event);

  if (text.length < MIN_LANGUAGE_DETECT_LENGTH) {
    return undefined;
  }

  const detected = detectLanguage(text);
  return detected || undefined;
}

async function main() {
  console.log("Starting language field backfill\n");

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
    // Add the language field mapping if it doesn't already exist.
    // This is safe to run on an existing index — OpenSearch allows adding
    // new keyword fields without reindexing.
    try {
      await client.indices.putMapping({
        index: config.opensearchIndex,
        body: {
          properties: {
            language: { type: "keyword" },
          },
        },
      });
      console.log("Ensured `language` mapping exists on the index.\n");
    } catch (e) {
      console.warn("Warning: could not update mapping (may already exist):", e);
    }

    // Count documents missing the language field
    const countResponse = await client.count({
      index: config.opensearchIndex,
      body: {
        query: {
          bool: {
            must_not: [{ exists: { field: "language" } }],
          },
        },
      },
    });
    const total = (countResponse.body as { count: number }).count;
    console.log(
      `Found ${total.toLocaleString()} documents without a language field.\n`,
    );

    if (total === 0) {
      console.log("Nothing to do.");
      return;
    }

    // Scroll through documents missing the language field
    const SCROLL_SIZE = 1000;
    const SCROLL_TTL = "2h";
    let updated = 0;
    let skipped = 0;

    const initialResponse = await client.search({
      index: config.opensearchIndex,
      scroll: SCROLL_TTL,
      body: {
        size: SCROLL_SIZE,
        _source: [
          "id",
          "pubkey",
          "created_at",
          "kind",
          "tags",
          "content",
          "sig",
        ],
        query: {
          bool: {
            must_not: [{ exists: { field: "language" } }],
          },
        },
      },
    });

    let scrollId = initialResponse.body._scroll_id as string;
    let hits = (
      initialResponse.body.hits as unknown as {
        hits: Array<{
          _id: string;
          _source: NostrEvent;
        }>;
      }
    ).hits;

    while (hits.length > 0) {
      const bulkBody: Array<Record<string, unknown>> = [];

      for (const hit of hits) {
        const language = detectDocLanguage(hit._source);

        if (language) {
          bulkBody.push({
            update: { _index: config.opensearchIndex, _id: hit._id },
          });
          bulkBody.push({ doc: { language } });
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
            _source: NostrEvent;
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
