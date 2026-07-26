/**
 * Update all trending categories (hashtags, links, pubkeys, events, zapped events).
 * Publishes kind 1985 label events to the relay with aggregated trend data.
 *
 * Usage:
 *   bun run scripts/update-trends.ts
 */

import process from "node:process";
import { Config } from "../src/config.ts";
import { OpenSearchRelay } from "../src/opensearch.ts";
import type { ClientOptions } from "../src/opensearch-client.ts";
import { Client as OpenSearchClient } from "../src/opensearch-client.ts";
import { Trends } from "../src/trends.ts";

async function main() {
  console.log("📊 Starting trends update\n");

  const config = new Config({
    get(key: string) {
      return process.env[key];
    },
  });

  console.log(`OpenSearch Node: ${config.opensearchNode}`);
  console.log(`Index: ${config.opensearchIndex}`);
  console.log(`Relay URL: ${config.relayUrl}\n`);

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
  const relay = new OpenSearchRelay(client, {
    indexName: config.opensearchIndex,
  });
  const signer = config.nostrSigner;
  const trends = new Trends({
    client,
    indexName: config.opensearchIndex,
    relay,
  });

  const categories = [
    { name: "hashtags", fn: () => trends.updateTrendingHashtags(signer) },
    { name: "links", fn: () => trends.updateTrendingLinks(signer) },
    {
      name: "pubkeys",
      fn: () => trends.updateTrendingPubkeys(signer, config.relayUrl),
    },
    {
      name: "events",
      fn: () => trends.updateTrendingEvents(signer, config.relayUrl),
    },
    {
      name: "zapped events",
      fn: () => trends.updateTrendingZappedEvents(signer, config.relayUrl),
    },
  ];

  for (const { name, fn } of categories) {
    try {
      console.log(`Updating trending ${name}...`);
      await fn();
      console.log(`✅ Trending ${name} updated`);
    } catch (error) {
      console.error(`❌ Failed to update trending ${name}:`, error);
    }
  }

  await relay.close();
  console.log("\n✅ Trends update completed");
}

main().catch((error) => {
  console.error("\n❌ Trends update failed:", error);
  process.exit(1);
});
