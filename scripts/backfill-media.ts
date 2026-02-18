/**
 * Backfill script to detect and populate the `media` and `video` fields for
 * existing documents that don't have them yet.
 *
 * Scrolls through all documents missing the `media` field, reconstructs a
 * minimal event shape from the stored `kind`, `content`, and `tags`, and
 * runs `OpenSearchRelay.detectMedia()` to compute the values.
 *
 * Every processed document gets an explicit `media` and `video` value
 * (true or false) so subsequent runs skip already-processed documents.
 *
 * Usage:
 *   bun run scripts/backfill-media.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";
import { detectMedia } from "../src/media.ts";

async function main() {
  console.log("Starting media/video field backfill\n");

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
    // Ensure the media and video field mappings exist.
    try {
      await client.indices.putMapping({
        index: config.opensearchIndex,
        body: {
          properties: {
            media: { type: "boolean" },
            video: { type: "boolean" },
          },
        },
      });
      console.log("Ensured `media` and `video` mappings exist on the index.\n");
    } catch (e) {
      console.warn("Warning: could not update mapping (may already exist):", e);
    }

    // Count documents missing the media field
    const countResponse = await client.count({
      index: config.opensearchIndex,
      body: {
        query: {
          bool: {
            must_not: [{ exists: { field: "media" } }],
          },
        },
      },
    });
    const total = (countResponse.body as { count: number }).count;
    console.log(
      `Found ${total.toLocaleString()} documents without a media field.\n`,
    );

    if (total === 0) {
      console.log("Nothing to do.");
      return;
    }

    // Scroll through documents missing the media field
    const SCROLL_SIZE = 1000;
    const SCROLL_TTL = "2h";
    let updated = 0;

    const initialResponse = await client.search({
      index: config.opensearchIndex,
      scroll: SCROLL_TTL,
      body: {
        size: SCROLL_SIZE,
        _source: ["kind", "content", "tags"],
        query: {
          bool: {
            must_not: [{ exists: { field: "media" } }],
          },
        },
      },
    });

    let scrollId = initialResponse.body._scroll_id as string;
    let hits = (
      initialResponse.body.hits as unknown as {
        hits: Array<{
          _id: string;
          _source: { kind: number; content: string; tags: string[][] };
        }>;
      }
    ).hits;

    while (hits.length > 0) {
      const bulkBody: Array<Record<string, unknown>> = [];

      for (const hit of hits) {
        const { kind, content, tags } = hit._source;

        // Reconstruct a minimal event shape for detectMedia()
        const result = detectMedia({
          id: "",
          pubkey: "",
          created_at: 0,
          kind,
          tags: tags || [],
          content: content || "",
          sig: "",
        });

        bulkBody.push({
          update: { _index: config.opensearchIndex, _id: hit._id },
        });
        bulkBody.push({
          doc: {
            media: result.media ?? false,
            video: result.video ?? false,
          },
        });
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
            _source: { kind: number; content: string; tags: string[][] };
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
