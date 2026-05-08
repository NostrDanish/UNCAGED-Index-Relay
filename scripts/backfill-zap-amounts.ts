/**
 * Backfill script to populate the amount_msats field for existing zap events:
 *
 * - Kind 9735 (Lightning zap receipts): parse amount from the bolt11 invoice.
 * - Kind 8333 (onchain zaps): convert the `amount` tag (sats) to msats.
 *
 * Usage:
 *   bun run scripts/backfill-zap-amounts.ts
 */

import process from "node:process";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";
import { OpenSearchRelay } from "../src/opensearch.ts";

async function main() {
  console.log("Starting zap amount backfill\n");

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
    // Count zap events (kind 9735 + 8333) without amount_msats.
    const countResult = await client.count({
      index: config.opensearchIndex,
      body: {
        query: {
          bool: {
            must: [{ terms: { kind: [9735, 8333] } }],
            must_not: [{ exists: { field: "amount_msats" } }],
          },
        },
      },
    });

    const total = countResult.body.count as number;
    console.log(`Found ${total} zap events without amount_msats\n`);

    if (total === 0) {
      console.log("Nothing to backfill");
      return;
    }

    // Scroll through zap events and update in bulk
    let processed = 0;
    let updated = 0;
    let failed = 0;

    const scrollResponse = await client.search({
      index: config.opensearchIndex,
      scroll: "5m",
      body: {
        query: {
          bool: {
            must: [{ terms: { kind: [9735, 8333] } }],
            must_not: [{ exists: { field: "amount_msats" } }],
          },
        },
        size: 500,
        _source: ["kind", "tags"],
      },
    });

    let scrollId = scrollResponse.body._scroll_id as string;
    let hits = scrollResponse.body.hits.hits as unknown as Array<{
      _id: string;
      _source: { kind: number; tags: string[][] };
    }>;

    while (hits.length > 0) {
      const bulkBody: Array<Record<string, unknown>> = [];

      for (const hit of hits) {
        let amountMsats: number | undefined;

        if (hit._source.kind === 9735) {
          const bolt11Tag = hit._source.tags?.find(
            (t: string[]) => t[0] === "bolt11" && t[1],
          );
          if (bolt11Tag) {
            amountMsats = OpenSearchRelay.parseBolt11Amount(bolt11Tag[1]);
          }
        } else if (hit._source.kind === 8333) {
          // Reconstruct just enough of the event for the static helper.
          amountMsats = OpenSearchRelay.parseOnchainZapAmount({
            id: hit._id,
            pubkey: "",
            created_at: 0,
            kind: 8333,
            tags: hit._source.tags ?? [],
            content: "",
            sig: "",
          });
        }

        if (amountMsats !== undefined) {
          bulkBody.push({
            update: {
              _index: config.opensearchIndex,
              _id: hit._id,
            },
          });
          bulkBody.push({
            doc: { amount_msats: amountMsats },
          });
        }
      }

      if (bulkBody.length > 0) {
        const bulkResult = await client.bulk({ body: bulkBody });
        const items = bulkResult.body.items as Array<{
          update?: { error?: unknown };
        }>;
        for (const item of items) {
          if (item.update?.error) {
            failed++;
          } else {
            updated++;
          }
        }
      }

      processed += hits.length;
      console.log(
        `Processed ${processed}/${total} (updated: ${updated}, failed: ${failed})`,
      );

      // Get next scroll page
      const nextScroll = await client.scroll({
        scroll_id: scrollId,
        scroll: "5m",
      });
      scrollId = nextScroll.body._scroll_id as string;
      hits = nextScroll.body.hits.hits as unknown as Array<{
        _id: string;
        _source: { kind: number; tags: string[][] };
      }>;
    }

    // Clean up scroll
    await client.clearScroll({ scroll_id: scrollId });

    console.log(
      `\nBackfill completed: ${updated} updated, ${failed} failed out of ${total} total`,
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
