import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import type { Client } from "@opensearch-project/opensearch";
import type { Filter } from "nostr-tools";
import { EventQuery } from "./query.ts";

describe("EventQuery", () => {
  let mockClient: Client;
  let eventQuery: EventQuery;
  let searchParams: unknown;

  beforeEach(() => {
    searchParams = null;
    mockClient = {
      search: async (params: unknown) => {
        searchParams = params;
        return {
          body: {
            hits: {
              hits: [],
            },
          },
        };
      },
    } as unknown as Client;

    eventQuery = new EventQuery(mockClient, "test-index");
  });

  describe("query", () => {
    it("should return empty array when no filters provided", async () => {
      const result = await eventQuery.query([]);
      assert.deepEqual(result, []);
    });

    it("should build query with ids filter", async () => {
      const filters: Filter[] = [{ ids: ["abc123", "def456"] }];

      await eventQuery.query(filters);

      assert.ok(searchParams);
      const params = searchParams as {
        body: { query: { bool: { should: unknown[] } } };
      };
      const query = params.body.query.bool.should[0] as {
        bool: { must: unknown[] };
      };

      // Should have deleted:false filter and ids filter
      assert.ok(
        query.bool.must.some((m: unknown) =>
          JSON.stringify(m).includes('"deleted":false'),
        ),
      );
      assert.ok(
        query.bool.must.some((m: unknown) =>
          JSON.stringify(m).includes('"abc123"'),
        ),
      );
    });

    it("should build query with authors filter", async () => {
      const filters: Filter[] = [{ authors: ["pubkey1", "pubkey2"] }];

      await eventQuery.query(filters);

      const params = searchParams as {
        body: { query: { bool: { should: unknown[] } } };
      };
      const query = params.body.query.bool.should[0] as {
        bool: { must: unknown[] };
      };

      assert.ok(
        query.bool.must.some((m: unknown) =>
          JSON.stringify(m).includes('"pubkey1"'),
        ),
      );
    });

    it("should build query with kinds filter", async () => {
      const filters: Filter[] = [{ kinds: [1, 2, 3] }];

      await eventQuery.query(filters);

      const params = searchParams as {
        body: { query: { bool: { should: unknown[] } } };
      };
      const queryStr = JSON.stringify(params);

      assert.ok(queryStr.includes('"kind"'));
      assert.ok(queryStr.includes("1"));
    });

    it("should build query with since filter", async () => {
      const filters: Filter[] = [{ since: 1234567890 }];

      await eventQuery.query(filters);

      const params = searchParams as {
        body: { query: { bool: { should: unknown[] } } };
      };
      const queryStr = JSON.stringify(params);

      assert.ok(queryStr.includes('"created_at"'));
      assert.ok(queryStr.includes('"gte":1234567890'));
    });

    it("should build query with until filter", async () => {
      const filters: Filter[] = [{ until: 9999999999 }];

      await eventQuery.query(filters);

      const params = searchParams as {
        body: { query: { bool: { should: unknown[] } } };
      };
      const queryStr = JSON.stringify(params);

      assert.ok(queryStr.includes('"created_at"'));
      assert.ok(queryStr.includes('"lte":9999999999'));
    });

    it("should build query with since and until", async () => {
      const filters: Filter[] = [{ since: 1000000000, until: 2000000000 }];

      await eventQuery.query(filters);

      const params = searchParams as {
        body: { query: { bool: { should: unknown[] } } };
      };
      const queryStr = JSON.stringify(params);

      assert.ok(queryStr.includes('"gte":1000000000'));
      assert.ok(queryStr.includes('"lte":2000000000'));
    });

    it("should build query with tag filters", async () => {
      const filters: Filter[] = [{ "#e": ["event123"] }];

      await eventQuery.query(filters);

      const params = searchParams as {
        body: { query: { bool: { should: unknown[] } } };
      };
      const queryStr = JSON.stringify(params);

      assert.ok(queryStr.includes('"nested"'));
      assert.ok(queryStr.includes('"tags"'));
      assert.ok(queryStr.includes('"event123"'));
    });

    it("should build query with multiple tag filters", async () => {
      const filters: Filter[] = [{ "#e": ["event123"], "#p": ["pubkey123"] }];

      await eventQuery.query(filters);

      const params = searchParams as {
        body: { query: { bool: { should: unknown[] } } };
      };
      const queryStr = JSON.stringify(params);

      assert.ok(queryStr.includes('"event123"'));
      assert.ok(queryStr.includes('"pubkey123"'));
    });

    it("should use default limit of 100", async () => {
      const filters: Filter[] = [{ kinds: [1] }];

      await eventQuery.query(filters);

      const params = searchParams as { body: { size: number } };
      assert.equal(params.body.size, 100);
    });

    it("should use specified limit", async () => {
      const filters: Filter[] = [{ kinds: [1], limit: 50 }];

      await eventQuery.query(filters);

      const params = searchParams as { body: { size: number } };
      assert.equal(params.body.size, 50);
    });

    it("should cap limit at 5000", async () => {
      const filters: Filter[] = [{ kinds: [1], limit: 10000 }];

      await eventQuery.query(filters);

      const params = searchParams as { body: { size: number } };
      assert.equal(params.body.size, 5000);
    });

    it("should use maximum limit from multiple filters", async () => {
      const filters: Filter[] = [
        { kinds: [1], limit: 10 },
        { kinds: [2], limit: 50 },
        { kinds: [3], limit: 30 },
      ];

      await eventQuery.query(filters);

      const params = searchParams as { body: { size: number } };
      assert.equal(params.body.size, 50);
    });

    it("should sort by created_at descending", async () => {
      const filters: Filter[] = [{ kinds: [1] }];

      await eventQuery.query(filters);

      const params = searchParams as { body: { sort: unknown[] } };
      assert.ok(params.body.sort);
      const sortStr = JSON.stringify(params.body.sort);
      assert.ok(sortStr.includes('"created_at"'));
      assert.ok(sortStr.includes('"desc"'));
    });

    it("should filter out deleted events", async () => {
      const filters: Filter[] = [{ kinds: [1] }];

      await eventQuery.query(filters);

      const params = searchParams as {
        body: { query: { bool: { should: unknown[] } } };
      };
      const queryStr = JSON.stringify(params);

      assert.ok(queryStr.includes('"deleted":false'));
    });

    it("should handle multiple filters with OR logic", async () => {
      const filters: Filter[] = [{ kinds: [1] }, { kinds: [2] }];

      await eventQuery.query(filters);

      const params = searchParams as {
        body: { query: { bool: { should: unknown[] } } };
      };
      assert.equal(params.body.query.bool.should.length, 2);
    });

    it("should return reconstructed events without internal fields", async () => {
      const mockEvent = {
        id: "abc123",
        pubkey: "pubkey1",
        created_at: 1234567890,
        kind: 1,
        tags: [["e", "event123"]],
        content: "Test event",
        sig: "sig123",
        tags_map: { e: ["event123"] },
        d_tag: undefined,
        deleted: false,
      };

      const customClient = {
        search: async () => ({
          body: {
            hits: {
              hits: [{ _source: mockEvent }],
            },
          },
        }),
      } as unknown as Client;

      const customQuery = new EventQuery(customClient, "test-index");
      const filters: Filter[] = [{ kinds: [1] }];
      const result = await customQuery.query(filters);

      assert.equal(result.length, 1);
      assert.equal(result[0].id, "abc123");
      assert.equal(result[0].content, "Test event");
      // Internal fields should not be present
      assert.equal("tags_map" in result[0], false);
      assert.equal("d_tag" in result[0], false);
      assert.equal("deleted" in result[0], false);
    });
  });
});
