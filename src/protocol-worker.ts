/**
 * Protocol worker — owns connections and does all per-message work.
 *
 * Each protocol worker runs a full Relay instance: JSON parse, zod
 * validation, signature verification + analysis (inline via analyze.ts —
 * no extra thread hop), policy checks, OpenSearch reads/writes through its
 * own clients, NIP-42 auth state, NIP-77 negentropy sessions, broadcast
 * matching for its own connections, and NIP-01 frame building.
 *
 * The main thread only routes strings (see protocol-pool.ts). Outbound
 * frames are batched per event-loop tick into a single postMessage, so a
 * large REQ response costs one structured clone of an array of strings
 * instead of one postMessage per event.
 *
 * Locally-accepted events are posted back to main (batched) for fan-out to
 * sibling workers; events arriving from siblings come in as `bcast` and go
 * straight to Relay.broadcast (local matching only — no re-fan-out, so no
 * loops).
 */

declare var self: Worker;

import process from "node:process";
import type { NostrEvent } from "nostr-tools";

import { createAnalyzer } from "./analyze.ts";
import { Config } from "./config.ts";
import { errFields, Logger } from "./log.ts";
import { register } from "./metrics.ts";
import { OpenSearchRelay } from "./opensearch.ts";
import type { ClientOptions } from "./opensearch-client.ts";
import { Client as OpenSearchClient } from "./opensearch-client.ts";
import type { FromProtocolWorker, ToProtocolWorker } from "./protocol-pool.ts";
import { createConnData, Relay, type RelayConn } from "./relay.ts";

// ---------------------------------------------------------------------------
// Initialise from environment (same .env as the main process)
// ---------------------------------------------------------------------------

const config = new Config({
  get(key) {
    return process.env[key];
  },
});

const log = new Logger(config.logLevel);

const opensearchClientOptions: ClientOptions = {
  node: config.opensearchNode,
};
if (config.opensearchUsername && config.opensearchPassword) {
  opensearchClientOptions.auth = {
    username: config.opensearchUsername,
    password: config.opensearchPassword,
  };
}
// Separate read and write clients so bulk flushes can't starve queries —
// same split the single-threaded server used.
const opensearchReadClient = new OpenSearchClient(opensearchClientOptions);
const opensearchWriteClient = new OpenSearchClient(opensearchClientOptions);

const opensearchRelay = new OpenSearchRelay(opensearchReadClient, {
  indexName: config.opensearchIndex,
  historyEnabled: config.historyEnabled,
  historyKindsWhitelist: config.historyKindsWhitelist,
  historyKindsExcluded: config.historyKindsExcluded,
  authKinds: config.authKinds,
  writeClient: opensearchWriteClient,
  tagValueMaxCountPerName: config.tagValueMaxCountPerName,
  bulkMaxQueue: config.bulkMaxQueue,
  defaultLimit: config.defaultLimit,
  maxLimit: config.maxLimit,
  logger: log,
});

// Signature verification + language/sentiment/media analysis runs inline on
// this thread. The wasm verify is the dominant cost (~fraction of a ms) and
// is sharded across protocol workers, so an EVENT never pays a cross-thread
// round trip for analysis.
const analyze = await createAnalyzer();

// ---------------------------------------------------------------------------
// Outbound batching: frames and accepted-event fan-out
// ---------------------------------------------------------------------------

let pendingFrames: Array<[id: number, frame: string]> = [];
let pendingAccepted: NostrEvent[] = [];
let outFlushScheduled = false;

function scheduleOutFlush(): void {
  if (outFlushScheduled) return;
  outFlushScheduled = true;
  setImmediate(flushOut);
}

function flushOut(): void {
  outFlushScheduled = false;
  if (pendingFrames.length > 0) {
    self.postMessage({
      t: "frames",
      frames: pendingFrames,
    } satisfies FromProtocolWorker);
    pendingFrames = [];
  }
  if (pendingAccepted.length > 0) {
    self.postMessage({
      t: "accepted",
      events: pendingAccepted,
    } satisfies FromProtocolWorker);
    pendingAccepted = [];
  }
}

// ---------------------------------------------------------------------------
// Relay + connection registry
// ---------------------------------------------------------------------------

const relay = new Relay(opensearchRelay, {
  analyze: (event, opts) => analyze(event, opts),
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
  onEventAccepted: (event) => {
    pendingAccepted.push(event);
    scheduleOutFlush();
  },
  relayInfo: {
    pubkey: config.relayPubkey,
    contact: config.relayContact,
    self: await config.nostrSigner.getPublicKey(),
    icon: new URL("/icon.png", config.publicUrl).toString(),
    banner: new URL("/banner.jpg", config.publicUrl).toString(),
  },
});

const conns = new Map<number, RelayConn>();

function openConn(id: number, ip?: string, userAgent?: string): void {
  const conn: RelayConn = {
    id,
    data: createConnData({ ip, userAgent }),
    send: (frame) => {
      pendingFrames.push([id, frame]);
      scheduleOutFlush();
    },
  };
  conns.set(id, conn);
  relay.handleOpen(conn);
}

// ---------------------------------------------------------------------------
// Dirty-reference forwarding for the background stats worker
// ---------------------------------------------------------------------------

if (config.statsEnabled) {
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

    self.postMessage({
      t: "dirty",
      ids: dirty.ids,
      pubkeys: dirty.pubkeys,
      addrs,
      identifiers,
    } satisfies FromProtocolWorker);
  }, 2_000);
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

self.onmessage = (event: MessageEvent<ToProtocolWorker>) => {
  const msg = event.data;
  switch (msg.t) {
    case "open":
      openConn(msg.id, msg.ip, msg.ua);
      break;

    case "msgs":
      for (const [id, data] of msg.msgs) {
        const conn = conns.get(id);
        if (!conn) continue; // closed while the batch was in flight
        // Fire-and-forget, same as the single-threaded server: awaiting
        // would serialize processing per batch and stall other connections
        // in it. Relay.handleMessage converts its own errors to NOTICEs.
        relay.handleMessage(conn, data).catch((err) => {
          log.error("message_unhandled", errFields(err));
        });
      }
      break;

    case "close": {
      const conn = conns.get(msg.id);
      if (conn) {
        conns.delete(msg.id);
        relay.handleCloseConnection(conn);
      }
      break;
    }

    case "bcast":
      // Events accepted by sibling workers (or injected by the background
      // stats worker): match against local subscriptions only.
      for (const nostrEvent of msg.events) {
        relay.broadcast(nostrEvent);
      }
      break;

    case "metrics":
      register.metrics().then((text) => {
        self.postMessage({
          t: "metrics",
          reqId: msg.reqId,
          text,
        } satisfies FromProtocolWorker);
      });
      break;
  }
};

// Signal readiness with the relay info document (identical across workers).
// The pool waits for this before routing connections — and before
// terminating, since tearing down a worker mid-initialization can segfault
// Bun.
self.postMessage({
  t: "ready",
  relayInfo: relay.getRelayInfo(),
} satisfies FromProtocolWorker);

log.info("protocol_worker_started");
