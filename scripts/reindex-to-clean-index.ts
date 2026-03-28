/**
 * Reindex all documents from the current index into a fresh index with
 * clean mappings, then swap the alias.
 *
 * This is the nuclear option for cleaning up index mapping bloat (e.g.
 * too many tags_map.* fields). All document data (including enrichment
 * fields like language, sentiment, media, scores, etc.) is carried over
 * from the source index. Transformations applied:
 * - Rebuild tags_map with the current whitelist rules
 * - Rename legacy fields (top_score → followers/engagers, reply_count →
 *   comment_cnt, reaction_count → reaction_cnt, repost_count → repost_cnt)
 * - Build search_text from event content and tags
 *
 * Index settings and mappings are imported from OpenSearchRelay so this
 * script never drifts out of sync with the relay.
 *
 * Steps:
 *   1. Resolve alias to find the concrete source index name
 *   2. Create a new index with clean mappings
 *   3. Swap the alias immediately (new events go to the new index)
 *   4. Reindex from old to new (backfills historical data)
 *
 * Usage:
 *   bun run scripts/reindex-to-clean-index.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";
import { OpenSearchRelay } from "../src/opensearch.ts";
import { buildReindexPainlessScript } from "./painless.ts";

async function main() {
  const config = new Config({
    get(key: string) {
      return process.env[key];
    },
  });

  const alias = config.opensearchIndex;
  console.log(`OpenSearch Node: ${config.opensearchNode}`);
  console.log(`Alias: ${alias}\n`);

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
    // Step 1: Resolve alias to the concrete index name
    const aliasResp = await client.indices.getAlias({ name: alias });
    const concreteIndices = Object.keys(
      aliasResp.body as Record<string, unknown>,
    );

    if (concreteIndices.length === 0) {
      // No alias — the index name itself is the concrete index
      const exists = await client.indices.exists({ index: alias });
      if (!exists.body) {
        console.error(`Index or alias '${alias}' does not exist`);
        process.exit(1);
      }
      concreteIndices.push(alias);
    }

    if (concreteIndices.length > 1) {
      console.error(
        `Alias '${alias}' points to multiple indices: ${concreteIndices.join(", ")}`,
      );
      console.error("Cannot determine source index. Please resolve manually.");
      process.exit(1);
    }

    const oldIndex = concreteIndices[0];

    // Derive the new index name by incrementing a version suffix, or
    // appending -v2 if the source has no version suffix.
    const versionMatch = oldIndex.match(/-v(\d+)$/);
    const newIndex = versionMatch
      ? oldIndex.replace(/-v(\d+)$/, `-v${Number(versionMatch[1]) + 1}`)
      : `${oldIndex}-v2`;

    console.log(`Source index: ${oldIndex}`);
    console.log(`Destination index: ${newIndex}\n`);

    // Step 2: Create the new index with clean mappings (from OpenSearchRelay)
    const newExists = await client.indices.exists({ index: newIndex });
    if (newExists.body) {
      const countResp = await client.count({ index: newIndex });
      const count = (countResp.body as { count: number }).count;
      console.log(
        `Destination index ${newIndex} already exists with ${count.toLocaleString()} documents.`,
      );
      console.log(
        `Reindex will continue (existing documents will be updated).\n`,
      );
    } else {
      console.log(`Creating index ${newIndex}...`);
      await client.indices.create({
        index: newIndex,
        body: {
          settings: {
            "sort.field": "created_at",
            "sort.order": "desc",
            number_of_shards: 3,
            number_of_replicas: 0, // No replicas during reindex for speed
            "index.max_result_window": 100000,
            "index.refresh_interval": "30s", // Less frequent refresh during reindex
            ...OpenSearchRelay.ANALYZER_SETTINGS,
          },
          mappings: {
            dynamic: "strict",
            dynamic_templates: [
              {
                tags_map_keyword: {
                  path_match: "tags_map.*",
                  mapping: { type: "keyword" },
                },
              },
            ],
            properties: OpenSearchRelay.MAPPING_PROPERTIES,
          },
        },
      });
      console.log(`Created index ${newIndex}\n`);
    }

    // Step 3: Swap alias immediately so new events go to the clean index
    console.log(`Swapping alias '${alias}' from ${oldIndex} to ${newIndex}...`);

    const actions: Array<Record<string, unknown>> = [
      { add: { index: newIndex, alias } },
    ];

    // Only remove the old alias if it was actually an alias (not a bare index)
    if (oldIndex !== alias) {
      actions.unshift({ remove: { index: oldIndex, alias } });
    }

    await client.indices.updateAliases({
      body: { actions },
    });
    console.log("Alias swapped — new events now go to the clean index.\n");

    // Get source doc count
    const srcCount = await client.count({ index: oldIndex });
    const totalDocs = (srcCount.body as { count: number }).count;
    console.log(
      `Source index has ${totalDocs.toLocaleString()} documents to reindex.\n`,
    );

    // Step 4: Reindex with Painless script that rebuilds tags_map,
    // renames legacy fields, and populates search_text.
    const painlessScript = buildReindexPainlessScript();

    console.log("Starting reindex (this will take a while)...\n");

    const taskResponse = await client.reindex({
      body: {
        source: {
          index: oldIndex,
          size: 1000, // Scroll batch size
        },
        dest: {
          index: newIndex,
        },
        script: {
          source: painlessScript,
          lang: "painless",
        },
        conflicts: "proceed",
      },
      wait_for_completion: false,
      requests_per_second: -1, // No throttling
    });

    const taskId = (taskResponse.body as unknown as { task: string }).task;
    console.log(`Reindex task started: ${taskId}\n`);

    // Poll for completion
    let completed = false;
    while (!completed) {
      await new Promise((resolve) => setTimeout(resolve, 10000));

      const statusResponse = await client.tasks.get({ task_id: taskId });
      const task = statusResponse.body.task as {
        status: {
          total: number;
          created: number;
          updated: number;
          deleted: number;
          version_conflicts: number;
          noops: number;
        };
      };
      const status = task.status;
      const processed = status.created + status.updated + status.noops;

      const pct =
        status.total > 0
          ? ((processed / status.total) * 100).toFixed(2)
          : "0.00";

      const parts = [
        `${processed.toLocaleString()} / ${status.total.toLocaleString()} (${pct}%)`,
        `created: ${status.created.toLocaleString()}`,
        `updated: ${status.updated.toLocaleString()}`,
      ];
      if (status.version_conflicts > 0) {
        parts.push(`conflicts: ${status.version_conflicts}`);
      }
      console.log(parts.join(" | "));

      completed = statusResponse.body.completed as boolean;
    }

    // Get final result
    const finalResponse = await client.tasks.get({ task_id: taskId });
    const result = finalResponse.body.response as {
      total: number;
      created: number;
      updated: number;
      version_conflicts: number;
      failures?: Array<{
        id?: string;
        cause?: { type?: string; reason?: string };
      }>;
    };

    console.log(
      `\nReindex complete: ${result.created.toLocaleString()} created, ${result.updated.toLocaleString()} updated out of ${result.total.toLocaleString()}`,
    );

    if (result.failures && result.failures.length > 0) {
      console.log(`\n${result.failures.length} failures:`);
      for (const failure of result.failures.slice(0, 10)) {
        console.log(
          `  ${failure.id}: ${failure.cause?.type} - ${failure.cause?.reason}`,
        );
      }
      if (result.failures.length > 10) {
        console.log(`  ... and ${result.failures.length - 10} more`);
      }
    }

    // Step 5: Restore normal index settings
    console.log("\nRestoring index settings...");
    await client.indices.putSettings({
      index: newIndex,
      body: {
        "index.number_of_replicas": 1,
        "index.refresh_interval": "1s",
      },
    });

    // Verify doc counts
    const newCount = await client.count({ index: newIndex });
    const newDocs = (newCount.body as { count: number }).count;
    const oldCount2 = await client.count({ index: oldIndex });
    const oldDocs = (oldCount2.body as { count: number }).count;
    console.log(
      `\nDoc counts — Old: ${oldDocs.toLocaleString()}, New: ${newDocs.toLocaleString()}`,
    );

    // Check new mapping field count
    const mappingResp = await client.indices.getMapping({ index: newIndex });
    const newMapping = mappingResp.body[newIndex] as {
      mappings: {
        properties: { tags_map?: { properties?: Record<string, unknown> } };
      };
    };
    const tagsMapFields = Object.keys(
      newMapping.mappings.properties.tags_map?.properties ?? {},
    ).length;
    console.log(`New index has ${tagsMapFields} fields in tags_map`);

    console.log(
      `\nDone! The old index ${oldIndex} can be deleted once you're satisfied:`,
    );
    console.log(`  curl -XDELETE '.../${oldIndex}'`);
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
