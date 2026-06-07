/**
 * Backfill script to populate the `client` field (NIP-89 client address)
 * for existing documents that have a `client` tag with a third value.
 *
 * The `client` field holds the addressable handler coordinate
 * (`<kind>:<pubkey>:<d-tag>`) from the third value of a `client` tag,
 * enabling NIP-50 `client:<address>` filtering. This is distinct from
 * `tags_map.client`, which holds the human-readable client name (the tag's
 * second value).
 *
 * Scope: documents that have `tags_map.client` (so they carry a client tag)
 * but lack the `client` field. Not all client tags include a third value, so
 * the Painless script removes a stale `client` field and only sets it when a
 * qualifying tag is present — documents without a third value are harmless
 * noops.
 *
 * Usage:
 *   bun run scripts/backfill-client-address.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";
import { buildClientAddressPainlessScript } from "./painless.ts";

async function main() {
  console.log("Starting client address backfill\n");

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

  const painlessScript = buildClientAddressPainlessScript();

  const query = {
    bool: {
      must: [{ exists: { field: "tags_map.client" } }],
      must_not: [{ exists: { field: "client" } }],
    },
  };

  try {
    const countResponse = await client.count({
      index: config.opensearchIndex,
      body: { query },
    });

    const total = (countResponse.body as { count: number }).count;
    console.log(
      `Found ${total.toLocaleString()} documents with a client tag but no client field to process.\n`,
    );

    if (total === 0) {
      console.log("Nothing to do.");
      return;
    }

    console.log("Running update_by_query (this may take a while)...\n");

    const taskResponse = await client.updateByQuery({
      index: config.opensearchIndex,
      body: {
        query,
        script: {
          source: painlessScript,
          lang: "painless",
        },
      },
      conflicts: "proceed",
      scroll_size: 1000,
      wait_for_completion: false,
      requests_per_second: -1,
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
          updated: number;
          version_conflicts: number;
          noops: number;
        };
      };
      const status = task.status;

      const pct =
        status.total > 0
          ? ((status.updated / status.total) * 100).toFixed(2)
          : "0.00";

      const parts = [
        `Updated ${status.updated.toLocaleString()} / ${status.total.toLocaleString()} (${pct}%)`,
      ];
      if (status.version_conflicts > 0) {
        parts.push(`${status.version_conflicts} conflicts`);
      }
      if (status.noops > 0) {
        parts.push(`${status.noops} noops`);
      }
      console.log(parts.join(" | "));

      completed = statusResponse.body.completed as boolean;
    }

    // Get final result
    const finalResponse = await client.tasks.get({ task_id: taskId });
    const response = finalResponse.body.response as {
      total: number;
      updated: number;
      version_conflicts: number;
      failures?: Array<Record<string, unknown>>;
    };

    console.log(
      `\nUpdated ${response.updated.toLocaleString()} of ${response.total.toLocaleString()} documents`,
    );

    if (response.version_conflicts > 0) {
      console.log(
        `  ${response.version_conflicts} version conflicts (skipped)`,
      );
    }

    if (response.failures && response.failures.length > 0) {
      console.error(`  ${response.failures.length} documents failed to update`);
      for (const failure of response.failures.slice(0, 5)) {
        console.error(`  ${JSON.stringify(failure)}`);
      }
      if (response.failures.length > 5) {
        console.error(
          `    ... and ${response.failures.length - 5} more failures`,
        );
      }
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
