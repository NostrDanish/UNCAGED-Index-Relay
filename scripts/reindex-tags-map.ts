/**
 * Reindex tags_map for all documents so that only tag[1] (the first value)
 * is stored per tag, instead of all tag values.
 *
 * This is needed after the buildTagsMap fix to correct existing documents.
 * Uses scroll + bulk update to avoid Painless mapping conflicts.
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

interface ScrollHit {
  _id: string;
  _source: { tags: string[][] };
}

interface BulkItem {
  update: { status: number };
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
    // Open a scroll cursor over all documents, fetching only the tags field.
    const scrollTimeout = "5m";
    const batchSize = 1000;

    const initialResponse = await client.search({
      index: config.opensearchIndex,
      scroll: scrollTimeout,
      body: {
        size: batchSize,
        _source: ["tags"],
        query: { match_all: {} },
      },
    });

    let scrollId = initialResponse.body._scroll_id as string;
    let hits = initialResponse.body.hits.hits as unknown as ScrollHit[];

    const total =
      (initialResponse.body.hits.total as { value: number })?.value ??
      "unknown";
    console.log(`Found ${total} documents to process.\n`);

    while (hits.length > 0) {
      // Build bulk update body.
      const bulkBody: Array<Record<string, unknown>> = [];

      for (const hit of hits) {
        const tagsMap = buildTagsMap(hit._source.tags ?? []);
        bulkBody.push({ update: { _id: hit._id } });
        bulkBody.push({ doc: { tags_map: tagsMap } });
      }

      const bulkResponse = await client.bulk({
        index: config.opensearchIndex,
        body: bulkBody,
      });

      const items = bulkResponse.body.items as unknown as BulkItem[];
      const succeeded = items.filter((i) => i.update.status === 200).length;
      const failed = items.length - succeeded;

      totalUpdated += succeeded;
      totalFailed += failed;

      console.log(
        `Updated ${totalUpdated} / ${total} documents` +
          (totalFailed > 0 ? ` (${totalFailed} failed)` : ""),
      );

      // Fetch the next batch.
      const scrollResponse = await client.scroll({
        scroll_id: scrollId,
        scroll: scrollTimeout,
      });

      scrollId = scrollResponse.body._scroll_id as string;
      hits = scrollResponse.body.hits.hits as unknown as ScrollHit[];
    }

    // Clean up the scroll context.
    await client.clearScroll({ scroll_id: scrollId });

    console.log(
      `\n✅ Reindex completed: ${totalUpdated} updated, ${totalFailed} failed`,
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
