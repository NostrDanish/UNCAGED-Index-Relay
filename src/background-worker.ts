/**
 * Background worker for score recomputation, NIP-85 publishing, and trends.
 *
 * Runs on a separate thread so that heavy OpenSearch aggregation queries
 * don't block the main event loop that serves WebSocket REQ/EVENT traffic.
 *
 * Communication protocol:
 * - Main → Worker:  { type: "dirty", ids: string[], pubkeys: string[], addrs: string[], identifiers: string[] }
 * - Main → Worker:  { type: "config", opensearchNode: string, opensearchIndex: string, ... }
 * - Worker → Main:  { type: "broadcast", events: string[] } — serialized
 *   NostrEvent JSON, stringified here so the main thread only moves strings
 *   (a recompute tick can emit hundreds of NIP-85 stat events).
 */

import process from "node:process";
import type { NostrEvent } from "nostr-tools";
import { Config } from "./config.ts";
import { errFields, Logger } from "./log.ts";
import { Nip85 } from "./nip85.ts";
import { OpenSearchRelay } from "./opensearch.ts";
import { Client as OpenSearchClient } from "./opensearch-client.ts";
import { Trends } from "./trends.ts";

declare var self: Worker;

// ---------------------------------------------------------------------------
// Initialise from environment (same .env as main process)
// ---------------------------------------------------------------------------

const config = new Config({
  get(key) {
    return process.env[key];
  },
});

// This worker is its own entry point (separate thread), so it constructs its
// own Logger from the same env-derived config as the main process.
const log = new Logger(config.logLevel);

const clientOptions = {
  node: config.opensearchNode,
  ...(config.opensearchUsername &&
    config.opensearchPassword && {
      auth: {
        username: config.opensearchUsername,
        password: config.opensearchPassword,
      },
    }),
};

const readClient = new OpenSearchClient(clientOptions);
const writeClient = new OpenSearchClient(clientOptions);

const relay = new OpenSearchRelay(readClient, {
  indexName: config.opensearchIndex,
  historyEnabled: config.historyEnabled,
  historyKindsWhitelist: config.historyKindsWhitelist,
  historyKindsExcluded: config.historyKindsExcluded,
  authKinds: config.authKinds,
  writeClient,
  tagValueMaxCountPerName: config.tagValueMaxCountPerName,
  logger: log,
});

const signer = config.nostrSigner;

/**
 * Post a NostrEvent back to the main thread for WebSocket broadcast.
 *
 * Serialized here (off-main) and batched per event-loop tick: a recompute
 * tick publishes one kind 30382/30383 per dirty pubkey/event — hundreds on
 * a busy relay — so one postMessage per event would clone-storm the main
 * thread. Same setImmediate coalescing pattern as the protocol workers.
 */
let pendingBroadcasts: string[] = [];
let broadcastFlushScheduled = false;

function broadcastToMain(event: NostrEvent): void {
  pendingBroadcasts.push(JSON.stringify(event));
  if (!broadcastFlushScheduled) {
    broadcastFlushScheduled = true;
    setImmediate(() => {
      broadcastFlushScheduled = false;
      if (pendingBroadcasts.length > 0) {
        self.postMessage({ type: "broadcast", events: pendingBroadcasts });
        pendingBroadcasts = [];
      }
    });
  }
}

const nip85 = new Nip85({
  client: readClient,
  indexName: config.opensearchIndex,
  relay,
  signer,
  broadcast: broadcastToMain,
  logger: log,
});

// Trends (optional, only if interval > 0).
const trendsIntervalMs = config.trendsIntervalMs;
let trends: Trends | undefined;
if (trendsIntervalMs > 0) {
  trends = new Trends({
    client: readClient,
    indexName: config.opensearchIndex,
    relay,
    broadcast: broadcastToMain,
  });
}

// ---------------------------------------------------------------------------
// Dirty set accumulation
//
// Cap each accumulator at MAX_DIRTY entries. Without this, a flood of
// referencing events from the main thread can balloon these sets between
// recompute ticks, driving `recomputeScores` to issue 6 msearches per dirty
// id (and 1 per dirty pubkey). The cap on the main-thread relay sets
// (OpenSearchRelay.MAX_PENDING_DIRTY) already limits what reaches us, but
// this is a second belt-and-braces bound in case callers grow.
// ---------------------------------------------------------------------------

const MAX_DIRTY = 100_000;
const dirtyIds = new Set<string>();
const dirtyPubkeys = new Set<string>();
let dirtyOverflowLogged = false;

function addBounded(set: Set<string>, values: string[], label: string): void {
  for (const v of values) {
    if (set.size >= MAX_DIRTY) {
      if (!dirtyOverflowLogged) {
        log.warn("worker_dirty_overflow", { which: label, max: MAX_DIRTY });
        dirtyOverflowLogged = true;
      }
      return;
    }
    set.add(v);
  }
}

// ---------------------------------------------------------------------------
// Message handler — receives dirty sets from main thread
// ---------------------------------------------------------------------------

self.onmessage = (event: MessageEvent) => {
  const msg = event.data;

  if (msg.type === "dirty") {
    addBounded(dirtyIds, msg.ids, "ids");
    addBounded(dirtyPubkeys, msg.pubkeys, "pubkeys");
    if (msg.addrs.length > 0) nip85.addDirtyAddrs(new Set(msg.addrs));
    if (msg.identifiers.length > 0)
      nip85.addDirtyIdentifiers(new Set(msg.identifiers));
  }
};

// ---------------------------------------------------------------------------
// Score recomputation loop — runs every 5s
// ---------------------------------------------------------------------------

const SCORE_RECOMPUTE_INTERVAL_MS = 5_000;

async function recomputeLoop(): Promise<void> {
  // Drain accumulated dirty sets.
  const ids = dirtyIds.size > 0 ? [...dirtyIds] : [];
  const pubkeys = dirtyPubkeys.size > 0 ? [...dirtyPubkeys] : [];
  dirtyIds.clear();
  dirtyPubkeys.clear();
  dirtyOverflowLogged = false;

  if (ids.length === 0 && pubkeys.length === 0) {
    // Even with no dirty events, still flush NIP-85 addr/identifier stats
    // that may have accumulated.
    try {
      await nip85.flushAddrStats();
      await nip85.flushIdentifierStats();
    } catch (err) {
      log.error("nip85_flush_failed", errFields(err));
    }
    return;
  }

  try {
    // Inject dirty sets into the relay so recomputeScores can drain them.
    relay.addDirtyIds(ids);
    relay.addDirtyPubkeys(pubkeys);

    const result = await relay.recomputeScores();
    if (result.count > 0) {
      await Promise.all([
        nip85.publishUserStats(result.userScores),
        nip85.publishEventStats(result.eventScores),
      ]);
    }
    await nip85.flushAddrStats();
    await nip85.flushIdentifierStats();
  } catch (err) {
    log.error("recompute_failed", errFields(err));
  }
}

setInterval(() => {
  recomputeLoop().catch((err) =>
    log.error("recompute_loop_error", errFields(err)),
  );
}, SCORE_RECOMPUTE_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Trends loop (optional)
// ---------------------------------------------------------------------------

if (trends && trendsIntervalMs > 0) {
  // Narrowed const so the closure below doesn't need non-null assertions.
  const t = trends;
  const relayUrl = config.relayUrl;
  const preferredLanguages = config.preferredLanguages;

  const updateAllTrends = async () => {
    log.info("trends_updating");
    await t.updateTrendingHashtags(signer);
    await t.updateTrendingLinks(signer);
    await t.updateTrendingPubkeys(signer, relayUrl);
    await t.updateTrendingEvents(signer, relayUrl);
    await t.updateTrendingZappedEvents(signer, relayUrl);
    if (preferredLanguages.length > 0) {
      await t.updateTrendingEventsByLanguage(
        signer,
        relayUrl,
        preferredLanguages,
      );
    }
    log.info("trends_updated");
  };

  setInterval(() => {
    updateAllTrends().catch((err) =>
      log.error("trends_update_failed", errFields(err)),
    );
  }, trendsIntervalMs);

  log.info("trends_scheduled", {
    interval_ms: trendsIntervalMs,
    languages:
      preferredLanguages.length > 0 ? preferredLanguages.join(",") : undefined,
  });
}

log.info("bg_worker_started");
