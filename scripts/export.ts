/**
 * Export all events from OpenSearch to JSONL (JSON Lines) format.
 * Each line contains a complete Nostr event in JSON format.
 *
 * Usage:
 *   bun run scripts/export-events.ts > events.jsonl
 *   bun run scripts/export-events.ts --include-deleted > events.jsonl
 */

import process from "node:process";
import type { NostrEvent } from "@nostrify/nostrify";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";

interface NostrEventDocument extends NostrEvent {
  tags_map: Record<string, string[]>;
  deleted?: boolean;
  protocol?: string;
}

/**
 * Convert OpenSearch document back to NostrEvent
 */
function documentToEvent(doc: NostrEventDocument): NostrEvent {
  return {
    id: doc.id,
    pubkey: doc.pubkey,
    created_at: doc.created_at,
    kind: doc.kind,
    tags: doc.tags,
    content: doc.content,
    sig: doc.sig,
  };
}

async function main() {
  // Parse CLI arguments
  const includeDeleted = process.argv.includes("--include-deleted");

  console.error("📤 Starting event export\n");

  // Load configuration
  const config = new Config({
    get(key: string) {
      return process.env[key];
    },
  });
  console.error(`OpenSearch Node: ${config.opensearchNode}`);
  console.error(`Index: ${config.opensearchIndex}`);
  console.error(`Include deleted: ${includeDeleted}\n`);

  // Create OpenSearch client
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
    // Build query - exclude deleted events by default
    const query = includeDeleted
      ? { match_all: {} }
      : { term: { deleted: false } };

    // Count total events
    console.error("Counting events...");
    const countResult = await client.count({
      index: config.opensearchIndex,
      body: { query },
    });

    const totalEvents = (countResult.body as { count: number }).count;
    console.error(`Found ${totalEvents} events\n`);

    if (totalEvents === 0) {
      console.error("✅ No events to export");
      return;
    }

    // Use scroll API for efficient pagination
    console.error("Exporting events...");
    const scrollTimeout = "5m";
    const batchSize = 1000;
    let exportedCount = 0;

    // Initial search request
    let response = await client.search({
      index: config.opensearchIndex,
      scroll: scrollTimeout,
      body: {
        query,
        size: batchSize,
        sort: [{ created_at: { order: "desc" as const } }],
      },
    });

    let scrollId = response.body._scroll_id as string;

    // Process first batch
    let hits = response.body.hits.hits as unknown as Array<{
      _source: NostrEventDocument;
    }>;

    while (hits.length > 0) {
      // Export events to stdout as JSONL
      for (const hit of hits) {
        const event = documentToEvent(hit._source);
        console.log(JSON.stringify(event));
        exportedCount++;
      }

      // Progress update to stderr (so it doesn't interfere with JSONL output)
      console.error(
        `Progress: ${exportedCount}/${totalEvents} (${Math.round((exportedCount / totalEvents) * 100)}%)`,
      );

      // Get next batch
      response = await client.scroll({
        scroll_id: scrollId,
        scroll: scrollTimeout,
      });

      scrollId = response.body._scroll_id as string;
      hits = response.body.hits.hits as unknown as Array<{
        _source: NostrEventDocument;
      }>;
    }

    // Clear scroll context
    await client.clearScroll({
      scroll_id: scrollId,
    });

    console.error(`\n✅ Exported ${exportedCount} events successfully`);
  } catch (error) {
    console.error("\n❌ Export failed:");
    if (error && typeof error === "object" && "meta" in error) {
      const meta = (error as { meta?: { body?: unknown } }).meta;
      console.error(JSON.stringify(meta?.body, null, 2));
    } else {
      console.error(error);
    }
    process.exit(1);
  } finally {
    // Close connection
    await client.close();
  }
}

main();
