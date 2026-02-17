/**
 * Reindex tags_map for all documents so that only tag[1] (the first value)
 * is stored per tag, instead of all tag values.
 *
 * This is needed after the buildTagsMap fix to correct existing documents.
 *
 * Usage:
 *   bun run scripts/reindex-tags-map.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";

async function main() {
  console.log("🚀 Starting tags_map reindex\n");

  // Load configuration
  const config = new Config({
    get(key: string) {
      return process.env[key];
    },
  });
  console.log(`OpenSearch Node: ${config.opensearchNode}`);
  console.log(`Index: ${config.opensearchIndex}\n`);

  // Create OpenSearch client
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
    console.log("Rebuilding tags_map for all documents...");

    const result = await client.updateByQuery({
      index: config.opensearchIndex,
      body: {
        script: {
          source: `
            def tagsMap = new HashMap();
            if (ctx._source.tags != null) {
              for (tag in ctx._source.tags) {
                if (tag.size() >= 2) {
                  def tagName = tag[0];
                  def value = tag[1];
                  if (!tagsMap.containsKey(tagName)) {
                    tagsMap.put(tagName, new ArrayList());
                  }
                  tagsMap.get(tagName).add(value);
                }
              }
            }
            ctx._source.tags_map = tagsMap;
          `,
          lang: "painless",
        },
        query: {
          match_all: {},
        },
      },
      refresh: true,
    });

    const responseBody = result.body as {
      updated?: number;
      failures?: Array<Record<string, unknown>>;
    };

    console.log(
      `✅ Reindexed tags_map for ${responseBody.updated || 0} documents`,
    );
    if (responseBody.failures && responseBody.failures.length > 0) {
      console.error(
        `⚠️  ${responseBody.failures.length} documents failed to update`,
      );
    }

    console.log("\n✅ Reindex completed successfully");
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
