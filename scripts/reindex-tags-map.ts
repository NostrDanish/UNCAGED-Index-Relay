/**
 * Reindex tags_map for all documents, applying the same validation as
 * buildTagsMap in opensearch.ts:
 *
 * - Single-character tag names are always allowed.
 * - Multi-character tag names must be in the NIP-defined whitelist.
 * - Tag values must be ≤ 255 characters.
 *
 * This corrects existing documents that may have been indexed with
 * invalid tag names (hex pubkeys, timestamps, etc.) or oversized values.
 * Uses update_by_query with a Painless script to recompute tags_map
 * server-side without fetching any documents.
 *
 * Note: This cleans up document data but does NOT remove stale fields
 * from the index mapping. To fully clean up garbage fields, reindex
 * into a fresh index.
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

  // Painless script that rebuilds tags_map from ctx._source.tags.
  // Mirrors the buildTagsMap / isIndexableTagName validation logic:
  // - Single-character tag names are always allowed.
  // - Multi-character tag names must be in the whitelist of NIP-defined tags.
  // - Tag values must be ≤ 255 characters.
  const painlessScript = `
    Set whitelist = new HashSet();
    whitelist.add('alt'); whitelist.add('amount'); whitelist.add('amt');
    whitelist.add('bond'); whitelist.add('branch-name');
    whitelist.add('claim'); whitelist.add('client'); whitelist.add('clone');
    whitelist.add('commit'); whitelist.add('content-warning');
    whitelist.add('dep');
    whitelist.add('emoji'); whitelist.add('end'); whitelist.add('end_tzid');
    whitelist.add('endpoint'); whitelist.add('ends'); whitelist.add('expiration');
    whitelist.add('expires_at'); whitelist.add('extension');
    whitelist.add('fa'); whitelist.add('fb'); whitelist.add('file');
    whitelist.add('goal');
    whitelist.add('hand');
    whitelist.add('image');
    whitelist.add('layer'); whitelist.add('license'); whitelist.add('location');
    whitelist.add('member'); whitelist.add('merge-base'); whitelist.add('merge-commit');
    whitelist.add('modules');
    whitelist.add('name'); whitelist.add('network'); whitelist.add('nuts');
    whitelist.add('pinned'); whitelist.add('pm'); whitelist.add('premium');
    whitelist.add('price'); whitelist.add('proxy'); whitelist.add('published_at');
    whitelist.add('recording'); whitelist.add('relay'); whitelist.add('repo');
    whitelist.add('room'); whitelist.add('runtime');
    whitelist.add('server'); whitelist.add('service'); whitelist.add('source');
    whitelist.add('start'); whitelist.add('start_tzid'); whitelist.add('starts');
    whitelist.add('status'); whitelist.add('streaming'); whitelist.add('subject');
    whitelist.add('summary');
    whitelist.add('thumb'); whitelist.add('title'); whitelist.add('tracker');
    whitelist.add('web');
    whitelist.add('zap');
    Map tagsMap = new HashMap();
    if (ctx._source.tags != null) {
      for (def tag : ctx._source.tags) {
        if (tag != null && tag.size() >= 2) {
          String tagName = tag[0].toString();
          if (tagName.length() != 1 && !whitelist.contains(tagName)) {
            continue;
          }
          String value = tag[1].toString();
          if (!tagsMap.containsKey(tagName)) {
            tagsMap.put(tagName, new ArrayList());
          }
          if (value.length() <= 255) {
            tagsMap.get(tagName).add(value);
          }
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
        .filter((f) => f.id)
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

    // Run update_by_query as a background task with polling.
    // If the task finishes with mapping failures, delete the failing
    // documents and retry — a single failure aborts the scroll, so we
    // need to loop until a run completes with zero mapping errors.
    let attempt = 0;

    for (;;) {
      attempt++;
      if (attempt > 1) {
        console.log(`\nRetrying update_by_query (attempt ${attempt})...\n`);
      } else {
        console.log("Running update_by_query (this may take a while)...\n");
      }

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
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const statusResponse = await client.tasks.get({ task_id: taskId });
        const task = statusResponse.body.task as {
          status: {
            total: number;
            updated: number;
            created: number;
            deleted: number;
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
        failures?: Array<{
          id?: string;
          cause?: { type?: string; reason?: string };
        }>;
      };

      console.log(
        `\nReindex pass ${attempt}: ${response.updated.toLocaleString()} updated out of ${response.total.toLocaleString()}`,
      );

      if (response.version_conflicts > 0) {
        console.log(
          `  ${response.version_conflicts} version conflicts (skipped)`,
        );
      }

      // Any failure (status 400) aborts the scroll. Delete the offending
      // documents and retry until a run completes with zero failures.
      const deletableFailures = (response.failures ?? []).filter((f) => f.id);

      if (deletableFailures.length > 0) {
        for (const failure of deletableFailures.slice(0, 3)) {
          console.log(`  Failed: ${failure.id} (${failure.cause?.type})`);
        }
        if (deletableFailures.length > 3) {
          console.log(
            `  ... and ${deletableFailures.length - 3} more failures`,
          );
        }
        console.log(
          `  Deleting ${deletableFailures.length} failed documents and retrying...`,
        );
        const bulkBody: Array<Record<string, unknown>> = [];
        for (const failure of deletableFailures) {
          bulkBody.push({
            delete: { _index: config.opensearchIndex, _id: failure.id },
          });
        }
        await client.bulk({ body: bulkBody, refresh: true });
        totalDeleted += deletableFailures.length;
        continue;
      }

      break; // No failures, we're done
    }

    if (totalDeleted > 0) {
      console.log(
        `\nTotal mapping conflicts deleted across all passes: ${totalDeleted}`,
      );
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
