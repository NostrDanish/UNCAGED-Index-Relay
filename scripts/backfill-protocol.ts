/**
 * Backfill script to populate the protocol field for existing documents
 * that have NIP-48 proxy tags.
 *
 * Usage:
 *   bun run scripts/backfill-protocol.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";

async function main() {
  console.log("🚀 Starting protocol field backfill\n");

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
    console.log("Starting protocol field backfill...");

    const result = await client.updateByQuery({
      index: config.opensearchIndex,
      body: {
        script: {
          source: `
            if (ctx._source.tags != null) {
              for (tag in ctx._source.tags) {
                if (tag.size() >= 3 && tag[0] == 'proxy') {
                  ctx._source.protocol = tag[2];
                  break;
                }
              }
            }
          `,
          lang: "painless",
        },
        query: {
          bool: {
            must: [
              {
                exists: { field: "tags" },
              },
            ],
            must_not: [{ exists: { field: "protocol" } }],
          },
        },
      },
      refresh: true,
    });

    const responseBody = result.body as {
      updated?: number;
      failures?: Array<Record<string, unknown>>;
    };

    console.log(
      `✅ Backfilled protocol field for ${responseBody.updated || 0} documents`,
    );
    if (responseBody.failures && responseBody.failures.length > 0) {
      console.error(
        `⚠️  ${responseBody.failures.length} documents failed to update`,
      );
    }

    console.log("\n✅ Backfill completed successfully");
  } catch (error) {
    console.error("\n❌ Backfill failed:");
    if (error && typeof error === "object" && "meta" in error) {
      const meta = (error as { meta?: { body?: unknown } }).meta;
      console.error(JSON.stringify(meta?.body, null, 2));
    } else {
      console.error(error);
    }
    process.exit(1);
  } finally {
    // Close connection
    await client.close();
  }
}

main();
