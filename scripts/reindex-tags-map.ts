/**
 * Reindex tags_map for all documents so that only tag[1] (the first value)
 * is stored per tag, instead of all tag values.
 *
 * This is needed after the buildTagsMap fix to correct existing documents.
 * Uses point-in-time (PIT) + bulk update to avoid Painless mapping conflicts.
 * PIT is used instead of scroll to avoid timeout issues with large datasets.
 *
 * Usage:
 *   bun run scripts/reindex-tags-map.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";

/** Build tags_map from tags array — same logic as OpenSearchRelay.buildTagsMap. */
function buildTagsMap(tags: string[][]): Record<string, string[]> {
  const tagsMap: Record<string, string[]> = {};

  for (const tag of tags) {
    if (tag.length >= 2) {
      const [tagName, value] = tag;
      if (!tagsMap[tagName]) {
        tagsMap[tagName] = [];
      }
      tagsMap[tagName].push(value);
    }
  }

  return tagsMap;
}

interface SearchHit {
  _id: string;
  _source: { tags: string[][] };
  sort?: unknown[];
}

interface BulkItem {
  update: { status: number; error?: unknown };
}

async function main() {
  console.log("🚀 Starting tags_map reindex\n");

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

  let totalUpdated = 0;
  let totalFailed = 0;

  try {
    const batchSize = 500; // Reduced batch size for better memory management

    // Get total count for progress tracking
    const countResponse = await client.count({
      index: config.opensearchIndex,
    });
    const total = (countResponse.body as { count: number }).count;
    console.log(`Found ${total.toLocaleString()} documents to process.\n`);

    let searchAfter: unknown[] | undefined;
    let hasMore = true;

    while (hasMore) {
      // Search using search_after pagination (no timeout, stateless)
      const searchBody: Record<string, unknown> = {
        size: batchSize,
        _source: ["tags"],
        query: { match_all: {} },
        sort: [{ _id: "asc" }], // Consistent sorting for search_after
      };

      if (searchAfter) {
        searchBody.search_after = searchAfter;
      }

      const searchResponse = await client.search({
        index: config.opensearchIndex,
        body: searchBody,
      });

      const hits = searchResponse.body.hits.hits as unknown as SearchHit[];

      if (hits.length === 0) {
        hasMore = false;
        break;
      }

      // Build bulk update body
      const bulkBody: Array<Record<string, unknown>> = [];

      for (const hit of hits) {
        const tagsMap = buildTagsMap(hit._source.tags ?? []);
        bulkBody.push({ update: { _id: hit._id } });
        bulkBody.push({ doc: { tags_map: tagsMap } });
      }

      // Execute bulk update
      const bulkResponse = await client.bulk({
        index: config.opensearchIndex,
        body: bulkBody,
      });

      const items = bulkResponse.body.items as unknown as BulkItem[];
      const succeeded = items.filter((i) => i.update.status === 200).length;
      const failed = items.length - succeeded;

      totalUpdated += succeeded;
      totalFailed += failed;

      // Log any failures for debugging
      if (failed > 0) {
        const failedItems = items.filter((i) => i.update.status !== 200);
        console.error(
          `Failed items sample: ${JSON.stringify(failedItems.slice(0, 3), null, 2)}`,
        );
      }

      console.log(
        `Updated ${totalUpdated.toLocaleString()} / ${total.toLocaleString()} documents (${((totalUpdated / total) * 100).toFixed(2)}%)` +
          (totalFailed > 0 ? ` (${totalFailed} failed)` : ""),
      );

      // Update search_after for next iteration
      const lastHit = hits[hits.length - 1];
      searchAfter = lastHit.sort;

      // Check if we got fewer results than requested (last page)
      if (hits.length < batchSize) {
        hasMore = false;
      }
    }

    console.log(
      `\n✅ Reindex completed: ${totalUpdated.toLocaleString()} updated, ${totalFailed} failed`,
    );
  } catch (error) {
    console.error("\n❌ Reindex failed:");
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
