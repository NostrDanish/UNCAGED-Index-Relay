import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { ServerWebSocket } from "bun";
import { serve } from "bun";
import { Config } from "./config.ts";
import { renderLandingPage } from "./landing-page.ts";
import { errFields, Logger } from "./log.ts";
import { mergeExposition, register, startRuntimeMetrics } from "./metrics.ts";
import { OpenSearchRelay } from "./opensearch.ts";
import type { ClientOptions } from "./opensearch-client.ts";
import { Client as OpenSearchClient } from "./opensearch-client.ts";
import {
  type DirtyBatch,
  ProtocolPool,
  resolveProtocolWorkers,
} from "./protocol-pool.ts";

const config = new Config({
  get(key) {
    return process.env[key];
  },
});

// Single structured logger for this process, passed down into every
// component that logs.
const log = new Logger(config.logLevel);

/** Per-socket data attached at upgrade time. */
interface WebSocketData {
  ip?: string;
  userAgent?: string;
  /** Routing key for the protocol pool, assigned at upgrade time. */
  connId: number;
}

/** Monotonic connection ID source, unique for the process lifetime. */
let nextConnId = 1;

const opensearchClientOptions: ClientOptions = {
  node: config.opensearchNode,
};
if (config.opensearchUsername && config.opensearchPassword) {
  opensearchClientOptions.auth = {
    username: config.opensearchUsername,
    password: config.opensearchPassword,
  };
}

/**
 * Forwards dirty-reference batches to the background stats worker. Assigned
 * when the worker is spawned (below); the pool calls it via this indirection
 * because the pool is created before the worker exists.
 */
let forwardDirty: ((dirty: DirtyBatch) => void) | undefined;

const workerCount = resolveProtocolWorkers(config.protocolWorkers);

// N protocol workers own all protocol state and per-message work; the main
// thread only routes strings between sockets and workers.

// Run index migration once, before workers spawn, with a short-lived
// client — workers skip migration so N of them don't race on it.
try {
  const migrateRelay = new OpenSearchRelay(
    new OpenSearchClient(opensearchClientOptions),
    { indexName: config.opensearchIndex, logger: log },
  );
  await migrateRelay.migrate();
  log.info("opensearch_connected", { node: config.opensearchNode });
} catch (error) {
  log.error("opensearch_connect_failed", {
    node: config.opensearchNode,
    ...errFields(error),
  });
  process.exit(1);
}

const sockets = new Map<number, ServerWebSocket<WebSocketData>>();

const pool = new ProtocolPool(workerCount, {
  logger: log,
  sendFrame: (connId, frame) => {
    sockets.get(connId)?.send(frame);
  },
  onDirty: (dirty) => forwardDirty?.(dirty),
  onConnectionsLost: (connIds) => {
    // A protocol worker died and took these connections' protocol state
    // (subscriptions, auth, negentropy) with it. Close the sockets so
    // clients reconnect cleanly onto the respawned worker.
    for (const connId of connIds) {
      const ws = sockets.get(connId);
      sockets.delete(connId);
      ws?.close(1011, "relay worker restarted, please reconnect");
    }
  },
});

const relayInfo = await pool.start();
log.info("protocol_pool_started", { workers: workerCount });

// ---------------------------------------------------------------------------
// Background worker — score recomputation, NIP-85, and trends run off-thread
// so they don't block the WebSocket event loop.
// Disabled when STATS_ENABLED=false to isolate stats overhead for benchmarking.
// ---------------------------------------------------------------------------
let bgWorker: Worker | undefined;

if (config.statsEnabled) {
  const worker = new Worker(
    new URL("background-worker.ts", import.meta.url).href,
    { smol: true },
  );
  bgWorker = worker;

  worker.onmessage = (event: MessageEvent) => {
    const msg = event.data;
    if (msg.type === "broadcast") {
      pool.broadcastExternal(msg.events);
    }
  };

  worker.onerror = (error) => {
    log.error("bg_worker_error", { err_msg: error.message });
  };

  forwardDirty = (dirty) => {
    worker.postMessage({
      type: "dirty",
      ids: dirty.ids,
      pubkeys: dirty.pubkeys,
      addrs: dirty.addrs,
      identifiers: dirty.identifiers,
    });
  };
} else {
  log.info("stats_disabled");
}

// Sample event-loop lag and memory usage for /metrics.
startRuntimeMetrics();

// Pre-render the HTML landing page and the NIP-11 document (relay info is
// static after startup, so both are cached as strings).
const landingPageHtml = renderLandingPage(relayInfo, config.relayUrl, log);
const nip11Json = JSON.stringify(relayInfo, null, 2);

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
      // Client identity for logging/abuse analysis. Behind a reverse proxy
      // the socket peer is the proxy, so IP_HEADER names the trusted header
      // carrying the real client IP; without it, use the socket address.
      const ip = config.ipHeader
        ? req.headers.get(config.ipHeader)?.split(",")[0]?.trim() || undefined
        : server.requestIP(req)?.address;
      const userAgent = req.headers.get("user-agent") ?? undefined;

      const upgraded = server.upgrade(req, {
        data: { ip, userAgent, connId: nextConnId++ },
      });

      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      return undefined;
    }

    // HEAD is served by the same handlers as GET: Bun strips the body from
    // the response and keeps the headers, which is what HEAD callers
    // (`curl -I`, health checks, NIP-11 probes) expect.
    if (req.method === "GET" || req.method === "HEAD") {
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

      // Prometheus metrics endpoint: merge this thread's exposition with
      // every protocol worker's.
      if (url.pathname === "/metrics") {
        const [main, workers] = await Promise.all([
          register.metrics(),
          pool.metrics(),
        ]);
        const metrics = mergeExposition([
          { label: "main", text: main },
          ...workers,
        ]);
        return new Response(metrics, {
          headers: { "Content-Type": register.contentType },
        });
      }

      // Handle NIP-11 relay information document
      if (url.pathname === "/") {
        const acceptHeader = req.headers.get("accept");

        if (acceptHeader?.includes("application/nostr+json")) {
          return new Response(nip11Json, {
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
    // before reaching the protocol layer — the JSON.parse / validation path
    // never sees them.
    maxPayloadLength: config.maxMessageLength,

    open(ws) {
      sockets.set(ws.data.connId, ws);
      pool.open(ws.data.connId, ws.data.ip, ws.data.userAgent);
    },

    message(ws, message) {
      // Normalize to a string on this side of the boundary: strings cross
      // postMessage as flat copies, and the Relay parses from string anyway.
      pool.message(
        ws.data.connId,
        typeof message === "string" ? message : message.toString(),
      );
    },

    close(ws) {
      sockets.delete(ws.data.connId);
      pool.close(ws.data.connId);
    },
  },
});

log.info("started", {
  port: server.port,
  log_level: config.logLevel,
  protocol_workers: workerCount,
});

// Graceful shutdown on SIGINT/SIGTERM — also ensures CPU profiles are written.
async function shutdown() {
  log.info("shutdown");
  server.stop();
  // Bounded cleanup: waiting on worker teardown keeps the exit clean, but a
  // wedged worker must never be able to hang the shutdown path.
  const cleanup = Promise.all([pool.dispose(), bgWorker?.terminate()]);
  const timeout = new Promise((resolve) => setTimeout(resolve, 5_000));
  await Promise.race([cleanup, timeout]);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
