import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { serve } from "bun";
import { AnalyzePool } from "./analyze-pool.ts";
import { Config } from "./config.ts";
import { renderLandingPage } from "./landing-page.ts";
import { register } from "./metrics.ts";
import { OpenSearchRelay } from "./opensearch.ts";
import type { ClientOptions } from "./opensearch-client.ts";
import { Client as OpenSearchClient } from "./opensearch-client.ts";
import { Relay, type WebSocketData } from "./relay.ts";

const config = new Config({
  get(key) {
    return process.env[key];
  },
});

// Initialize analysis worker pool (signature verification, language & sentiment detection)
const analyzePool = new AnalyzePool(config.analyzePoolSize, {
  maxPending: config.analyzeMaxPending,
});

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
  tagValueMaxCountPerName: config.tagValueMaxCountPerName,
  bulkMaxQueue: config.bulkMaxQueue,
});

const relay = new Relay(opensearchRelay, {
  analyze: (event, opts) => analyzePool.analyze(event, opts),
  relayUrl: config.relayUrl,
  authKinds: config.authKinds,
  maxMessageLength: config.maxMessageLength,
  maxFilterValues: config.maxFilterValues,
  maxEventTags: config.tagValueMaxCountPerName,
  maxInflightPerConn: config.maxInflightPerConn,
  bannedHashtags: config.bannedHashtags,
  relayInfo: {
    pubkey: config.relayPubkey,
    contact: config.relayContact,
    self: await config.nostrSigner.getPublicKey(),
    icon: new URL("/icon.png", config.publicUrl).toString(),
    banner: new URL("/banner.jpg", config.publicUrl).toString(),
  },
});

// ---------------------------------------------------------------------------
// Background worker — score recomputation, NIP-85, and trends run off-thread
// so they don't block the WebSocket event loop.
// Disabled when STATS_ENABLED=false to isolate stats overhead for benchmarking.
// ---------------------------------------------------------------------------
let bgWorker: Worker | undefined;

if (config.statsEnabled) {
  bgWorker = new Worker(new URL("background-worker.ts", import.meta.url).href, {
    smol: true,
  });

  bgWorker.onmessage = (event: MessageEvent) => {
    const msg = event.data;
    if (msg.type === "broadcast") {
      relay.broadcast(msg.event);
    }
  };

  bgWorker.onerror = (error) => {
    console.error("Background worker error:", error);
  };

  // Accumulate dirty addrs/identifiers from flush callbacks. These are drained
  // and forwarded to the worker alongside the dirty IDs/pubkeys.
  const pendingDirtyAddrs = new Set<string>();
  const pendingDirtyIdentifiers = new Set<string>();
  opensearchRelay.onDirtyAddrs = (addrs) => {
    for (const addr of addrs) pendingDirtyAddrs.add(addr);
  };
  opensearchRelay.onDirtyIdentifiers = (ids) => {
    for (const id of ids) pendingDirtyIdentifiers.add(id);
  };

  // Forward dirty state from the main thread to the background worker every 2s.
  // This is lightweight — just draining Sets and posting arrays via postMessage.
  setInterval(() => {
    const dirty = opensearchRelay.drainDirty();
    const addrs = [...pendingDirtyAddrs];
    pendingDirtyAddrs.clear();
    const identifiers = [...pendingDirtyIdentifiers];
    pendingDirtyIdentifiers.clear();

    if (
      dirty.ids.length === 0 &&
      dirty.pubkeys.length === 0 &&
      addrs.length === 0 &&
      identifiers.length === 0
    ) {
      return;
    }

    bgWorker!.postMessage({
      type: "dirty",
      ids: dirty.ids,
      pubkeys: dirty.pubkeys,
      addrs,
      identifiers,
    });
  }, 2_000);
} else {
  console.log(
    "Stats disabled (STATS_ENABLED=false) — background worker not started.",
  );
}

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
    // Enforce the advertised NIP-11 max_message_length at the transport
    // layer. Frames larger than this are dropped by Bun with code 1009
    // before reaching `handleMessage` — the JSON.parse / validation path
    // never sees them.
    maxPayloadLength: config.maxMessageLength,

    open(ws) {
      relay.handleOpen(ws);
    },

    message(ws, message) {
      // Fire-and-forget: do NOT await `handleMessage` here. Awaiting would
      // serialize message processing per connection, which becomes a hard
      // bottleneck when a single client (e.g. a Bluesky bridge) pumps
      // events at firehose rates — every event would block the next on
      // analyze-worker hops + bulk-flush latency. With fire-and-forget,
      // events from one connection can fan out into the analyze pool and
      // be batched together, and OK responses come back in their natural
      // completion order (NIP-01 does not require strict OK ordering).
      // Errors thrown inside handleMessage are caught internally and
      // converted to NOTICE / OK-false responses.
      relay.handleMessage(ws, message).catch((err) => {
        // handleMessage already catches and converts errors to NOTICE
        // responses; this is just a belt-and-suspenders to prevent an
        // unhandled rejection from crashing the process.
        console.error("Unhandled error in handleMessage:", err);
      });
    },

    close(ws) {
      relay.handleCloseConnection(ws);
    },
  },
});

console.log(`Nostr relay listening on ws://localhost:${server.port}`);

// Graceful shutdown on SIGINT/SIGTERM — also ensures CPU profiles are written.
function shutdown() {
  console.log("Shutting down...");
  server.stop();
  bgWorker?.terminate();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
