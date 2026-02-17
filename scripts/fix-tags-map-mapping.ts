/**
 * Fix tags_map mapping by creating a new index with proper configuration
 * and reindexing all documents from the old index.
 *
 * Problem: tags_map has dynamic mapping enabled, causing inefficient
 * individual keyword mappings for every tag name encountered.
 *
 * Solution: Create new index with tags_map as flattened field type,
 * which efficiently handles dynamic keys without creating individual mappings.
 *
 * Usage:
 *   bun run scripts/fix-tags-map-mapping.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";

async function main() {
  console.log("🔧 Starting tags_map mapping fix\n");

  const config = new Config({
    get(key: string) {
      return process.env[key];
    },
  });
  console.log(`OpenSearch Node: ${config.opensearchNode}`);
  console.log(`Current Index: ${config.opensearchIndex}\n`);

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
    // Step 1: Check if current index is an alias or actual index
    console.log("Step 1: Checking current index configuration...");
    const aliasResponse = await client.cat.aliases({
      name: config.opensearchIndex,
      format: "json",
    });

    const aliases = aliasResponse.body as Array<{
      alias: string;
      index: string;
    }>;

    let currentIndex: string;
    let isAlias = false;

    if (aliases.length > 0) {
      currentIndex = aliases[0].index;
      isAlias = true;
      console.log(
        `  ✓ ${config.opensearchIndex} is an alias pointing to ${currentIndex}`,
      );
    } else {
      currentIndex = config.opensearchIndex;
      console.log(`  ✓ ${config.opensearchIndex} is a direct index`);
    }

    // Step 2: Get current index settings and mappings
    console.log("\nStep 2: Retrieving current index configuration...");
    const indexResponse = await client.indices.get({
      index: currentIndex,
    });

    const indexConfig = (
      indexResponse.body as Record<
        string,
        { settings: unknown; mappings: unknown }
      >
    )[currentIndex];
    const currentSettings = indexConfig.settings;
    const currentMappings = indexConfig.mappings as {
      properties?: Record<string, unknown>;
    };

    console.log("  ✓ Retrieved current configuration");

    // Step 3: Create new index name
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .split("T")[0];
    const newIndexName = `${config.opensearchIndex}-${timestamp}`;
    console.log(`\nStep 3: Creating new index: ${newIndexName}`);

    // Step 4: Prepare new mappings with flattened tags_map
    const newMappings = {
      ...currentMappings,
      properties: {
        ...currentMappings.properties,
        tags_map: {
          type: "flattened",
        },
      },
    };

    // Create new index with fixed mapping
    await client.indices.create({
      index: newIndexName,
      body: {
        settings: currentSettings as Record<string, unknown>,
        mappings: newMappings as Record<string, unknown>,
      },
    });

    console.log("  ✓ New index created with flattened tags_map field");

    // Step 5: Count documents to reindex
    console.log("\nStep 4: Counting documents to reindex...");
    const countResponse = await client.count({
      index: currentIndex,
    });
    const totalDocs = (countResponse.body as { count: number }).count;
    console.log(`  ✓ Found ${totalDocs.toLocaleString()} documents to reindex`);

    // Step 6: Reindex data
    console.log(
      `\nStep 5: Reindexing from ${currentIndex} to ${newIndexName}...`,
    );
    console.log("  (This may take a while for large datasets)\n");

    const reindexResponse = await client.reindex({
      body: {
        source: {
          index: currentIndex,
        },
        dest: {
          index: newIndexName,
        },
      },
      wait_for_completion: false,
      refresh: true,
    });

    const taskId = (reindexResponse.body as { task: string }).task;
    console.log(`  ✓ Reindex task started: ${taskId}`);

    // Poll task status
    let completed = false;
    let lastProgress = 0;

    while (!completed) {
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds

      const taskResponse = await client.tasks.get({
        task_id: taskId,
      });

      const task = taskResponse.body as {
        completed: boolean;
        task: { status: { created: number; total: number } };
      };

      completed = task.completed;

      if (task.task?.status) {
        const progress = task.task.status.created;
        const total = task.task.status.total || totalDocs;
        const percentage =
          total > 0 ? ((progress / total) * 100).toFixed(2) : 0;

        if (progress !== lastProgress) {
          console.log(
            `  Progress: ${progress.toLocaleString()} / ${total.toLocaleString()} (${percentage}%)`,
          );
          lastProgress = progress;
        }
      }
    }

    console.log("  ✓ Reindex completed\n");

    // Step 7: Update alias or inform user
    console.log("Step 6: Updating configuration...");

    if (isAlias) {
      // Remove old index from alias and add new index
      await client.indices.updateAliases({
        body: {
          actions: [
            {
              remove: {
                index: currentIndex,
                alias: config.opensearchIndex,
              },
            },
            {
              add: {
                index: newIndexName,
                alias: config.opensearchIndex,
              },
            },
          ],
        },
      });
      console.log(
        `  ✓ Updated alias ${config.opensearchIndex} to point to ${newIndexName}`,
      );
    } else {
      // Create alias pointing to new index
      await client.indices.putAlias({
        index: newIndexName,
        name: config.opensearchIndex,
      });
      console.log(
        `  ✓ Created alias ${config.opensearchIndex} pointing to ${newIndexName}`,
      );
    }

    // Step 8: Cleanup
    console.log("\nStep 7: Cleanup...");
    console.log(`  Old index ${currentIndex} is still available for rollback`);
    console.log(`  To delete it after verification, run:`);
    console.log(`    curl -X DELETE "http://localhost:9200/${currentIndex}"`);

    console.log("\n✅ Migration completed successfully!");
    console.log("\nNext steps:");
    console.log("  1. Verify the new index is working correctly");
    console.log("  2. Monitor for any issues");
    console.log(`  3. Delete the old index: ${currentIndex}`);
  } catch (error) {
    console.error("\n❌ Migration failed:");
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
