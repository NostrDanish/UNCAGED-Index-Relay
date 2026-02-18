/**
 * Reindex all documents from the current index into a fresh index with
 * clean mappings, then swap the alias.
 *
 * This eliminates the 600+ garbage fields in tags_map that were created
 * by old data (hex pubkeys, timestamps, relay hints, etc. used as tag names).
 * The Painless script applies the same validation as buildTagsMap:
 * - Tag names must match /^[\w-]{1,15}$/
 * - Tag values must be ≤ 255 characters
 *
 * Steps:
 *   1. Create a new index (nostr-events-v3) with clean mappings
 *   2. Reindex from old to new with the validation script
 *   3. Swap the alias from old to new
 *
 * Usage:
 *   bun run scripts/reindex-to-clean-index.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";

const OLD_INDEX = "nostr-events-v2";
const NEW_INDEX = "nostr-events-v3";

async function main() {
  const config = new Config({
    get(key: string) {
      return process.env[key];
    },
  });

  const alias = config.opensearchIndex;
  console.log(`OpenSearch Node: ${config.opensearchNode}`);
  console.log(`Alias: ${alias}`);
  console.log(`Source: ${OLD_INDEX}`);
  console.log(`Destination: ${NEW_INDEX}\n`);

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
    // Step 1: Check the source index exists
    const oldExists = await client.indices.exists({ index: OLD_INDEX });
    if (!oldExists.body) {
      console.error(`Source index ${OLD_INDEX} does not exist`);
      process.exit(1);
    }

    // Check if destination already exists (allow resuming)
    const newExists = await client.indices.exists({ index: NEW_INDEX });
    if (newExists.body) {
      const countResp = await client.count({ index: NEW_INDEX });
      const count = (countResp.body as { count: number }).count;
      console.log(
        `Destination index ${NEW_INDEX} already exists with ${count.toLocaleString()} documents.`,
      );
      console.log(
        `Reindex will continue (existing documents will be updated).\n`,
      );
    } else {
      // Create the new index with clean mappings
      console.log(`Creating index ${NEW_INDEX}...`);
      await client.indices.create({
        index: NEW_INDEX,
        body: {
          settings: {
            number_of_shards: 3,
            number_of_replicas: 0, // No replicas during reindex for speed
            "index.max_result_window": 100000,
            "index.refresh_interval": "30s", // Less frequent refresh during reindex
          },
          mappings: {
            dynamic_templates: [
              {
                tags_map_keyword: {
                  path_match: "tags_map.*",
                  mapping: { type: "keyword" },
                },
              },
            ],
            properties: {
              id: { type: "keyword" },
              pubkey: { type: "keyword" },
              created_at: { type: "long" },
              kind: { type: "integer" },
              tags: { type: "object", enabled: false },
              tags_map: { type: "object" },
              content: { type: "text", analyzer: "standard" },
              sig: { type: "keyword" },
              deleted: { type: "boolean" },
              protocol: { type: "keyword" },
            },
          },
        },
      });
      console.log(`Created index ${NEW_INDEX}\n`);
    }

    // Get source doc count
    const srcCount = await client.count({ index: OLD_INDEX });
    const totalDocs = (srcCount.body as { count: number }).count;
    console.log(
      `Source index has ${totalDocs.toLocaleString()} documents to reindex.\n`,
    );

    // Step 2: Reindex with the Painless validation script
    // Mirrors buildTagsMap: validate tag names and values
    const painlessScript = `
      Pattern tagNamePattern = /^[\\w-]{1,15}$/;
      Map tagsMap = new HashMap();
      if (ctx._source.tags != null) {
        for (def tag : ctx._source.tags) {
          if (tag != null && tag.size() >= 2) {
            String tagName = tag[0].toString();
            if (!tagNamePattern.matcher(tagName).matches()) {
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

    console.log("Starting reindex (this will take a while)...\n");

    const taskResponse = await client.reindex({
      body: {
        source: {
          index: OLD_INDEX,
          size: 1000, // Scroll batch size
        },
        dest: {
          index: NEW_INDEX,
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

    // Step 3: Restore normal index settings
    console.log("\nRestoring index settings...");
    await client.indices.putSettings({
      index: NEW_INDEX,
      body: {
        "index.number_of_replicas": 1,
        "index.refresh_interval": "1s",
      },
    });

    // Verify doc counts before swapping
    const newCount = await client.count({ index: NEW_INDEX });
    const newDocs = (newCount.body as { count: number }).count;
    const oldCount2 = await client.count({ index: OLD_INDEX });
    const oldDocs = (oldCount2.body as { count: number }).count;
    console.log(
      `\nDoc counts — Old: ${oldDocs.toLocaleString()}, New: ${newDocs.toLocaleString()}`,
    );

    // Step 4: Swap alias atomically
    console.log(
      `\nSwapping alias '${alias}' from ${OLD_INDEX} to ${NEW_INDEX}...`,
    );
    await client.indices.updateAliases({
      body: {
        actions: [
          { remove: { index: OLD_INDEX, alias } },
          { add: { index: NEW_INDEX, alias } },
        ],
      },
    });
    console.log("Alias swapped.\n");

    // Check new mapping field count
    const mappingResp = await client.indices.getMapping({ index: NEW_INDEX });
    const newMapping = mappingResp.body[NEW_INDEX] as {
      mappings: {
        properties: { tags_map?: { properties?: Record<string, unknown> } };
      };
    };
    const tagsMapFields = Object.keys(
      newMapping.mappings.properties.tags_map?.properties ?? {},
    ).length;
    console.log(`New index has ${tagsMapFields} fields in tags_map (was 604)`);

    console.log(
      `\nDone! The old index ${OLD_INDEX} can be deleted once you're satisfied:`,
    );
    console.log(`  curl -XDELETE '.../${OLD_INDEX}'`);
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
