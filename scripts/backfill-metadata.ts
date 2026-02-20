/**
 * Backfill script to parse and populate the `metadata` object for existing
 * kind 0 (profile) documents that don't have one yet.
 *
 * Scrolls through all kind 0 documents missing the `metadata` field, parses
 * the JSON `content` to extract `name`, `display_name`, `nip05`, and `about`,
 * then bulk-updates the documents.
 *
 * Usage:
 *   bun run scripts/backfill-metadata.ts
 */

import process from "node:process";
import { NSchema as n } from "@nostrify/nostrify";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";

/** Parse profile metadata from kind 0 JSON content. */
function parseMetadata(
  content: string,
):
  | { name?: string; display_name?: string; nip05?: string; about?: string }
  | undefined {
  const result = n.json().pipe(n.metadata()).safeParse(content);
  if (!result.success) return undefined;
  const { name, display_name, nip05, about } = result.data;
  if (!name && !display_name && !nip05 && !about) return undefined;
  return {
    ...(name && { name }),
    ...(display_name && { display_name }),
    ...(nip05 && { nip05 }),
    ...(about && { about }),
  };
}

async function main() {
  console.log("Starting metadata field backfill for kind 0 events\n");

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
    // Count kind 0 documents missing the metadata field
    const countResponse = await client.count({
      index: config.opensearchIndex,
      body: {
        query: {
          bool: {
            must: [{ term: { kind: 0 } }],
            must_not: [{ exists: { field: "metadata" } }],
          },
        },
      },
    });
    const total = (countResponse.body as { count: number }).count;
    console.log(
      `Found ${total.toLocaleString()} kind 0 documents without a metadata field.\n`,
    );

    if (total === 0) {
      console.log("Nothing to do.");
      return;
    }

    // Scroll through kind 0 documents missing the metadata field
    const SCROLL_SIZE = 5000;
    const SCROLL_TTL = "2h";
    let updated = 0;
    let skipped = 0;

    const initialResponse = await client.search({
      index: config.opensearchIndex,
      scroll: SCROLL_TTL,
      body: {
        size: SCROLL_SIZE,
        _source: ["content"],
        query: {
          bool: {
            must: [{ term: { kind: 0 } }],
            must_not: [{ exists: { field: "metadata" } }],
          },
        },
      },
    });

    let scrollId = initialResponse.body._scroll_id as string;
    let hits = (
      initialResponse.body.hits as unknown as {
        hits: Array<{
          _id: string;
          _source: { content: string };
        }>;
      }
    ).hits;

    while (hits.length > 0) {
      const bulkBody: Array<Record<string, unknown>> = [];

      for (const hit of hits) {
        const metadata = parseMetadata(hit._source.content);

        if (metadata) {
          bulkBody.push({
            update: { _index: config.opensearchIndex, _id: hit._id },
          });
          bulkBody.push({ doc: { metadata } });
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
            _source: { content: string };
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
      `\nBackfill completed: ${updated.toLocaleString()} documents updated, ${skipped.toLocaleString()} skipped (unparseable content)`,
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
