import type { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { NostrRelayInfo } from "@nostrify/nostrify";
import type { ServerWebSocket } from "bun";
import { serve } from "bun";
import type { NostrEvent } from "nostr-tools";
import { AnalyzePool } from "./analyze-pool.ts";
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
import { createConnData, Relay, type RelayConn } from "./relay.ts";

const config = new Config({
  get(key) {
    return process.env[key];
  },
});

// Single structured logger for this process, passed down into every
// component that logs.
const log = new Logger(config.logLevel);

/**
 * Per-socket data attached at upgrade time. Which fields are used depends on
 * the mode: worker mode routes by `connId`; in-process mode attaches the
 * `RelayConn` wrapper directly.
 */
interface WebSocketData {
  ip?: string;
  userAgent?: string;
  /** Worker mode: routing key for the protocol pool. */
  connId?: number;
  /** In-process mode: the connection handle passed to the Relay. */
  conn?: RelayConn;
}

/** Monotonic connection ID source, unique for the process lifetime. */
let nextConnId = 1;

/**
 * The mode-specific surface the WebSocket/HTTP handlers talk to. Worker mode
 * implements this over the ProtocolPool; in-process mode over a local Relay.
 */
interface Frontend {
  relayInfo: NostrRelayInfo;
  open(ws: ServerWebSocket<WebSocketData>): void;
  message(ws: ServerWebSocket<WebSocketData>, message: string | Buffer): void;
  close(ws: ServerWebSocket<WebSocketData>): void;
  /** Prometheus exposition text for /metrics (all threads). */
  metrics(): Promise<string>;
  /**
   * Inject events (from the background stats worker) for broadcast, as
   * serialized NostrEvent JSON — pre-stringified by the bg worker so the
   * main thread forwards them without touching the payload.
   */
  broadcastExternal(events: string[]): void;
  dispose(): Promise<void>;
}

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
 * when the worker is spawned (below); frontends call it via this indirection
 * because the worker needs the frontend first (for broadcastExternal).
 */
let forwardDirty: ((dirty: DirtyBatch) => void) | undefined;

const workerCount = resolveProtocolWorkers(config.protocolWorkers);

let frontend: Frontend;

if (workerCount > 0) {
  // -------------------------------------------------------------------------
  // Worker mode: N protocol workers own all protocol state and per-message
  // work. The main thread routes strings between sockets and workers.
  // -------------------------------------------------------------------------

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

  frontend = {
    relayInfo,
    open(ws) {
      const connId = nextConnId++;
      ws.data.connId = connId;
      sockets.set(connId, ws);
      pool.open(connId, ws.data.ip, ws.data.userAgent);
    },
    message(ws, message) {
      const connId = ws.data.connId;
      if (connId === undefined) return;
      // Normalize to a string on this side of the boundary: strings cross
      // postMessage as flat copies, and the Relay parses from string anyway.
      pool.message(
        connId,
        typeof message === "string" ? message : message.toString(),
      );
    },
    close(ws) {
      const connId = ws.data.connId;
      if (connId === undefined) return;
      sockets.delete(connId);
      pool.close(connId);
    },
    async metrics() {
      const [main, workers] = await Promise.all([
        register.metrics(),
        pool.metrics(),
      ]);
      return mergeExposition([{ label: "main", text: main }, ...workers]);
    },
    broadcastExternal(events) {
      pool.broadcastExternal(events);
    },
    dispose: () => pool.dispose(),
  };
} else {
  // -------------------------------------------------------------------------
  // In-process fallback (PROTOCOL_WORKERS=0): the full relay runs on the
  // main thread with the analyze worker pool, as before protocol workers.
  // -------------------------------------------------------------------------

  const analyzePool = new AnalyzePool(config.analyzePoolSize, {
    maxPending: config.analyzeMaxPending,
    logger: log,
  });

  // Separate read/write clients so bulk flushes can't starve queries.
  const opensearchRelay = new OpenSearchRelay(
    new OpenSearchClient(opensearchClientOptions),
    {
      indexName: config.opensearchIndex,
      historyEnabled: config.historyEnabled,
      historyKindsWhitelist: config.historyKindsWhitelist,
      historyKindsExcluded: config.historyKindsExcluded,
      authKinds: config.authKinds,
      writeClient: new OpenSearchClient(opensearchClientOptions),
      tagValueMaxCountPerName: config.tagValueMaxCountPerName,
      bulkMaxQueue: config.bulkMaxQueue,
      defaultLimit: config.defaultLimit,
      maxLimit: config.maxLimit,
      logger: log,
    },
  );

  const relay = new Relay(opensearchRelay, {
    analyze: (event, opts) => analyzePool.analyze(event, opts),
    logger: log,
    relayUrl: config.relayUrl,
    authKinds: config.authKinds,
    maxMessageLength: config.maxMessageLength,
    maxFilterValues: config.maxFilterValues,
    maxLimit: config.maxLimit,
    maxEventTags: config.tagValueMaxCountPerName,
    maxInflightPerConn: config.maxInflightPerConn,
    bannedHashtags: config.bannedHashtags,
    rejectedKinds: config.rejectedKinds,
    negentropyMaxRecords: config.negentropyMaxRecords,
    relayInfo: {
      pubkey: config.relayPubkey,
      contact: config.relayContact,
      self: await config.nostrSigner.getPublicKey(),
      icon: new URL("/icon.png", config.publicUrl).toString(),
      banner: new URL("/banner.jpg", config.publicUrl).toString(),
    },
  });

  try {
    await opensearchRelay.migrate();
    log.info("opensearch_connected", { node: config.opensearchNode });
  } catch (error) {
    log.error("opensearch_connect_failed", {
      node: config.opensearchNode,
      ...errFields(error),
    });
    process.exit(1);
  }

  // Accumulate dirty addrs/identifiers from flush callbacks and forward all
  // dirty state to the background stats worker every 2s.
  const pendingDirtyAddrs = new Set<string>();
  const pendingDirtyIdentifiers = new Set<string>();
  opensearchRelay.onDirtyAddrs = (addrs) => {
    for (const addr of addrs) pendingDirtyAddrs.add(addr);
  };
  opensearchRelay.onDirtyIdentifiers = (ids) => {
    for (const id of ids) pendingDirtyIdentifiers.add(id);
  };
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
    forwardDirty?.({
      ids: dirty.ids,
      pubkeys: dirty.pubkeys,
      addrs,
      identifiers,
    });
  }, 2_000);

  frontend = {
    relayInfo: relay.getRelayInfo(),
    open(ws) {
      const conn: RelayConn = {
        id: nextConnId++,
        data: createConnData({ ip: ws.data.ip, userAgent: ws.data.userAgent }),
        send: (frame) => ws.send(frame),
      };
      ws.data.conn = conn;
      relay.handleOpen(conn);
    },
    message(ws, message) {
      const conn = ws.data.conn;
      if (!conn) return;
      // Fire-and-forget: do NOT await `handleMessage` here. Awaiting would
      // serialize message processing per connection, which becomes a hard
      // bottleneck when a single client (e.g. a Bluesky bridge) pumps
      // events at firehose rates — every event would block the next on
      // analyze-worker hops + bulk-flush latency. Errors thrown inside
      // handleMessage are caught internally and converted to NOTICE /
      // OK-false responses.
      relay.handleMessage(conn, message).catch((err) => {
        log.error("message_unhandled", errFields(err));
      });
    },
    close(ws) {
      const conn = ws.data.conn;
      if (conn) relay.handleCloseConnection(conn);
    },
    metrics: () => register.metrics(),
    broadcastExternal(events) {
      // In-process mode runs the whole relay on this thread anyway, so
      // parsing here is fine (and replaces the structured-clone deserialize
      // this path used to pay).
      for (const serialized of events) {
        try {
          relay.broadcast(JSON.parse(serialized) as NostrEvent);
        } catch (err) {
          log.error("bcast_parse_failed", errFields(err));
        }
      }
    },
    dispose: () => analyzePool.dispose(),
  };
}

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
      frontend.broadcastExternal(msg.events);
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
const landingPageHtml = renderLandingPage(
  frontend.relayInfo,
  config.relayUrl,
  log,
);
const nip11Json = JSON.stringify(frontend.relayInfo, null, 2);

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
        data: { ip, userAgent },
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
        const metrics = await frontend.metrics();
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
      frontend.open(ws);
    },

    message(ws, message) {
      frontend.message(ws, message);
    },

    close(ws) {
      frontend.close(ws);
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
  const cleanup = Promise.all([frontend.dispose(), bgWorker?.terminate()]);
  const timeout = new Promise((resolve) => setTimeout(resolve, 5_000));
  await Promise.race([cleanup, timeout]);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
