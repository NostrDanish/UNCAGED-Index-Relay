/**
 * Delete all expired events (NIP-40) from OpenSearch.
 * Events with an `expiration` tag whose timestamp is in the past are deleted.
 *
 * Usage:
 *   bun run scripts/delete-expired-events.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";

async function main() {
  console.log("🗑️  Starting expired events deletion (NIP-40)\n");

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

  const now = Math.floor(Date.now() / 1000);

  try {
    // Count expired events: those with a tags_map.expiration value <= now
    console.log("Counting expired events...");
    const countResult = await client.count({
      index: config.opensearchIndex,
      body: {
        query: {
          bool: {
            must: [
              { exists: { field: "tags_map.expiration" } },
              { range: { "tags_map.expiration": { lte: String(now) } } },
            ],
          },
        },
      },
    });

    const count = (countResult.body as { count: number }).count;
    console.log(`Found ${count} expired events\n`);

    if (count === 0) {
      console.log("✅ No expired events to delete");
      return;
    }

    console.log(
      "⚠️  WARNING: This will permanently delete all expired events from the index.",
    );
    console.log(`About to delete ${count} events expired before ${now}.\n`);

    // Delete expired events
    console.log("Deleting expired events...");
    const deleteResult = await client.deleteByQuery({
      index: config.opensearchIndex,
      body: {
        query: {
          bool: {
            must: [
              { exists: { field: "tags_map.expiration" } },
              { range: { "tags_map.expiration": { lte: String(now) } } },
            ],
          },
        },
      },
      refresh: true,
    });

    const responseBody = deleteResult.body as {
      deleted?: number;
      failures?: Array<Record<string, unknown>>;
    };

    console.log(`✅ Deleted ${responseBody.deleted || 0} expired events`);

    if (responseBody.failures && responseBody.failures.length > 0) {
      console.error(
        `⚠️  ${responseBody.failures.length} documents failed to delete`,
      );
      console.error(
        "First failure:",
        JSON.stringify(responseBody.failures[0], null, 2),
      );
    }

    console.log("\n✅ Deletion completed successfully");
  } catch (error) {
    console.error("\n❌ Deletion failed:");
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
