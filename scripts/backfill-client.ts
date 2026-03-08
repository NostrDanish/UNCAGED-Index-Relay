/**
 * Backfill script to populate tags_map.client for existing documents
 * that have a "client" tag in their raw tags array but were indexed
 * before "client" was added to the MULTI_LETTER_TAG_WHITELIST.
 *
 * Uses the shared Painless script from OpenSearchRelay to rebuild
 * tags_map, ensuring filtering rules stay in sync.
 *
 * Usage:
 *   bun run scripts/backfill-client.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";
import { OpenSearchRelay } from "../src/opensearch.ts";

async function main() {
  console.log("Starting client tag backfill\n");

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

  const painlessScript = OpenSearchRelay.buildTagsMapPainlessScript();

  try {
    // Count documents that have a "client" tag but no tags_map.client yet
    const countResponse = await client.count({
      index: config.opensearchIndex,
      body: {
        query: {
          bool: {
            must: [
              {
                nested: {
                  path: "tags",
                  query: {
                    term: { "tags.0": "client" },
                  },
                },
              },
            ],
            must_not: [{ exists: { field: "tags_map.client" } }],
          },
        },
      },
    });

    const total = (countResponse.body as { count: number }).count;
    console.log(
      `Found ${total.toLocaleString()} documents with client tags to backfill.\n`,
    );

    if (total === 0) {
      console.log("Nothing to do.");
      return;
    }

    console.log("Running update_by_query...\n");

    const result = await client.updateByQuery({
      index: config.opensearchIndex,
      body: {
        query: {
          bool: {
            must_not: [{ exists: { field: "tags_map.client" } }],
          },
        },
        script: {
          source: painlessScript,
          lang: "painless",
        },
      },
      conflicts: "proceed",
      refresh: true,
    });

    const responseBody = result.body as {
      updated?: number;
      total?: number;
      version_conflicts?: number;
      failures?: Array<Record<string, unknown>>;
    };

    console.log(
      `Updated ${(responseBody.updated || 0).toLocaleString()} of ${(responseBody.total || 0).toLocaleString()} documents`,
    );

    if (responseBody.version_conflicts) {
      console.log(
        `  ${responseBody.version_conflicts} version conflicts (skipped)`,
      );
    }

    if (responseBody.failures && responseBody.failures.length > 0) {
      console.error(
        `  ${responseBody.failures.length} documents failed to update`,
      );
    }

    console.log("\nBackfill completed successfully");
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
