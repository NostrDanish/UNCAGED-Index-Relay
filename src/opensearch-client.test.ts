import { strict as assert } from "node:assert";
import { describe, it, mock } from "node:test";
import { Client, SearchBatcher, type SearchLane } from "./opensearch-client.ts";

describe("Client", () => {
  describe("msearch", () => {
    it("should build correct NDJSON payload", async () => {
      // Capture the fetch call to verify the payload.
      let capturedUrl = "";
      let capturedInit: RequestInit | undefined;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedInit = init;
        return new Response(
          JSON.stringify({
            responses: [
              { status: 200, hits: { total: { value: 1 }, hits: [] } },
              { status: 200, hits: { total: { value: 2 }, hits: [] } },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      try {
        const client = new Client({ node: "http://localhost:9200" });
        const result = await client.msearch([
          { index: "idx-a", body: { query: { match_all: {} }, size: 1 } },
          { index: "idx-b", body: { query: { term: { kind: 1 } }, size: 5 } },
        ]);

        // Verify URL.
        assert.equal(capturedUrl, "http://localhost:9200/_msearch");

        // Verify Content-Type.
        const headers = capturedInit?.headers as Record<string, string>;
        assert.equal(headers["Content-Type"], "application/x-ndjson");

        // Verify NDJSON body: 4 lines (2 pairs) + trailing newline.
        const bodyStr = capturedInit?.body as string;
        const lines = bodyStr.split("\n");
        assert.equal(lines.length, 5); // 4 JSON lines + empty after trailing \n
        assert.deepEqual(JSON.parse(lines[0]), { index: "idx-a" });
        assert.deepEqual(JSON.parse(lines[1]), { query: { match_all: {} }, size: 1 });
        assert.deepEqual(JSON.parse(lines[2]), { index: "idx-b" });
        assert.deepEqual(JSON.parse(lines[3]), { query: { term: { kind: 1 } }, size: 5 });
        assert.equal(lines[4], ""); // trailing newline

        // Verify response.
        assert.equal(result.body.responses.length, 2);
        assert.deepEqual(result.body.responses[0].status, 200);
        assert.deepEqual(result.body.responses[1].status, 200);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should include auth header when configured", async () => {
      let capturedInit: RequestInit | undefined;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
        capturedInit = init;
        return new Response(
          JSON.stringify({ responses: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      try {
        const client = new Client({
          node: "http://localhost:9200",
          auth: { username: "admin", password: "secret" },
        });
        await client.msearch([{ index: "test", body: { query: { match_all: {} } } }]);

        const headers = capturedInit?.headers as Record<string, string>;
        assert.equal(headers["Authorization"], `Basic ${btoa("admin:secret")}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should throw on 5xx response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        return new Response("Internal Server Error", { status: 500 });
      };

      try {
        const client = new Client({ node: "http://localhost:9200" });
        await assert.rejects(
          () => client.msearch([{ index: "test", body: { query: { match_all: {} } } }]),
          (err: Error) => {
            assert.match(err.message, /OpenSearch POST \/_msearch responded 500/);
            return true;
          },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("search with batching", () => {
    it("should use batcher when batchSearchMs is set", async () => {
      let msearchCalled = false;
      let searchDirectCalled = false;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/_msearch")) {
          msearchCalled = true;
          return new Response(
            JSON.stringify({
              responses: [
                { status: 200, hits: { total: { value: 0 }, hits: [] } },
                { status: 200, hits: { total: { value: 0 }, hits: [] } },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/_search")) {
          searchDirectCalled = true;
          return new Response(
            JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      };

      try {
        const client = new Client({
          node: "http://localhost:9200",
          batchSearchMs: 0,
        });

        // Fire two searches concurrently — they should be batched.
        const [r1, r2] = await Promise.all([
          client.search({ index: "test", body: { query: { match_all: {} } } }),
          client.search({ index: "test", body: { query: { term: { kind: 1 } } } }),
        ]);

        assert.ok(msearchCalled, "Expected _msearch to be called");
        assert.ok(!searchDirectCalled, "Expected _search NOT to be called");
        assert.ok(r1.body);
        assert.ok(r2.body);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should use searchDirect for single concurrent query", async () => {
      let msearchCalled = false;
      let searchDirectCalled = false;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/_msearch")) {
          msearchCalled = true;
          return new Response(
            JSON.stringify({ responses: [{ status: 200, hits: { total: { value: 0 }, hits: [] } }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/_search")) {
          searchDirectCalled = true;
          return new Response(
            JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      };

      try {
        const client = new Client({
          node: "http://localhost:9200",
          batchSearchMs: 0,
        });

        // Single search — should use direct path.
        const result = await client.search({
          index: "test",
          body: { query: { match_all: {} } },
        });

        assert.ok(searchDirectCalled, "Expected _search to be called (single-query fast path)");
        assert.ok(!msearchCalled, "Expected _msearch NOT to be called for single query");
        assert.ok(result.body);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should not use batcher when batchSearchMs is undefined", async () => {
      let searchDirectCalled = false;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/_search")) {
          searchDirectCalled = true;
          return new Response(
            JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      };

      try {
        const client = new Client({ node: "http://localhost:9200" });

        await client.search({ index: "test", body: { query: { match_all: {} } } });

        assert.ok(searchDirectCalled, "Expected direct _search when batching disabled");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("SearchBatcher", () => {
    it("should batch multiple concurrent searches", async () => {
      const msearchCalls: Array<{ index: string; body: unknown }[]> = [];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/_msearch")) {
          // Parse the NDJSON to see what was sent.
          const bodyStr = init?.body as string;
          const lines = bodyStr.trim().split("\n");
          const searches: Array<{ index: string; body: unknown }> = [];
          for (let i = 0; i < lines.length; i += 2) {
            searches.push({
              index: JSON.parse(lines[i]).index,
              body: JSON.parse(lines[i + 1]),
            });
          }
          msearchCalls.push(searches);

          return new Response(
            JSON.stringify({
              responses: searches.map((_, idx) => ({
                status: 200,
                hits: { total: { value: idx + 10 }, hits: [] },
              })),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/_search")) {
          return new Response(
            JSON.stringify({ hits: { total: { value: 99 }, hits: [] } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      };

      try {
        const client = new Client({
          node: "http://localhost:9200",
          batchSearchMs: 0,
        });

        // Fire 5 searches concurrently.
        const promises = Array.from({ length: 5 }, (_, i) =>
          client.search({
            index: `idx-${i}`,
            body: { query: { term: { kind: i } }, size: i + 1 },
          }),
        );

        const results = await Promise.all(promises);

        // All 5 should have been batched into one msearch call.
        assert.equal(msearchCalls.length, 1, "Expected exactly 1 msearch call");
        assert.equal(msearchCalls[0].length, 5, "Expected 5 searches in the batch");

        // Verify each result was routed correctly.
        for (let i = 0; i < 5; i++) {
          const hits = results[i].body.hits as { total: { value: number } };
          assert.equal(hits.total.value, i + 10);
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should reject individual sub-queries on 5xx status", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/_msearch")) {
          return new Response(
            JSON.stringify({
              responses: [
                { status: 200, hits: { total: { value: 1 }, hits: [] } },
                { status: 500, error: { type: "search_phase_execution_exception" } },
                { status: 200, hits: { total: { value: 3 }, hits: [] } },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      };

      try {
        const client = new Client({
          node: "http://localhost:9200",
          batchSearchMs: 0,
        });

        const p1 = client.search({ index: "test", body: { query: { match_all: {} } } });
        const p2 = client.search({ index: "test", body: { query: { term: { kind: 1 } } } });
        const p3 = client.search({ index: "test", body: { query: { term: { kind: 2 } } } });

        // p1 and p3 should succeed, p2 should reject.
        const r1 = await p1;
        assert.ok(r1.body);

        await assert.rejects(p2, (err: Error) => {
          assert.match(err.message, /msearch sub-query 1 responded 500/);
          return true;
        });

        const r3 = await p3;
        assert.ok(r3.body);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should reject all on network error", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        throw new Error("ECONNREFUSED");
      };

      try {
        const client = new Client({
          node: "http://localhost:9200",
          batchSearchMs: 0,
        });

        const p1 = client.search({ index: "test", body: { query: { match_all: {} } } });
        const p2 = client.search({ index: "test", body: { query: { match_all: {} } } });

        await assert.rejects(p1, (err: Error) => {
          assert.match(err.message, /ECONNREFUSED/);
          return true;
        });
        await assert.rejects(p2, (err: Error) => {
          assert.match(err.message, /ECONNREFUSED/);
          return true;
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should handle sequential searches as separate batches", async () => {
      let msearchCallCount = 0;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/_msearch")) {
          msearchCallCount++;
          return new Response(
            JSON.stringify({
              responses: [{ status: 200, hits: { total: { value: 0 }, hits: [] } }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/_search")) {
          return new Response(
            JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      };

      try {
        const client = new Client({
          node: "http://localhost:9200",
          batchSearchMs: 0,
        });

        // Sequential searches (await between them) — each goes to its own batch.
        await client.search({ index: "test", body: { query: { match_all: {} } } });
        await client.search({ index: "test", body: { query: { match_all: {} } } });

        // Each sequential search is solo → uses searchDirect fast path (0 msearch).
        assert.equal(msearchCallCount, 0, "Sequential solo searches should use searchDirect");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should separate user and internal lanes", async () => {
      const msearchBodies: string[] = [];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/_msearch")) {
          msearchBodies.push(init?.body as string);
          const bodyStr = init?.body as string;
          const lines = bodyStr.trim().split("\n");
          const count = lines.length / 2;
          return new Response(
            JSON.stringify({
              responses: Array.from({ length: count }, () => ({
                status: 200,
                hits: { total: { value: 0 }, hits: [] },
              })),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/_search")) {
          return new Response(
            JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      };

      try {
        const client = new Client({
          node: "http://localhost:9200",
          batchSearchMs: 0,
        });

        // Fire user and internal queries concurrently — they should go to different lanes.
        const [r1, r2, r3, r4] = await Promise.all([
          client.search({ index: "test", body: { query: { match_all: {} }, size: 10 } }),
          client.search({ index: "test", body: { query: { match_all: {} }, size: 20 }, lane: "user" }),
          client.search({ index: "test", body: { query: { match_all: {} }, size: 1 }, lane: "internal" }),
          client.search({ index: "test", body: { query: { match_all: {} }, size: 0 }, lane: "internal" }),
        ]);

        // Should have 2 msearch calls (one per lane).
        assert.equal(msearchBodies.length, 2, "Expected 2 msearch calls (one per lane)");

        // One batch should have 2 queries (user lane), other should have 2 (internal lane).
        const batchSizes = msearchBodies.map((b) => b.trim().split("\n").length / 2).sort();
        assert.deepEqual(batchSizes, [2, 2], "Expected two batches of 2 queries each");

        // All results should be valid.
        assert.ok(r1.body);
        assert.ok(r2.body);
        assert.ok(r3.body);
        assert.ok(r4.body);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
