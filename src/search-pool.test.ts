import assert from "node:assert";
import { after, before, describe, test } from "node:test";
import { serve } from "bun";
import { Logger } from "./log.ts";
import { SearchPool } from "./search-pool.ts";

describe("SearchPool", () => {
  let server: ReturnType<typeof serve>;
  let node: string;
  let lastBody: unknown;

  before(() => {
    server = serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const text = await req.text();
        lastBody = text;
        if (url.pathname.endsWith("/_search")) {
          if (url.pathname.includes("boom")) {
            return new Response("kaboom", { status: 503 });
          }
          return Response.json({
            hits: { hits: [{ _source: { id: "abc", kind: 1 } }] },
          });
        }
        if (url.pathname === "/_msearch") {
          return Response.json({
            responses: [{ hits: { hits: [{ _source: { id: "m1" } }] } }],
          });
        }
        if (url.pathname.endsWith("/_count")) {
          return Response.json({ count: 42 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    node = `http://localhost:${server.port}`;
  });

  after(() => {
    server.stop(true);
  });

  test("search routes through a worker and returns the parsed body", async () => {
    const pool = new SearchPool({ node }, 1, { logger: new Logger("error") });
    const res = await pool.search<{ id: string; kind: number }>({
      index: "nostr-events",
      body: { query: { term: { kind: 1 } }, size: 10 },
    });
    assert.equal(res.body.hits.hits.length, 1);
    assert.equal(res.body.hits.hits[0]._source?.id, "abc");
    // Confirm the request body was serialized and sent by the worker.
    assert.ok(String(lastBody).includes('"kind"'));
    await pool.close();
  });

  test("msearch returns the responses array", async () => {
    const pool = new SearchPool({ node }, 1, { logger: new Logger("error") });
    const res = await pool.msearch<{ id: string }>([
      { index: "nostr-events", body: { query: { match_all: {} } } },
    ]);
    assert.equal(res.body.responses.length, 1);
    assert.equal(res.body.responses[0].hits?.hits?.[0]._source?.id, "m1");
    await pool.close();
  });

  test("count returns the count", async () => {
    const pool = new SearchPool({ node }, 1, { logger: new Logger("error") });
    const res = await pool.count({ index: "nostr-events", body: {} });
    assert.equal(res.body.count, 42);
    await pool.close();
  });

  test("rejects on 5xx from OpenSearch", async () => {
    const pool = new SearchPool({ node }, 1, { logger: new Logger("error") });
    await assert.rejects(() => pool.search({ index: "boom", body: {} }), /503/);
    await pool.close();
  });

  test("batches concurrent requests in one tick", async () => {
    const pool = new SearchPool({ node }, 2, { logger: new Logger("error") });
    const results = await Promise.all([
      pool.count({ index: "nostr-events", body: {} }),
      pool.count({ index: "nostr-events", body: {} }),
      pool.count({ index: "nostr-events", body: {} }),
    ]);
    assert.equal(results.length, 3);
    for (const r of results) assert.equal(r.body.count, 42);
    await pool.close();
  });
});
