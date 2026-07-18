/**
 * Backfill script to compute and populate the `pow` field (NIP-13
 * proof-of-work difficulty) for existing documents that don't have it yet.
 *
 * Scrolls through all documents missing the `pow` field, reconstructs a
 * minimal event shape from the stored `id` and `tags`, and runs
 * `getPow()` to compute the difficulty.
 *
 * Every processed document gets an explicit `pow` value (0 for events
 * without a `nonce` tag) so subsequent runs skip already-processed
 * documents, and so `pow:0` range queries stay cheap.
 *
 * Usage:
 *   bun run scripts/backfill-pow.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";
import { getPow } from "../src/pow.ts";

async function main() {
  console.log("Starting pow field backfill\n");

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
    // Ensure the pow field mapping exists.
    try {
      await client.indices.putMapping({
        index: config.opensearchIndex,
        body: {
          properties: {
            pow: { type: "integer" },
          },
        },
      });
      console.log("Ensured `pow` mapping exists on the index.\n");
    } catch (e) {
      console.warn("Warning: could not update mapping (may already exist):", e);
    }

    // Count documents missing the pow field
    const countResponse = await client.count({
      index: config.opensearchIndex,
      body: {
        query: {
          bool: {
            must_not: [{ exists: { field: "pow" } }],
          },
        },
      },
    });
    const total = (countResponse.body as { count: number }).count;
    console.log(
      `Found ${total.toLocaleString()} documents without a pow field.\n`,
    );

    if (total === 0) {
      console.log("Nothing to do.");
      return;
    }

    // Scroll through documents missing the pow field
    const SCROLL_SIZE = 1000;
    const SCROLL_TTL = "2h";
    let updated = 0;

    const initialResponse = await client.search({
      index: config.opensearchIndex,
      scroll: SCROLL_TTL,
      body: {
        size: SCROLL_SIZE,
        _source: ["id", "tags"],
        query: {
          bool: {
            must_not: [{ exists: { field: "pow" } }],
          },
        },
      },
    });

    let scrollId = initialResponse.body._scroll_id as string;
    let hits = (
      initialResponse.body.hits as unknown as {
        hits: Array<{
          _id: string;
          _source: { id: string; tags: string[][] };
        }>;
      }
    ).hits;

    while (hits.length > 0) {
      const bulkBody: Array<Record<string, unknown>> = [];

      for (const hit of hits) {
        const { id, tags } = hit._source;

        // Reconstruct a minimal event shape for getPow(). Only `id` and
        // `tags` affect the computed difficulty.
        const pow = getPow({
          id: id ?? hit._id,
          pubkey: "",
          created_at: 0,
          kind: 0,
          tags: tags || [],
          content: "",
          sig: "",
        });

        bulkBody.push({
          update: { _index: config.opensearchIndex, _id: hit._id },
        });
        bulkBody.push({ doc: { pow } });
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

      const pct = total > 0 ? ((updated / total) * 100).toFixed(1) : "0.0";
      console.log(
        `  Progress: ${updated.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`,
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
            _source: { id: string; tags: string[][] };
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
      `\nBackfill completed: ${updated.toLocaleString()} documents updated`,
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
