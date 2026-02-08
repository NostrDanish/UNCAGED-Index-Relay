import process from "node:process";
import { serve } from "bun";

import { Config } from "./config.ts";
import { OpenSearchRelay } from "./opensearch.ts";
import { Relay, type WebSocketData } from "./relay.ts";

const config = new Config({
  get(key) {
    return process.env[key];
  },
});

// Initialize OpenSearch relay
const opensearchRelay = OpenSearchRelay.fromConfig(config);
const relay = new Relay(opensearchRelay);

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
// Enable reusePort when running in cluster mode (WORKER_ID is set)
const server = serve<WebSocketData>({
  port: config.port,
  reusePort: !!process.env.WORKER_ID,
  fetch(req, server) {
    const url = new URL(req.url);

    // Handle WebSocket upgrade
    if (url.pathname === "/" && req.headers.get("upgrade") === "websocket") {
      const upgraded = server.upgrade(req, {
        data: {
          subscriptions: new Map(),
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

const workerId = process.env.WORKER_ID || "main";
console.log(
  `Nostr relay [${workerId}] listening on ws://localhost:${server.port}${process.env.WORKER_ID ? " (SO_REUSEPORT)" : ""}`,
);
