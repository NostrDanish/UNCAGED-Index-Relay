import process from "node:process";
import { serve } from "bun";

import { AnalyzePool } from "./analyze-pool.ts";
import { Config } from "./config.ts";
import { OpenSearchRelay } from "./opensearch.ts";
import { Relay, type WebSocketData } from "./relay.ts";

const config = new Config({
  get(key) {
    return process.env[key];
  },
});

// Initialize analysis worker pool (signature verification, language & sentiment detection)
const analyzePool = new AnalyzePool();

// Initialize OpenSearch relay
const opensearchRelay = OpenSearchRelay.fromConfig(config);
const relay = new Relay(opensearchRelay, {
  analyze: (event) => analyzePool.analyze(event),
  relayUrl: config.relayUrl,
  relayInfo: {
    pubkey: config.relayPubkey,
    contact: config.relayContact,
  },
});

// Initialize index on startup
try {
  await opensearchRelay.migrate();
  console.log("Connected to OpenSearch and initialized index");
} catch (error) {
  console.error("Failed to connect to OpenSearch:", error);
  console.error(`Make sure OpenSearch is running at ${config.opensearchNode}`);
  process.exit(1);
}

// Create Bun server with WebSocket support
const server = serve<WebSocketData>({
  port: config.port,
  fetch(req, server) {
    const url = new URL(req.url);

    // Handle WebSocket upgrade
    if (url.pathname === "/" && req.headers.get("upgrade") === "websocket") {
      const upgraded = server.upgrade(req, {
        data: {
          subscriptions: new Map(),
          challenge: "",
          authedPubkeys: new Set(),
        },
      });

      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      return undefined;
    }

    // Handle NIP-11 relay information document
    if (url.pathname === "/" && req.method === "GET") {
      const acceptHeader = req.headers.get("accept");

      if (acceptHeader?.includes("application/nostr+json")) {
        return new Response(JSON.stringify(relay.getRelayInfo()), {
          headers: {
            "Content-Type": "application/nostr+json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      return new Response(
        "This is a Nostr relay. Connect using a WebSocket client or add application/nostr+json Accept header for relay info.",
        {
          headers: {
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
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

// Background job: recompute engagement scores for dirty events.
const SCORE_RECOMPUTE_INTERVAL_MS = 30_000;
setInterval(() => {
  opensearchRelay.recomputeScores().catch((err) => {
    console.error("Score recomputation failed:", err);
  });
}, SCORE_RECOMPUTE_INTERVAL_MS);
