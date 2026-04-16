/**
 * Background worker for score recomputation, NIP-85 publishing, and trends.
 *
 * Runs on a separate thread so that heavy OpenSearch aggregation queries
 * don't block the main event loop that serves WebSocket REQ/EVENT traffic.
 *
 * Communication protocol:
 * - Main → Worker:  { type: "dirty", ids: string[], pubkeys: string[], addrs: string[], identifiers: string[] }
 * - Main → Worker:  { type: "config", opensearchNode: string, opensearchIndex: string, ... }
 * - Worker → Main:  { type: "broadcast", event: NostrEvent }
 */

import process from "node:process";
import type { NostrEvent } from "nostr-tools";

import { Client as OpenSearchClient } from "./opensearch-client.ts";
import { Config } from "./config.ts";
import { Nip85 } from "./nip85.ts";
import { OpenSearchRelay } from "./opensearch.ts";
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
});

const signer = config.nostrSigner;

/** Post a NostrEvent back to the main thread for WebSocket broadcast. */
function broadcastToMain(event: NostrEvent): void {
  self.postMessage({ type: "broadcast", event });
}

const nip85 = new Nip85({
  client: readClient,
  indexName: config.opensearchIndex,
  relay,
  signer,
  broadcast: broadcastToMain,
});

// Wire up dirty tracking callbacks (same as server.ts did).
relay.onDirtyAddrs = (addrs) => nip85.addDirtyAddrs(addrs);
relay.onDirtyIdentifiers = (ids) => nip85.addDirtyIdentifiers(ids);

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
        console.warn(
          `[bg-worker] dirty ${label} set full (${MAX_DIRTY}); dropping further additions until next recompute cycle`,
        );
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
      console.error("[bg-worker] NIP-85 flush failed:", err);
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
    console.error("[bg-worker] Score recomputation / NIP-85 failed:", err);
  }
}

setInterval(() => {
  recomputeLoop().catch((err) =>
    console.error("[bg-worker] recomputeLoop error:", err),
  );
}, SCORE_RECOMPUTE_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Trends loop (optional)
// ---------------------------------------------------------------------------

if (trends && trendsIntervalMs > 0) {
  const relayUrl = config.relayUrl;
  const preferredLanguages = config.preferredLanguages;

  const updateAllTrends = async () => {
    console.log("[bg-worker] Updating trends...");
    await trends!.updateTrendingHashtags(signer);
    await trends!.updateTrendingLinks(signer);
    await trends!.updateTrendingPubkeys(signer, relayUrl);
    await trends!.updateTrendingEvents(signer, relayUrl);
    await trends!.updateTrendingZappedEvents(signer, relayUrl);
    if (preferredLanguages.length > 0) {
      await trends!.updateTrendingEventsByLanguage(
        signer,
        relayUrl,
        preferredLanguages,
      );
    }
    console.log("[bg-worker] Trends updated.");
  };

  setInterval(() => {
    updateAllTrends().catch((err) =>
      console.error("[bg-worker] Trends update failed:", err),
    );
  }, trendsIntervalMs);

  const langInfo =
    preferredLanguages.length > 0
      ? ` + languages: ${preferredLanguages.join(", ")}`
      : "";
  console.log(
    `[bg-worker] Trends scheduling enabled (every ${(trendsIntervalMs / 60_000).toFixed(0)} min${langInfo})`,
  );
}

console.log("[bg-worker] Background worker started");
