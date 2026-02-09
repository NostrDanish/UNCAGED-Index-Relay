import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import type { Client } from "@opensearch-project/opensearch";
import type { NostrEvent } from "nostr-tools";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { Config } from "./config.ts";
import { OpenSearchRelay } from "./opensearch.ts";

describe("OpenSearchRelay", () => {
  it("should create relay with default config", () => {
    const mockEnv = new Map();
    const config = new Config(mockEnv);

    const relay = OpenSearchRelay.fromConfig(config);

    assert.ok(relay instanceof OpenSearchRelay);
  });

  it("should create relay with custom node", () => {
    const mockEnv = new Map([["OPENSEARCH_NODE", "http://example.com:9200"]]);
    const config = new Config(mockEnv);

    const relay = OpenSearchRelay.fromConfig(config);

    assert.ok(relay instanceof OpenSearchRelay);
  });

  it("should create relay with auth when credentials provided", () => {
    const mockEnv = new Map([
      ["OPENSEARCH_USERNAME", "admin"],
      ["OPENSEARCH_PASSWORD", "password123"],
    ]);
    const config = new Config(mockEnv);

    const relay = OpenSearchRelay.fromConfig(config);

    assert.ok(relay instanceof OpenSearchRelay);
  });

  describe("event deletion", () => {
    // Mock OpenSearch client for deletion tests
    const createMockClient = () => {
      const documents = new Map<string, unknown>();
      return {
        documents,
        client: {
          search: async ({
            body,
          }: {
            body: {
              query: {
                bool: {
                  must: Array<{
                    terms?: { pubkey?: string[] };
                    term?: { deleted?: boolean };
                  }>;
                };
              };
            };
          }) => {
            // Return stored documents that match the filter
            const results: unknown[] = [];

            // Extract author filter if present
            let authorFilter: string[] | undefined;
            for (const clause of body.query.bool.must) {
              if (clause.terms?.pubkey) {
                authorFilter = clause.terms.pubkey;
              }
            }

            for (const [_id, doc] of documents.entries()) {
              const docTyped = doc as NostrEvent & { deleted?: boolean };

              // Skip deleted events
              if (docTyped.deleted) {
                continue;
              }

              // Filter by author if specified
              if (authorFilter && !authorFilter.includes(docTyped.pubkey)) {
                continue;
              }

              results.push(doc);
            }
            return {
              body: {
                hits: {
                  hits: results.map((doc) => ({ _source: doc })),
                },
              },
            };
          },
          bulk: async ({ body }: { body: unknown[] }) => {
            // Process bulk updates
            for (let i = 0; i < body.length; i += 2) {
              const action = body[i] as { update: { _id: string } };
              const doc = body[i + 1] as { doc: { deleted: boolean } };
              if (action.update) {
                const existing = documents.get(action.update._id);
                if (existing) {
                  documents.set(action.update._id, {
                    ...existing,
                    ...doc.doc,
                  });
                }
              }
            }
            return {
              body: {
                errors: false,
                items: [],
              },
            };
          },
          index: async ({ id, body }: { id: string; body: unknown }) => {
            documents.set(id, body);
            return { body: {} };
          },
          update: async ({
            id,
            body,
          }: {
            id: string;
            body: { upsert: unknown };
          }) => {
            // Simplified - just upsert for testing
            if (!documents.has(id)) {
              documents.set(id, body.upsert);
            }
            return { body: {} };
          },
          get: async ({ id }: { id: string }) => {
            const doc = documents.get(id);
            if (doc) {
              return { body: { found: true, _source: doc } };
            }
            return { body: { found: false }, statusCode: 404 };
          },
          indices: {
            exists: async () => ({ body: true }),
            create: async () => ({ body: {} }),
          },
          close: async () => {},
        },
      };
    };

    it("should delete events by e-tag (event ID)", async () => {
      const { client, documents } = createMockClient();
      const relay = new OpenSearchRelay(
        client as unknown as Client,
        "test-index",
      );

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Event to delete",
        },
        sk,
      );

      // Store the event
      await relay.event(event);

      // Verify it was stored
      assert.ok(documents.size > 0);

      // Delete by event ID
      await relay.remove([{ ids: [event.id] }]);

      // Verify the event is marked as deleted
      const stored = Array.from(documents.values())[0] as NostrEvent & {
        deleted?: boolean;
      };
      assert.equal(stored.deleted, true);
    });

    it("should delete addressable events by a-tag", async () => {
      const { client, documents } = createMockClient();
      const relay = new OpenSearchRelay(
        client as unknown as Client,
        "test-index",
      );

      const sk = generateSecretKey();
      const pubkeyHex = Buffer.from(sk).toString("hex");

      const event = finalizeEvent(
        {
          kind: 30023, // Addressable event kind
          created_at: Math.floor(Date.now() / 1000),
          tags: [["d", "my-article"]],
          content: "Article content",
        },
        sk,
      );

      // Store the event
      await relay.event(event);

      // Verify it was stored
      assert.ok(documents.size > 0);

      // Delete by a-tag filter (kind:pubkey:d-tag)
      await relay.remove([
        {
          kinds: [30023],
          authors: [event.pubkey],
          "#d": ["my-article"],
        },
      ]);

      // Verify the event is marked as deleted
      const stored = Array.from(documents.values())[0] as NostrEvent & {
        deleted?: boolean;
      };
      assert.equal(stored.deleted, true);
    });

    it("should delete replaceable events by kind and author", async () => {
      const { client, documents } = createMockClient();
      const relay = new OpenSearchRelay(
        client as unknown as Client,
        "test-index",
      );

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 0, // Replaceable event kind (metadata)
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: JSON.stringify({ name: "Alice" }),
        },
        sk,
      );

      // Store the event
      await relay.event(event);

      // Verify it was stored
      assert.ok(documents.size > 0);

      // Delete by kind and author
      await relay.remove([
        {
          kinds: [0],
          authors: [event.pubkey],
        },
      ]);

      // Verify the event is marked as deleted
      const stored = Array.from(documents.values())[0] as NostrEvent & {
        deleted?: boolean;
      };
      assert.equal(stored.deleted, true);
    });

    it("should not delete events from different authors", async () => {
      const { client, documents } = createMockClient();
      const relay = new OpenSearchRelay(
        client as unknown as Client,
        "test-index",
      );

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();

      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Event from author 1",
        },
        sk1,
      );

      // Store the event
      await relay.event(event1);

      // Try to delete with different author
      await relay.remove([
        {
          ids: [event1.id],
          authors: [
            finalizeEvent(
              { kind: 1, created_at: 0, tags: [], content: "" },
              sk2,
            ).pubkey,
          ],
        },
      ]);

      // Verify the event is NOT deleted (different author)
      const stored = Array.from(documents.values())[0] as NostrEvent & {
        deleted?: boolean;
      };
      assert.notEqual(stored.deleted, true);
    });

    it("should delete replaceable events using a-tag with empty d-identifier", async () => {
      const { client, documents } = createMockClient();
      const relay = new OpenSearchRelay(
        client as unknown as Client,
        "test-index",
      );

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 10000, // Replaceable event kind
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Replaceable event",
        },
        sk,
      );

      // Store the event
      await relay.event(event);

      // Verify it was stored
      assert.ok(documents.size > 0);

      // Delete by kind and author (empty d-tag for replaceable events)
      await relay.remove([
        {
          kinds: [10000],
          authors: [event.pubkey],
        },
      ]);

      // Verify the event is marked as deleted
      const stored = Array.from(documents.values())[0] as NostrEvent & {
        deleted?: boolean;
      };
      assert.equal(stored.deleted, true);
    });
  });

  describe("NIP-50 sort", () => {
    // Mock client with aggregation support for sort tests
    const createSortMockClient = () => {
      const documents = new Map<string, unknown>();
      const references = new Map<string, unknown[]>(); // eventId -> array of references

      return {
        documents,
        references,
        client: {
          search: async ({ body }: { body: Record<string, unknown> }) => {
            // Handle aggregation queries for references
            if (body.aggs) {
              const eventIds = (body.query as Record<string, unknown>)
                ?.bool as {
                must: Array<{
                  bool?: {
                    should?: Array<{ terms?: Record<string, string[]> }>;
                  };
                }>;
              };

              const buckets: Array<{
                key: string;
                doc_count: number;
                by_kind?: {
                  buckets?: Array<{ key: number; doc_count: number }>;
                };
              }> = [];

              // Build buckets from references
              for (const [eventId, refs] of references.entries()) {
                if (refs.length > 0) {
                  buckets.push({
                    key: eventId,
                    doc_count: refs.length,
                    by_kind: {
                      buckets: [{ key: 1, doc_count: refs.length }],
                    },
                  });
                }
              }

              return {
                body: {
                  aggregations: {
                    by_event: { buckets },
                  },
                  hits: { hits: [] },
                },
              };
            }

            // Handle normal search queries
            const results: unknown[] = [];
            for (const [_id, doc] of documents.entries()) {
              const docTyped = doc as NostrEvent & { deleted?: boolean };
              if (!docTyped.deleted) {
                results.push({ _source: doc });
              }
            }

            // Sort by created_at desc
            results.sort((a, b) => {
              const aDoc = (a as { _source: NostrEvent })._source;
              const bDoc = (b as { _source: NostrEvent })._source;
              return bDoc.created_at - aDoc.created_at;
            });

            return {
              body: {
                hits: { hits: results },
              },
            };
          },
          index: async ({ id, body }: { id: string; body: unknown }) => {
            documents.set(id, body);
            return { body: {} };
          },
          update: async ({
            id,
            body,
          }: {
            id: string;
            body: { upsert: unknown };
          }) => {
            if (!documents.has(id)) {
              documents.set(id, body.upsert);
            }
            return { body: {} };
          },
          indices: {
            exists: async () => ({ body: true }),
            create: async () => ({ body: {} }),
          },
          close: async () => {},
        },
      };
    };

    it("should handle sort:top query", async () => {
      const { client, documents, references } = createSortMockClient();
      const relay = new OpenSearchRelay(
        client as unknown as Client,
        "test-index",
      );

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create two events
      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 3600,
          tags: [],
          content: "Less popular event",
        },
        sk,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 7200,
          tags: [],
          content: "More popular event",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);

      // Add references (event2 has more references)
      references.set(event1.id, [{ kind: 1 }]);
      references.set(event2.id, [{ kind: 1 }, { kind: 1 }, { kind: 1 }]);

      // Query with sort:top
      const results = await relay.query([{ kinds: [1], search: "sort:top" }]);

      // Event2 should be first (more references)
      assert.equal(results.length, 2);
      assert.equal(results[0].id, event2.id);
      assert.equal(results[1].id, event1.id);
    });

    it("should reject queries with multiple sort tokens", async () => {
      const { client } = createSortMockClient();
      const relay = new OpenSearchRelay(
        client as unknown as Client,
        "test-index",
      );

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Test event",
        },
        sk,
      );

      await relay.event(event);

      // Query with multiple sort tokens should return 0 events
      const results = await relay.query([
        { kinds: [1], search: "sort:top sort:hot" },
      ]);

      assert.equal(results.length, 0);
    });

    it("should handle sort:hot with time decay", async () => {
      const { client, documents, references } = createSortMockClient();
      const relay = new OpenSearchRelay(
        client as unknown as Client,
        "test-index",
      );

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create two events: one recent with few refs, one old with many refs
      const recentEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 3600, // 1 hour ago
          tags: [],
          content: "Recent event",
        },
        sk,
      );

      const oldEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 7 * 24 * 3600, // 7 days ago
          tags: [],
          content: "Old event",
        },
        sk,
      );

      await relay.event(recentEvent);
      await relay.event(oldEvent);

      // Recent event has 2 refs, old event has 10 refs
      // But with decay, recent should score higher
      references.set(recentEvent.id, [{ kind: 1 }, { kind: 1 }]);
      references.set(oldEvent.id, [
        { kind: 1 },
        { kind: 1 },
        { kind: 1 },
        { kind: 1 },
        { kind: 1 },
        { kind: 1 },
        { kind: 1 },
        { kind: 1 },
        { kind: 1 },
        { kind: 1 },
      ]);

      // Query with sort:hot
      const results = await relay.query([{ kinds: [1], search: "sort:hot" }]);

      // Recent event should rank higher due to recency
      assert.equal(results.length, 2);
      assert.equal(results[0].id, recentEvent.id);
    });

    it("should combine sort with full-text search", async () => {
      const { client, documents, references } = createSortMockClient();
      const relay = new OpenSearchRelay(
        client as unknown as Client,
        "test-index",
      );

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content: "Bitcoin is great",
        },
        sk,
      );

      await relay.event(event);
      references.set(event.id, [{ kind: 1 }]);

      // Query combining search text and sort
      const results = await relay.query([
        { kinds: [1], search: "bitcoin sort:top" },
      ]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, event.id);
    });
  });
});
