import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { type Server, serve } from "bun";
import type { NostrEvent } from "nostr-tools";
import { finalizeEvent, generateSecretKey, nip19 } from "nostr-tools";

import { ProtocolPool, resolveProtocolWorkers } from "./protocol-pool.ts";

/**
 * Integration test: spawns real protocol workers against a mock OpenSearch
 * HTTP server, drives them through the same string-routing surface the
 * server uses, and asserts on the NIP-01 frames that come back.
 */
describe("ProtocolPool", () => {
  let pool: ProtocolPool;
  let mockOpenSearch: Server<unknown>;
  /** Frames delivered by the pool, per connection id. */
  const frames = new Map<number, unknown[][]>();
  /** Reads the mock's _search request counter (assigned in before()). */
  let countSearchRequests: () => number = () => 0;
  /** Reads the mock's _bulk request counter (assigned in before()). */
  let countBulkRequests: () => number = () => 0;

  function sendFrame(connId: number, frame: string): void {
    let list = frames.get(connId);
    if (!list) {
      list = [];
      frames.set(connId, list);
    }
    list.push(JSON.parse(frame));
  }

  /** Wait until `cond()` is true, polling; throws on timeout. */
  async function until(cond: () => boolean, ms = 10_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) {
        throw new Error("timeout waiting for condition");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function createEvent(
    template: Partial<NostrEvent> & { kind: number },
  ): NostrEvent {
    const sk = generateSecretKey();
    return finalizeEvent(
      {
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: "",
        ...template,
      },
      sk,
    );
  }

  before(async () => {
    // Mock OpenSearch: empty results for searches, success for everything
    // else. Enough for REQ (subscription setup) and bulk writes.
    let searchRequests = 0;
    let bulkRequests = 0;
    mockOpenSearch = serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.includes("_search")) {
          searchRequests++;
          return Response.json({
            took: 1,
            hits: { total: { value: 0 }, hits: [] },
          });
        }
        if (url.pathname.includes("_bulk")) {
          bulkRequests++;
          return Response.json({ took: 1, errors: false, items: [] });
        }
        return Response.json({ acknowledged: true });
      },
    });
    countSearchRequests = () => searchRequests;
    countBulkRequests = () => bulkRequests;

    // Workers construct Config from their environment at module init. Bun
    // workers snapshot env at process start, so runtime process.env
    // mutations would be invisible — pass an explicit environment instead.
    pool = new ProtocolPool(2, {
      sendFrame,
      workerEnv: {
        RELAY_URL: "wss://relay.test/",
        NOSTR_NSEC: nip19.nsecEncode(generateSecretKey()),
        OPENSEARCH_NODE: `http://localhost:${mockOpenSearch.port}`,
        LOG_LEVEL: "error",
        STATS_ENABLED: "false",
      },
    });
  });

  after(async () => {
    await pool?.dispose();
    mockOpenSearch?.stop(true);
  });

  it("start() resolves the relay info document", async () => {
    const info = await pool.start();
    assert.equal(info.name, "Ditto Relay");
    assert.ok(info.supported_nips?.includes(1));
  });

  it("responds to malformed JSON with a NOTICE frame", async () => {
    pool.open(101);
    pool.message(101, "this is not json");
    await until(() => (frames.get(101)?.length ?? 0) > 0);
    const frame = frames.get(101)?.[0] as unknown[];
    assert.equal(frame[0], "NOTICE");
  });

  it("rejects an EVENT with an invalid signature via OK false", async () => {
    const event = { ...createEvent({ kind: 1 }), sig: "a".repeat(128) };
    pool.open(102);
    pool.message(102, JSON.stringify(["EVENT", event]));
    await until(() => (frames.get(102)?.length ?? 0) > 0);
    const frame = frames.get(102)?.[0] as unknown[];
    assert.deepEqual(frame, [
      "OK",
      event.id,
      false,
      "invalid: signature verification failed",
    ]);
  });

  it("delivers accepted events across workers (fan-out broadcast)", async () => {
    // Two workers, least-connection assignment: consecutive opens on a
    // fresh pool land on different workers. conns 101/102 above are on
    // workers 0/1; open two more so each worker owns one of them.
    pool.open(201); // subscriber
    pool.open(202); // publisher

    // Subscribe on 201 (mock OpenSearch returns no stored events → EOSE).
    pool.message(201, JSON.stringify(["REQ", "sub1", { kinds: [20001] }]));
    await until(() =>
      (frames.get(201) ?? []).some((f) => f[0] === "EOSE" && f[1] === "sub1"),
    );
    // The worker really queried the mock (guards against workers silently
    // falling back to a default OPENSEARCH_NODE and error-swallowing).
    assert.ok(countSearchRequests() > 0, "mock OpenSearch was not queried");

    // Publish an ephemeral event on 202 — accepted without storage, so this
    // exercises verify + accept + fan-out end to end.
    const event = createEvent({ kind: 20001, content: "ephemeral ping" });
    pool.message(202, JSON.stringify(["EVENT", event]));

    // Publisher gets OK true.
    await until(() =>
      (frames.get(202) ?? []).some((f) => f[0] === "OK" && f[1] === event.id),
    );
    const ok = (frames.get(202) ?? []).find(
      (f) => f[0] === "OK" && f[1] === event.id,
    ) as unknown[];
    assert.equal(ok[2], true);

    // Subscriber receives the event — regardless of which worker owns it.
    await until(() =>
      (frames.get(201) ?? []).some(
        (f) =>
          f[0] === "EVENT" &&
          f[1] === "sub1" &&
          (f[2] as NostrEvent).id === event.id,
      ),
    );
  });

  it("stores a valid EVENT through the indexer worker (OK true)", async () => {
    // Kind 1 goes through the full write path: protocol worker verifies,
    // then RPCs the indexer over its MessageChannel port; the indexer's
    // bulk flush against the mock confirms, and OK true comes back.
    const event = createEvent({ kind: 1, content: "hello indexer" });
    pool.open(210);
    pool.message(210, JSON.stringify(["EVENT", event]));
    await until(() =>
      (frames.get(210) ?? []).some((f) => f[0] === "OK" && f[1] === event.id),
    );
    const ok = (frames.get(210) ?? []).find(
      (f) => f[0] === "OK" && f[1] === event.id,
    ) as unknown[];
    assert.equal(ok[2], true, `expected OK true, got: ${JSON.stringify(ok)}`);
    assert.ok(countBulkRequests() > 0, "mock OpenSearch got no bulk request");
  });

  it("collects per-worker metrics exposition including the indexer", async () => {
    const collected = await pool.metrics();
    assert.equal(collected.length, 3);
    assert.deepEqual(collected.map((c) => c.label).sort(), [
      "0",
      "1",
      "indexer",
    ]);
    for (const { label, text } of collected) {
      if (label === "indexer") {
        assert.ok(text.includes("ditto_opensearch_bulk_queue_size"));
      } else {
        assert.ok(text.includes("ditto_relay_messages_total"));
      }
    }
  });

  it("ignores messages for closed connections", async () => {
    pool.open(301);
    pool.close(301);
    // Must not throw or produce frames.
    pool.message(301, JSON.stringify(["REQ", "x", {}]));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(frames.get(301), undefined);
  });
});

describe("resolveProtocolWorkers", () => {
  it("respects explicit values including 0", () => {
    assert.equal(resolveProtocolWorkers(0), 0);
    assert.equal(resolveProtocolWorkers(5), 5);
  });

  it("auto-sizes from core count within [1, 16]", () => {
    const auto = resolveProtocolWorkers(undefined);
    assert.ok(auto >= 1 && auto <= 16);
    assert.equal(
      auto,
      Math.max(1, Math.min(16, Math.floor(navigator.hardwareConcurrency / 4))),
    );
  });
});
