import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { ClientOptions } from "@opensearch-project/opensearch";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { serve } from "bun";

import { AnalyzePool } from "./analyze-pool.ts";
import { Config } from "./config.ts";
import { renderLandingPage } from "./landing-page.ts";
import { register } from "./metrics.ts";
import { Nip85 } from "./nip85.ts";
import { OpenSearchRelay } from "./opensearch.ts";
import { Relay, type WebSocketData } from "./relay.ts";
import { Trends } from "./trends.ts";

const config = new Config({
  get(key) {
    return process.env[key];
  },
});

// Initialize analysis worker pool (signature verification, language & sentiment detection)
const analyzePool = new AnalyzePool();

// Construct OpenSearch clients. Read and write operations use separate clients
// so that long-running write operations (e.g. bulk flushes with
// `refresh: "wait_for"`) cannot starve the connection pool used by queries.
const opensearchClientOptions: ClientOptions = {
  node: config.opensearchNode,
};
if (config.opensearchUsername && config.opensearchPassword) {
  opensearchClientOptions.auth = {
    username: config.opensearchUsername,
    password: config.opensearchPassword,
  };
}
const opensearchReadClient = new OpenSearchClient(opensearchClientOptions);
const opensearchWriteClient = new OpenSearchClient(opensearchClientOptions);

// Initialize OpenSearch relay
const opensearchRelay = new OpenSearchRelay(opensearchReadClient, {
  indexName: config.opensearchIndex,
  historyEnabled: config.historyEnabled,
  historyKindsWhitelist: config.historyKindsWhitelist,
  historyKindsExcluded: config.historyKindsExcluded,
  authKinds: config.authKinds,
  writeClient: opensearchWriteClient,
});

const relay = new Relay(opensearchRelay, {
  analyze: (event) => analyzePool.analyze(event),
  relayUrl: config.relayUrl,
  authKinds: config.authKinds,
  relayInfo: {
    pubkey: config.relayPubkey,
    contact: config.relayContact,
    self: await config.nostrSigner.getPublicKey(),
    icon: new URL("/icon.png", config.publicUrl).toString(),
    banner: new URL("/banner.jpg", config.publicUrl).toString(),
  },
});

// Initialize NIP-85 publisher.
const signer = config.nostrSigner;
const nip85 = new Nip85({
  client: opensearchReadClient,
  indexName: config.opensearchIndex,
  relay: opensearchRelay,
  signer,
  broadcast: (event) => relay.broadcast(event),
});

// Wire up dirty tracking callbacks for NIP-85 kinds 30384 and 30385.
opensearchRelay.onDirtyAddrs = (addrs) => nip85.addDirtyAddrs(addrs);
opensearchRelay.onDirtyIdentifiers = (ids) => nip85.addDirtyIdentifiers(ids);

// Initialize index on startup
try {
  await opensearchRelay.migrate();
  console.log("Connected to OpenSearch and initialized index");
} catch (error) {
  console.error("Failed to connect to OpenSearch:", error);
  console.error(`Make sure OpenSearch is running at ${config.opensearchNode}`);
  process.exit(1);
}

// Pre-render the HTML landing page (relay info is static after startup).
const landingPageHtml = renderLandingPage(
  relay.getRelayInfo(),
  config.relayUrl,
);

// Pre-load static assets into memory.
const faviconIco = await readFile(
  fileURLToPath(new URL("../public/favicon.ico", import.meta.url)),
);
const iconPng = await readFile(
  fileURLToPath(new URL("../public/icon.png", import.meta.url)),
);
const bannerJpg = await readFile(
  fileURLToPath(new URL("../public/banner.jpg", import.meta.url)),
);

// Create Bun server with WebSocket support
const server = serve<WebSocketData>({
  port: config.port,
  async fetch(req, server) {
    const url = new URL(req.url);

    // Handle WebSocket upgrade
    if (url.pathname === "/" && req.headers.get("upgrade") === "websocket") {
      const upgraded = server.upgrade(req, {
        data: {
          subscriptions: new Map(),
          challenge: "",
          challengeSent: false,
          authedPubkeys: new Set(),
        },
      });

      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      return undefined;
    }

    if (req.method === "GET") {
      // Serve static assets
      if (url.pathname === "/favicon.ico") {
        return new Response(faviconIco, {
          headers: { "Content-Type": "image/x-icon" },
        });
      }
      if (url.pathname === "/icon.png") {
        return new Response(iconPng, {
          headers: { "Content-Type": "image/png" },
        });
      }
      if (url.pathname === "/banner.jpg") {
        return new Response(bannerJpg, {
          headers: { "Content-Type": "image/jpeg" },
        });
      }

      // Prometheus metrics endpoint
      if (url.pathname === "/metrics") {
        const metrics = await register.metrics();
        return new Response(metrics, {
          headers: { "Content-Type": register.contentType },
        });
      }

      // Handle NIP-11 relay information document
      if (url.pathname === "/") {
        const acceptHeader = req.headers.get("accept");

        if (acceptHeader?.includes("application/nostr+json")) {
          return new Response(JSON.stringify(relay.getRelayInfo(), null, 2), {
            headers: {
              "Content-Type": "application/nostr+json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        return new Response(landingPageHtml, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws) {
      relay.handleOpen(ws);
    },

    async message(ws, message) {
      await relay.handleMessage(ws, message);
    },

    close(ws) {
      relay.handleCloseConnection(ws);
    },
  },
});

console.log(`Nostr relay listening on ws://localhost:${server.port}`);

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

// Recompute engagement scores for dirty events and publish NIP-85 assertions.
// Runs every 5s; effectively no-ops when no dirty events remain.
const SCORE_RECOMPUTE_INTERVAL_MS = 5_000;
setInterval(async () => {
  try {
    const result = await opensearchRelay.recomputeScores();
    if (result.count > 0) {
      await Promise.all([
        nip85.publishUserStats(result.userScores),
        nip85.publishEventStats(result.eventScores),
      ]);
    }
    await nip85.flushAddrStats();
    await nip85.flushIdentifierStats();
  } catch (err) {
    console.error("Score recomputation / NIP-85 failed:", err);
  }
}, SCORE_RECOMPUTE_INTERVAL_MS);

// Periodically compute and publish trending events (kind 1985).
const trendsIntervalMs = config.trendsIntervalMs;
if (trendsIntervalMs > 0) {
  const trends = new Trends({
    client: opensearchReadClient,
    indexName: config.opensearchIndex,
    relay: opensearchRelay,
    broadcast: (event) => relay.broadcast(event),
  });
  const relayUrl = config.relayUrl;
  const preferredLanguages = config.preferredLanguages;

  const updateAllTrends = async () => {
    console.log("Updating trends...");
    await trends.updateTrendingHashtags(signer);
    await trends.updateTrendingLinks(signer);
    await trends.updateTrendingPubkeys(signer, relayUrl);
    await trends.updateTrendingEvents(signer, relayUrl);
    await trends.updateTrendingZappedEvents(signer, relayUrl);
    if (preferredLanguages.length > 0) {
      await trends.updateTrendingEventsByLanguage(
        signer,
        relayUrl,
        preferredLanguages,
      );
    }
    console.log("Trends updated.");
  };

  setInterval(() => {
    updateAllTrends().catch((err) =>
      console.error("Trends update failed:", err),
    );
  }, trendsIntervalMs);

  const langInfo =
    preferredLanguages.length > 0
      ? ` + languages: ${preferredLanguages.join(", ")}`
      : "";
  console.log(
    `Trends scheduling enabled (every ${(trendsIntervalMs / 60_000).toFixed(0)} min${langInfo})`,
  );
}
