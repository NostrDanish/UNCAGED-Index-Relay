/**
 * Delete events from OpenSearch matching a Nostr filter (JSON).
 *
 * The filter supports the standard NIP-01 fields: ids, authors, kinds,
 * since, until, and single-letter tag filters (#e, #p, etc.).
 *
 * Usage:
 *   bun run scripts/delete-events.ts '{"kinds":[1],"authors":["abc123"]}'
 *   bun run scripts/delete-events.ts '{"kinds":[30023],"#d":["my-article"]}'
 *   bun run scripts/delete-events.ts '{"since":0,"until":1700000000}'
 */

import process from "node:process";
import type { NostrFilter } from "@nostrify/nostrify";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";

/**
 * Build an OpenSearch query from a Nostr filter.
 * Mirrors the relay's buildQuery logic but without NIP-50 search extensions
 * or the deleted/expiration exclusions (we want to match all documents).
 */
function buildDeleteQuery(filter: NostrFilter): Record<string, unknown> {
  const must: Record<string, unknown>[] = [];

  if (filter.ids && filter.ids.length > 0) {
    must.push({ terms: { id: filter.ids } });
  }

  if (filter.authors && filter.authors.length > 0) {
    must.push({ terms: { pubkey: filter.authors } });
  }

  if (filter.kinds && filter.kinds.length > 0) {
    must.push({ terms: { kind: filter.kinds } });
  }

  if (filter.since || filter.until) {
    const range: Record<string, number> = {};
    if (filter.since) range.gte = filter.since;
    if (filter.until) range.lte = filter.until;
    must.push({ range: { created_at: range } });
  }

  // Tag filters (#e, #p, #t, etc.)
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith("#") && Array.isArray(values) && values.length > 0) {
      const tagName = key.substring(1);
      must.push({ terms: { [`tags_map.${tagName}`]: values } });
    }
  }

  if (must.length === 0) {
    console.error("Error: filter must contain at least one constraint.");
    console.error("Refusing to delete all events with an empty filter.");
    process.exit(1);
  }

  return { bool: { must } };
}

async function main() {
  const filterArg = process.argv[2];

  if (!filterArg) {
    console.error(
      "Usage: bun run scripts/delete-events.ts '<nostr-filter-json>'",
    );
    console.error("");
    console.error("Examples:");
    console.error(
      '  bun run scripts/delete-events.ts \'{"kinds":[1],"authors":["abc123"]}\'',
    );
    console.error(
      '  bun run scripts/delete-events.ts \'{"kinds":[30023],"#d":["my-article"]}\'',
    );
    process.exit(1);
  }

  let filter: NostrFilter;
  try {
    filter = JSON.parse(filterArg);
  } catch {
    console.error("Error: invalid JSON filter.");
    process.exit(1);
  }

  const query = buildDeleteQuery(filter);

  console.log("Starting event deletion by filter\n");
  console.log(`Filter: ${JSON.stringify(filter)}\n`);

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
    // Count matching events
    console.log("Counting matching events...");
    const countResult = await client.count({
      index: config.opensearchIndex,
      body: { query },
    });

    const count = (countResult.body as { count: number }).count;
    console.log(`Found ${count} matching events\n`);

    if (count === 0) {
      console.log("No events to delete.");
      return;
    }

    console.log(
      "WARNING: This will permanently delete these events from the index.",
    );
    console.log(`About to delete ${count} events.\n`);

    // Run as a background task to avoid HTTP timeouts on large deletes.
    console.log(`Deleting ${count} events...\n`);
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
