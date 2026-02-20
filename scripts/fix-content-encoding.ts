/**
 * Fix events whose `content` field has double-escaped newlines.
 *
 * Some historical events (e.g. from ActivityPub bridges) were stored with
 * literal `\n` (backslash + n) in the content instead of actual newline
 * characters.  This makes the stored event ID not match the content hash,
 * effectively corrupting the event signature.
 *
 * This script scrolls through all events, recomputes each event's ID from
 * its stored fields, and when a mismatch is found it attempts to unescape
 * `\n` → newline, `\t` → tab, and `\\` → backslash.  If the unescaped
 * content produces the correct ID, the content is updated in-place.
 *
 * Usage:
 *   bun run scripts/fix-content-encoding.ts
 *   bun run scripts/fix-content-encoding.ts --dry-run
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import type { NostrEvent } from "nostr-tools";
import { getEventHash } from "nostr-tools";
import { Config } from "../src/config.ts";

/** Unescape JSON-style escape sequences that were double-escaped. */
function unescapeContent(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  console.log(`Starting content encoding fix${dryRun ? " (DRY RUN)" : ""}\n`);

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
    // Count total documents
    const countResponse = await client.count({
      index: config.opensearchIndex,
      body: { query: { match_all: {} } },
    });
    const total = (countResponse.body as { count: number }).count;
    console.log(`Total documents: ${total.toLocaleString()}\n`);

    const SCROLL_SIZE = 5000;
    const SCROLL_TTL = "4h";
    let scanned = 0;
    let fixed = 0;
    let deleted = 0;

    const initialResponse = await client.search({
      index: config.opensearchIndex,
      scroll: SCROLL_TTL,
      body: {
        size: SCROLL_SIZE,
        _source: [
          "id",
          "pubkey",
          "created_at",
          "kind",
          "tags",
          "content",
          "sig",
        ],
        query: { match_all: {} },
      },
    });

    let scrollId = initialResponse.body._scroll_id as string;
    let hits = (
      initialResponse.body.hits as unknown as {
        hits: Array<{
          _id: string;
          _source: NostrEvent;
        }>;
      }
    ).hits;

    while (hits.length > 0) {
      const bulkBody: Array<Record<string, unknown>> = [];

      for (const hit of hits) {
        const event = hit._source;

        // Recompute the event ID from the stored fields
        const computedId = getEventHash(event);

        if (computedId !== event.id) {
          // ID mismatch — try unescaping the content
          const fixedContent = unescapeContent(event.content);

          if (fixedContent === event.content) {
            // Unescaping didn't change anything — delete the corrupt event
            deleted++;
            if (!dryRun) {
              bulkBody.push({
                delete: { _index: config.opensearchIndex, _id: hit._id },
              });
            }
            continue;
          }

          const fixedEvent: NostrEvent = { ...event, content: fixedContent };
          const fixedId = getEventHash(fixedEvent);

          if (fixedId === event.id) {
            // Unescaping fixed it
            fixed++;
            if (!dryRun) {
              bulkBody.push({
                update: { _index: config.opensearchIndex, _id: hit._id },
              });
              bulkBody.push({ doc: { content: fixedContent } });
            }
          } else {
            // Unescaping didn't produce the correct ID either — delete
            deleted++;
            if (!dryRun) {
              bulkBody.push({
                delete: { _index: config.opensearchIndex, _id: hit._id },
              });
            }
          }
        }
      }

      if (bulkBody.length > 0 && !dryRun) {
        const bulkResponse = await client.bulk({
          body: bulkBody,
          refresh: false,
        });
        const bulkResult = bulkResponse.body as {
          errors: boolean;
          items: Array<{
            update?: { error?: unknown };
            delete?: { error?: unknown };
          }>;
        };

        if (bulkResult.errors) {
          const failures = bulkResult.items.filter(
            (item) => item.update?.error || item.delete?.error,
          );
          console.warn(`  ${failures.length} items failed in batch`);
        }
      }

      scanned += hits.length;
      const pct = total > 0 ? ((scanned / total) * 100).toFixed(1) : "0.0";
      console.log(
        `  Progress: ${scanned.toLocaleString()} / ${total.toLocaleString()} (${pct}%) — ${fixed.toLocaleString()} fixed, ${deleted.toLocaleString()} deleted`,
      );

      // Fetch next batch
      const scrollResponse = await client.scroll({
        scroll_id: scrollId,
        scroll: SCROLL_TTL,
      });
      scrollId = scrollResponse.body._scroll_id as string;
      hits = (
        scrollResponse.body.hits as unknown as {
          hits: Array<{
            _id: string;
            _source: NostrEvent;
          }>;
        }
      ).hits;
    }

    // Clean up scroll context
    try {
      await client.clearScroll({ scroll_id: scrollId });
    } catch {
      // Scroll may have already expired
    }

    console.log(
      `\n${dryRun ? "DRY RUN " : ""}Complete: scanned ${scanned.toLocaleString()}, fixed ${fixed.toLocaleString()}, deleted ${deleted.toLocaleString()}`,
    );
  } catch (error) {
    console.error("\nScript failed:");
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
