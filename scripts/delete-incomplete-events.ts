/**
 * Delete incomplete event documents from OpenSearch.
 * These are documents missing required Nostr event fields (id, pubkey,
 * created_at, kind, content, sig), typically caused by a prior data
 * corruption bug in the reindex-tags-map script.
 *
 * Usage:
 *   bun run scripts/delete-incomplete-events.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";

const REQUIRED_FIELDS = [
  "id",
  "pubkey",
  "created_at",
  "kind",
  "content",
  "sig",
];

async function main() {
  console.log("Starting incomplete events deletion\n");

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
    // Query for documents missing any required Nostr event field
    const query = {
      bool: {
        should: REQUIRED_FIELDS.map((field) => ({
          bool: { must_not: { exists: { field } } },
        })),
        minimum_should_match: 1,
      },
    };

    // Count matching documents
    console.log("Searching for documents missing required fields...");
    const countResult = await client.count({
      index: config.opensearchIndex,
      body: { query },
    });

    const count = (countResult.body as { count: number }).count;
    console.log(`Found ${count} incomplete documents\n`);

    if (count === 0) {
      console.log("No incomplete documents to delete");
      return;
    }

    // Delete incomplete documents
    console.log(`Deleting ${count} incomplete documents...`);
    const deleteResult = await client.deleteByQuery({
      index: config.opensearchIndex,
      body: { query },
      refresh: true,
    });

    const responseBody = deleteResult.body as {
      deleted?: number;
      failures?: Array<Record<string, unknown>>;
    };

    console.log(`Deleted ${responseBody.deleted || 0} incomplete documents`);

    if (responseBody.failures && responseBody.failures.length > 0) {
      console.error(
        `${responseBody.failures.length} documents failed to delete`,
      );
      console.error(
        "First failure:",
        JSON.stringify(responseBody.failures[0], null, 2),
      );
    }
  } catch (error) {
    console.error("\nDeletion failed:");
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
