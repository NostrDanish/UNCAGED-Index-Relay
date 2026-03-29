import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Client } from "./opensearch-client.ts";

describe("Client", () => {
  describe("search", () => {
    it("should call _search directly", async () => {
      let capturedUrl = "";

      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request, _init?: RequestInit) => {
          capturedUrl = String(input);
          return new Response(
            JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
        { preconnect: (_url: string | URL) => {} },
      ) as typeof fetch;

      try {
        const client = new Client({ node: "http://localhost:9200" });
        const result = await client.search({
          index: "test",
          body: { query: { match_all: {} } },
        });

        assert.ok(
          capturedUrl.includes("/_search"),
          "Expected _search endpoint",
        );
        assert.ok(result.body);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("msearch", () => {
    it("should build correct NDJSON payload", async () => {
      let capturedUrl = "";
      let capturedInit: RequestInit | undefined;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
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
        },
        { preconnect: (_url: string | URL) => {} },
      ) as typeof fetch;

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
        assert.deepEqual(JSON.parse(lines[1]), {
          query: { match_all: {} },
          size: 1,
        });
        assert.deepEqual(JSON.parse(lines[2]), { index: "idx-b" });
        assert.deepEqual(JSON.parse(lines[3]), {
          query: { term: { kind: 1 } },
          size: 5,
        });
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
      globalThis.fetch = Object.assign(
        async (_input: string | URL | Request, init?: RequestInit) => {
          capturedInit = init;
          return new Response(JSON.stringify({ responses: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
        { preconnect: (_url: string | URL) => {} },
      ) as typeof fetch;

      try {
        const client = new Client({
          node: "http://localhost:9200",
          auth: { username: "admin", password: "secret" },
        });
        await client.msearch([
          { index: "test", body: { query: { match_all: {} } } },
        ]);

        const headers = capturedInit?.headers as Record<string, string>;
        assert.equal(headers["Authorization"], `Basic ${btoa("admin:secret")}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should throw on 5xx response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async () => {
          return new Response("Internal Server Error", { status: 500 });
        },
        { preconnect: (_url: string | URL) => {} },
      ) as typeof fetch;

      try {
        const client = new Client({ node: "http://localhost:9200" });
        await assert.rejects(
          () =>
            client.msearch([
              { index: "test", body: { query: { match_all: {} } } },
            ]),
          (err: Error) => {
            assert.match(
              err.message,
              /OpenSearch POST \/_msearch responded 500/,
            );
            return true;
          },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
