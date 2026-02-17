/**
 * Reindex tags_map for all documents so that only tag[1] (the first value)
 * is stored per tag, instead of all tag values.
 *
 * This is needed after the buildTagsMap fix to correct existing documents.
 * Uses update_by_query with a Painless script to recompute tags_map
 * server-side without fetching any documents.
 *
 * Usage:
 *   bun run scripts/reindex-tags-map.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";

async function main() {
  console.log("Starting tags_map reindex\n");

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

  // Painless script that rebuilds tags_map from ctx._source.tags
  // This mirrors the buildTagsMap logic: for each tag with >= 2 elements,
  // collect tag[1] values grouped by tag[0].
  const painlessScript = `
    Map tagsMap = new HashMap();
    if (ctx._source.tags != null) {
      for (def tag : ctx._source.tags) {
        if (tag != null && tag.size() >= 2) {
          String tagName = tag[0].toString();
          String value = tag[1].toString();
          if (!tagsMap.containsKey(tagName)) {
            tagsMap.put(tagName, new ArrayList());
          }
          tagsMap.get(tagName).add(value);
        }
      }
    }
    ctx._source.tags_map = tagsMap;
  `;

  try {
    // Get total count for context
    const countResponse = await client.count({
      index: config.opensearchIndex,
    });
    const total = (countResponse.body as { count: number }).count;
    console.log(`Found ${total.toLocaleString()} documents to process.\n`);

    // Pre-flight: discover and delete documents that cause
    // mapper_parsing_exception errors (tags_map field type conflicts).
    // These would abort the full reindex, so we remove them first.
    // Uses max_docs to limit each pass to a small batch.
    console.log("Checking for documents with mapping conflicts...");
    let totalDeleted = 0;

    for (;;) {
      let preflightBody: {
        updated?: number;
        failures?: Array<{ id?: string; cause?: { type?: string } }>;
      };

      try {
        const preflightResponse = await client.updateByQuery({
          index: config.opensearchIndex,
          body: {
            query: { match_all: {} },
            script: {
              source: painlessScript,
              lang: "painless",
            },
            max_docs: 1000,
          },
          conflicts: "proceed",
        });
        preflightBody = preflightResponse.body as typeof preflightBody;
      } catch (error) {
        // The client throws when the response contains failures.
        // Extract the response body from the error metadata.
        if (error && typeof error === "object" && "meta" in error) {
          const meta = (error as { meta?: { body?: unknown } }).meta;
          preflightBody = (meta?.body ?? {}) as typeof preflightBody;
        } else {
          throw error;
        }
      }

      const conflictIds = (preflightBody.failures ?? [])
        .filter((f) => f.cause?.type === "mapper_parsing_exception" && f.id)
        .map((f) => f.id as string);

      if (conflictIds.length === 0) break;

      const bulkBody: Array<Record<string, unknown>> = [];
      for (const id of conflictIds) {
        bulkBody.push({ delete: { _index: config.opensearchIndex, _id: id } });
      }
      await client.bulk({ body: bulkBody, refresh: true });
      totalDeleted += conflictIds.length;
      console.log(
        `  Deleted ${conflictIds.length} conflicting documents (${totalDeleted} total)`,
      );
    }

    if (totalDeleted > 0) {
      console.log(
        `Deleted ${totalDeleted} documents with mapping conflicts (will be re-ingested by the relay)\n`,
      );
    } else {
      console.log("No mapping conflicts found\n");
    }

    console.log("Running update_by_query (this may take a while)...\n");

    // Use update_by_query to update all documents server-side.
    // - wait_for_completion=false makes it run as a background task
    //   so we can poll for progress.
    // - conflicts=proceed skips version conflicts instead of aborting.
    // - scroll_size controls how many docs are processed per internal batch.
    const taskResponse = await client.updateByQuery({
      index: config.opensearchIndex,
      body: {
        query: { match_all: {} },
        script: {
          source: painlessScript,
          lang: "painless",
        },
      },
      conflicts: "proceed",
      scroll_size: 1000,
      wait_for_completion: false,
      requests_per_second: -1, // No throttling
    });

    const taskId = (taskResponse.body as unknown as { task: string }).task;
    console.log(`Task started: ${taskId}\n`);

    // Poll for task completion
    let completed = false;
    while (!completed) {
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Poll every 5s

      const statusResponse = await client.tasks.get({ task_id: taskId });
      const task = statusResponse.body.task as {
        status: {
          total: number;
          updated: number;
          created: number;
          deleted: number;
          version_conflicts: number;
          noops: number;
          failures?: unknown[];
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
      failures?: Array<{ cause?: { type?: string; reason?: string } }>;
    };

    console.log(
      `\nReindex completed: ${response.updated.toLocaleString()} updated out of ${response.total.toLocaleString()}`,
    );

    if (response.version_conflicts > 0) {
      console.log(
        `  ${response.version_conflicts} version conflicts (skipped)`,
      );
    }

    if (response.failures && response.failures.length > 0) {
      console.error(`  ${response.failures.length} failures:`);
      for (const failure of response.failures.slice(0, 5)) {
        console.error(`    ${JSON.stringify(failure)}`);
      }
      if (response.failures.length > 5) {
        console.error(
          `    ... and ${response.failures.length - 5} more failures`,
        );
      }
    }
  } catch (error) {
    console.error("\nReindex failed:");
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
