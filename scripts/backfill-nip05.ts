/**
 * Backfill script to verify NIP-05 identifiers and populate `nip05_domain`
 * and `nip05_hostname` fields for existing kind 0 (metadata) documents.
 *
 * Scrolls through all kind 0 documents missing a `nip05_domain` field,
 * parses the NIP-05 identifier from content, verifies it via HTTP lookup,
 * and bulk-updates the results.
 *
 * Usage:
 *   bun run scripts/backfill-nip05.ts
 */

import process from "node:process";
import { NIP05, NSchema as n } from "@nostrify/nostrify";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { parse as parseDomain } from "tldts";
import { Config } from "../src/config.ts";

/** NIP-05 verification timeout in milliseconds. */
const NIP05_TIMEOUT_MS = 5000;

/** Maximum concurrent NIP-05 lookups per batch. */
const CONCURRENCY = 10;

/**
 * Verify a NIP-05 identifier and return the domain/hostname if valid.
 */
async function verifyNip05(
  nip05Value: string,
  pubkey: string,
): Promise<{ nip05_domain: string; nip05_hostname: string } | null> {
  try {
    const pointer = await NIP05.lookup(nip05Value, {
      signal: AbortSignal.timeout(NIP05_TIMEOUT_MS),
    });

    if (pointer.pubkey !== pubkey) return null;

    const match = nip05Value.match(NIP05.regex());
    if (!match) return null;
    const [, , hostname] = match;

    const parsed = parseDomain(hostname);
    if (!parsed.domain) return null;

    return {
      nip05_domain: parsed.domain,
      nip05_hostname: hostname.toLowerCase(),
    };
  } catch {
    return null;
  }
}

async function main() {
  console.log("Starting NIP-05 domain field backfill\n");

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
    // Add the new field mappings if they don't already exist.
    try {
      await client.indices.putMapping({
        index: config.opensearchIndex,
        body: {
          properties: {
            nip05_domain: { type: "keyword" },
            nip05_hostname: { type: "keyword" },
          },
        },
      });
      console.log(
        "Ensured `nip05_domain` and `nip05_hostname` mappings exist on the index.\n",
      );
    } catch (e) {
      console.warn("Warning: could not update mapping (may already exist):", e);
    }

    // Count kind 0 documents missing the nip05_domain field
    const countResponse = await client.count({
      index: config.opensearchIndex,
      body: {
        query: {
          bool: {
            must: [{ term: { kind: 0 } }],
            must_not: [{ exists: { field: "nip05_domain" } }],
          },
        },
      },
    });
    const total = (countResponse.body as { count: number }).count;
    console.log(
      `Found ${total.toLocaleString()} kind 0 documents without a nip05_domain field.\n`,
    );

    if (total === 0) {
      console.log("Nothing to do.");
      return;
    }

    // Scroll through kind 0 documents missing the nip05_domain field
    const SCROLL_SIZE = 200;
    const SCROLL_TTL = "2h";
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    const initialResponse = await client.search({
      index: config.opensearchIndex,
      scroll: SCROLL_TTL,
      body: {
        size: SCROLL_SIZE,
        _source: ["pubkey", "content"],
        query: {
          bool: {
            must: [{ term: { kind: 0 } }],
            must_not: [{ exists: { field: "nip05_domain" } }],
          },
        },
      },
    });

    let scrollId = initialResponse.body._scroll_id as string;
    let hits = (
      initialResponse.body.hits as unknown as {
        hits: Array<{
          _id: string;
          _source: { pubkey: string; content: string };
        }>;
      }
    ).hits;

    while (hits.length > 0) {
      const bulkBody: Array<Record<string, unknown>> = [];

      // Process hits in batches with limited concurrency
      for (let i = 0; i < hits.length; i += CONCURRENCY) {
        const batch = hits.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (hit) => {
            const { pubkey, content } = hit._source;

            // Parse NIP-05 from content
            const parseResult = n.json().pipe(n.metadata()).safeParse(content);
            if (!parseResult.success || !parseResult.data.nip05) {
              return { id: hit._id, result: null, reason: "no-nip05" };
            }

            const result = await verifyNip05(parseResult.data.nip05, pubkey);
            return { id: hit._id, result, reason: result ? "ok" : "failed" };
          }),
        );

        for (const { id, result, reason } of results) {
          if (result) {
            bulkBody.push({
              update: { _index: config.opensearchIndex, _id: id },
            });
            bulkBody.push({ doc: result });
          } else if (reason === "no-nip05") {
            skipped++;
          } else {
            failed++;
          }
        }
      }

      if (bulkBody.length > 0) {
        const bulkResponse = await client.bulk({
          body: bulkBody,
          refresh: false,
        });
        const bulkResult = bulkResponse.body as {
          errors: boolean;
          items: Array<{ update?: { error?: unknown } }>;
        };

        const batchUpdated = bulkResult.items.filter(
          (item) => !item.update?.error,
        ).length;
        updated += batchUpdated;

        if (bulkResult.errors) {
          const failures = bulkResult.items.filter(
            (item) => item.update?.error,
          );
          console.warn(`  ${failures.length} items failed in batch`);
        }
      }

      const processed = updated + skipped + failed;
      const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : "0.0";
      console.log(
        `  Progress: ${processed.toLocaleString()} / ${total.toLocaleString()} (${pct}%) — ${updated.toLocaleString()} updated, ${skipped.toLocaleString()} skipped, ${failed.toLocaleString()} failed verification`,
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
            _source: { pubkey: string; content: string };
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
      `\nBackfill completed: ${updated.toLocaleString()} documents updated, ${skipped.toLocaleString()} skipped (no NIP-05), ${failed.toLocaleString()} failed verification`,
    );
  } catch (error) {
    console.error("\nBackfill failed:");
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
