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

    // Run as a background task to avoid HTTP timeouts on large deletes.
    // conflicts=proceed skips documents modified concurrently by the relay.
    console.log(`Deleting ${count} incomplete documents...\n`);
    const taskResponse = await client.deleteByQuery({
      index: config.opensearchIndex,
      body: { query },
      conflicts: "proceed",
      wait_for_completion: false,
      scroll_size: 1000,
    });

    const taskId = (taskResponse.body as unknown as { task: string }).task;
    console.log(`Task started: ${taskId}\n`);

    // Poll for task completion
    let completed = false;
    while (!completed) {
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const statusResponse = await client.tasks.get({ task_id: taskId });
      const task = statusResponse.body.task as {
        status: {
          total: number;
          deleted: number;
          version_conflicts: number;
        };
      };
      const status = task.status;

      const pct =
        status.total > 0
          ? ((status.deleted / status.total) * 100).toFixed(2)
          : "0.00";

      const parts = [
        `Deleted ${status.deleted.toLocaleString()} / ${status.total.toLocaleString()} (${pct}%)`,
      ];
      if (status.version_conflicts > 0) {
        parts.push(`${status.version_conflicts} conflicts`);
      }
      console.log(parts.join(" | "));

      completed = statusResponse.body.completed as boolean;
    }

    // Get final result
    const finalResponse = await client.tasks.get({ task_id: taskId });
    const response = finalResponse.body.response as {
      total: number;
      deleted: number;
      version_conflicts: number;
      failures?: Array<Record<string, unknown>>;
    };

    console.log(
      `\nDeletion completed: ${response.deleted.toLocaleString()} deleted out of ${response.total.toLocaleString()}`,
    );

    if (response.version_conflicts > 0) {
      console.log(
        `  ${response.version_conflicts} version conflicts (skipped)`,
      );
    }

    if (response.failures && response.failures.length > 0) {
      console.error(`  ${response.failures.length} failures:`);
      for (const failure of response.failures.slice(0, 5)) {
        console.error(`  ${JSON.stringify(failure)}`);
      }
      if (response.failures.length > 5) {
        console.error(
          `    ... and ${response.failures.length - 5} more failures`,
        );
      }
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
