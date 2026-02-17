/**
 * Delete all ephemeral events (kinds 20000-29999) from OpenSearch.
 * According to NIP-01, ephemeral events should never be stored by relays.
 *
 * Usage:
 *   bun run scripts/delete-ephemeral-events.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";

async function main() {
  console.log("🗑️  Starting ephemeral events deletion\n");

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
    // First, count how many ephemeral events exist
    console.log("Counting ephemeral events (kinds 20000-29999)...");
    const countResult = await client.count({
      index: config.opensearchIndex,
      body: {
        query: {
          range: {
            kind: {
              gte: 20000,
              lte: 29999,
            },
          },
        },
      },
    });

    const count = (countResult.body as { count: number }).count;
    console.log(`Found ${count} ephemeral events\n`);

    if (count === 0) {
      console.log("✅ No ephemeral events to delete");
      return;
    }

    // Confirm deletion
    console.log(
      "⚠️  WARNING: This will permanently delete all ephemeral events from the index.",
    );
    console.log(`About to delete ${count} events with kinds 20000-29999.\n`);

    // Delete ephemeral events
    console.log("Deleting ephemeral events...");
    const deleteResult = await client.deleteByQuery({
      index: config.opensearchIndex,
      body: {
        query: {
          range: {
            kind: {
              gte: 20000,
              lte: 29999,
            },
          },
        },
      },
      refresh: true,
    });

    const responseBody = deleteResult.body as {
      deleted?: number;
      failures?: Array<Record<string, unknown>>;
    };

    console.log(`✅ Deleted ${responseBody.deleted || 0} ephemeral events`);

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
