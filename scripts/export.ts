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

    // Use search_after for cursor-based pagination (no server-side state, runs indefinitely)
    console.error("Exporting events...");
    const batchSize = 1000;
    const maxRetries = 10;
    const retryBaseDelay = 5000; // 5 seconds base delay for retries
    let exportedCount = 0;
    let searchAfter: [number, string] | undefined;

    while (true) {
      const searchBody: Record<string, unknown> = {
        query,
        size: batchSize,
        sort: [
          { created_at: { order: "desc" as const } },
          { id: { order: "desc" as const } },
        ],
        // Disable request cache to reduce memory pressure
        request_cache: false,
      };

      if (searchAfter) {
        searchBody.search_after = searchAfter;
      }

      // Retry loop for transient errors (circuit breaker, 429, etc.)
      let hits: Array<{
        _source: NostrEventDocument;
        sort: [number, string];
      }>;

      let retries = 0;
      while (true) {
        try {
          const response = await client.search({
            index: config.opensearchIndex,
            body: searchBody,
          });

          hits = response.body.hits.hits as unknown as typeof hits;
          break;
        } catch (error) {
          const status = (error as { meta?: { statusCode?: number } }).meta
            ?.statusCode;
          if (status === 429 && retries < maxRetries) {
            retries++;
            const delay = retryBaseDelay * retries;
            console.error(
              `⚠️  Circuit breaker hit (attempt ${retries}/${maxRetries}), waiting ${delay / 1000}s...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          throw error;
        }
      }

      if (hits.length === 0) {
        break;
      }

      // Export events to stdout as JSONL
      for (const hit of hits) {
        const event = documentToEvent(hit._source);
        console.log(JSON.stringify(event));
        exportedCount++;
      }

      // Progress update to stderr (so it doesn't interfere with JSONL output)
      if (exportedCount % 10000 === 0 || hits.length < batchSize) {
        console.error(
          `Progress: ${exportedCount}/${totalEvents} (${Math.round((exportedCount / totalEvents) * 100)}%)`,
        );
      }

      // Set cursor for next page
      searchAfter = hits[hits.length - 1].sort;
    }

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
