/**
 * Backfill script to mark all existing events as `scores_dirty: true` so
 * the background score recomputation job picks them up.
 *
 * This should be run once after deploying the precomputed-scores feature
 * to compute initial `top_score`, `reply_count`, `reaction_count`,
 * `repost_count`, and `zap_amount_msats` for all existing events.
 *
 * The script uses `update_by_query` to set `scores_dirty = true` on all
 * documents that don't already have scores computed (scores_dirty is
 * missing or false, and all score fields are 0 or missing).
 *
 * After running this script, the server's background job will process
 * dirty events in batches until all scores are up to date.
 *
 * Usage:
 *   bun run scripts/backfill-scores.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";
import { OpenSearchRelay } from "../src/opensearch.ts";

async function main() {
  console.log("Starting scores backfill\n");

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

  // Ensure the index has the new score field mappings.
  const relay = new OpenSearchRelay(client, {
    indexName: config.opensearchIndex,
  });
  await relay.migrate();
  console.log("Index mappings updated\n");

  // Mark all events as scores_dirty so the background job recomputes them.
  console.log("Marking all events as scores_dirty...");

  const response = await client.updateByQuery({
    index: config.opensearchIndex,
    body: {
      query: {
        bool: {
          must_not: [{ term: { scores_dirty: true } }],
        },
      },
      script: {
        source: "ctx._source.scores_dirty = true",
        lang: "painless",
      },
    },
    refresh: true,
    conflicts: "proceed",
    wait_for_completion: false, // Run asynchronously for large indices
  });

  // When wait_for_completion=false, the response contains a task ID instead
  // of the usual bulk-by-scroll fields. Cast to access both shapes.
  const body = response.body as unknown as {
    task?: string;
    updated?: number;
  };

  if (body.task) {
    console.log(`Background task started: ${body.task}`);
    console.log("The update_by_query is running asynchronously on the server.");
    console.log(
      "Once complete, the server's background job will process dirty events in batches.\n",
    );
    console.log("You can check task status with:");
    console.log(`  curl -XGET 'http://localhost:9200/_tasks/${body.task}'`);
  } else {
    const updated = body.updated ?? 0;
    console.log(`Marked ${updated} events as scores_dirty\n`);
  }

  await relay.close();
  console.log("\nScores backfill initiated");
}

main().catch((error) => {
  console.error("\nScores backfill failed:", error);
  process.exit(1);
});
