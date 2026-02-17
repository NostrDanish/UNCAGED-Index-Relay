import { strict as assert } from "node:assert";
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
            const items: Array<Record<string, unknown>> = [];
            for (let i = 0; i < body.length; i += 2) {
              const action = body[i] as {
                index?: { _id: string };
                update?: { _id: string };
              };
              const payload = body[i + 1] as Record<string, unknown>;

              if (action.index) {
                documents.set(action.index._id, payload);
                items.push({ index: {} });
              } else if (action.update) {
                if (payload.doc) {
                  // Partial update (used by remove)
                  const existing = documents.get(action.update._id);
                  if (existing) {
                    documents.set(action.update._id, {
                      ...existing,
                      ...(payload.doc as Record<string, unknown>),
                    });
                  }
                } else if (payload.upsert) {
                  // Scripted upsert (used by replaceable events)
                  if (!documents.has(action.update._id)) {
                    documents.set(action.update._id, payload.upsert);
                  }
                }
                items.push({ update: {} });
              }
            }
            return {
              body: {
                errors: false,
                items,
              },
            };
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
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

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
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();

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
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

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
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

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
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

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
      const zaps = new Map<string, number>(); // eventId -> total sats

      return {
        documents,
        references,
        zaps,
        client: {
          search: async ({ body }: { body: Record<string, unknown> }) => {
            // Handle aggregation queries
            if (body.aggs) {
              const aggs = body.aggs as Record<string, unknown>;

              // Handle cardinality aggregation (used by distinct:author count)
              if (aggs.unique_authors) {
                const allDocs = Array.from(documents.values());
                const uniquePubkeys = new Set(
                  allDocs
                    .filter((doc) => !(doc as { deleted?: boolean }).deleted)
                    .map((doc) => (doc as NostrEvent).pubkey),
                );
                return {
                  body: {
                    aggregations: {
                      unique_authors: { value: uniquePubkeys.size },
                    },
                    hits: { hits: [] },
                  },
                };
              }

              // Detect zap aggregation queries (kind 9735 with total_sats)
              const queryMust = (
                (body.query as Record<string, unknown>)?.bool as Record<
                  string,
                  unknown
                >
              )?.must as Array<Record<string, unknown>> | undefined;
              const isZapQuery = queryMust?.some(
                (clause) =>
                  (clause.term as Record<string, unknown>)?.kind === 9735,
              );

              if (isZapQuery) {
                const zapBuckets: Array<{
                  key: string;
                  doc_count: number;
                  total_sats: { value: number };
                }> = [];

                for (const [eventId, totalSats] of zaps.entries()) {
                  if (totalSats > 0) {
                    zapBuckets.push({
                      key: eventId,
                      doc_count: 1,
                      total_sats: { value: totalSats },
                    });
                  }
                }

                return {
                  body: {
                    aggregations: {
                      by_event: { buckets: zapBuckets },
                    },
                    hits: { hits: [] },
                  },
                };
              }

              // Handle reference aggregation queries (used by sort modes)
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

            // Simulate OpenSearch collapse (field collapsing)
            const collapse = body.collapse as { field: string } | undefined;
            if (collapse?.field) {
              const seen = new Set<string>();
              const collapsed: unknown[] = [];
              for (const hit of results) {
                const src = (hit as { _source: NostrEvent })._source;
                const val = src[collapse.field as keyof NostrEvent] as string;
                if (!seen.has(val)) {
                  seen.add(val);
                  collapsed.push(hit);
                }
              }
              return {
                body: {
                  hits: { hits: collapsed },
                },
              };
            }

            return {
              body: {
                hits: { hits: results },
              },
            };
          },
          bulk: async ({ body }: { body: unknown[] }) => {
            const items: Array<Record<string, unknown>> = [];
            for (let i = 0; i < body.length; i += 2) {
              const action = body[i] as {
                index?: { _id: string };
                update?: { _id: string };
              };
              const payload = body[i + 1] as Record<string, unknown>;

              if (action.index) {
                documents.set(action.index._id, payload);
                items.push({ index: {} });
              } else if (action.update) {
                if (payload.upsert) {
                  if (!documents.has(action.update._id)) {
                    documents.set(action.update._id, payload.upsert);
                  }
                }
                items.push({ update: {} });
              }
            }
            return {
              body: {
                errors: false,
                items,
              },
            };
          },
          count: async () => {
            const nonDeleted = Array.from(documents.values()).filter(
              (doc) => !(doc as { deleted?: boolean }).deleted,
            );
            return { body: { count: nonDeleted.length } };
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
      const { client, references } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

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
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

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
      const { client, references } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

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
      const { client, references } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

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

    it("should return only one event per author with distinct:author", async () => {
      const { client } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create two events from author 1
      const event1a = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "First event from author 1",
        },
        sk1,
      );

      const event1b = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content: "Second event from author 1",
        },
        sk1,
      );

      // Create one event from author 2
      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 50,
          tags: [],
          content: "Event from author 2",
        },
        sk2,
      );

      await relay.event(event1a);
      await relay.event(event1b);
      await relay.event(event2);

      // Query with distinct:author
      const results = await relay.query([
        { kinds: [1], search: "distinct:author" },
      ]);

      // Should return only 2 events (one per author)
      assert.equal(results.length, 2);

      // Each author should appear exactly once
      const pubkeys = results.map((e) => e.pubkey);
      assert.equal(new Set(pubkeys).size, 2);
    });

    it("should combine distinct:author with full-text search", async () => {
      const { client } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1a = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "Bitcoin price analysis",
        },
        sk1,
      );

      const event1b = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content: "Bitcoin mining update",
        },
        sk1,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 50,
          tags: [],
          content: "Bitcoin trading strategy",
        },
        sk2,
      );

      await relay.event(event1a);
      await relay.event(event1b);
      await relay.event(event2);

      // Query combining search text and distinct:author
      const results = await relay.query([
        { kinds: [1], search: "bitcoin distinct:author" },
      ]);

      // Should return only 2 events (one per author)
      assert.equal(results.length, 2);
      const pubkeys = results.map((e) => e.pubkey);
      assert.equal(new Set(pubkeys).size, 2);
    });

    it("should combine distinct:author with sort:top", async () => {
      const { client, references } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Author 1: two events, one popular and one not
      const event1a = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "Less popular from author 1",
        },
        sk1,
      );

      const event1b = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content: "Popular from author 1",
        },
        sk1,
      );

      // Author 2: one event
      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 50,
          tags: [],
          content: "Event from author 2",
        },
        sk2,
      );

      await relay.event(event1a);
      await relay.event(event1b);
      await relay.event(event2);

      // event1b has 5 refs, event1a has 1 ref, event2 has 3 refs
      references.set(event1b.id, [
        { kind: 1 },
        { kind: 1 },
        { kind: 1 },
        { kind: 1 },
        { kind: 1 },
      ]);
      references.set(event1a.id, [{ kind: 1 }]);
      references.set(event2.id, [{ kind: 1 }, { kind: 1 }, { kind: 1 }]);

      // Query with sort:top and distinct:author
      const results = await relay.query([
        { kinds: [1], search: "sort:top distinct:author" },
      ]);

      // Should return 2 events (one per author)
      assert.equal(results.length, 2);
      const pubkeys = results.map((e) => e.pubkey);
      assert.equal(new Set(pubkeys).size, 2);

      // event1b should be first (highest score from author 1), event2 second
      assert.equal(results[0].id, event1b.id);
      assert.equal(results[1].id, event2.id);
    });

    it("should handle sort:zaps query", async () => {
      const { client, zaps } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create two events
      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 3600,
          tags: [],
          content: "Lightly zapped event",
        },
        sk,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 7200,
          tags: [],
          content: "Heavily zapped event",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);

      // event1 received 1000 sats, event2 received 50000 sats
      zaps.set(event1.id, 1000);
      zaps.set(event2.id, 50000);

      // Query with sort:zaps
      const results = await relay.query([{ kinds: [1], search: "sort:zaps" }]);

      // Event2 should be first (more sats)
      assert.equal(results.length, 2);
      assert.equal(results[0].id, event2.id);
      assert.equal(results[1].id, event1.id);
    });

    it("should exclude events with no zaps from sort:zaps results", async () => {
      const { client, zaps } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const zappedEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "This one got zapped",
        },
        sk,
      );

      const unzappedEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 200,
          tags: [],
          content: "No zaps here",
        },
        sk,
      );

      await relay.event(zappedEvent);
      await relay.event(unzappedEvent);

      // Only one event has zaps
      zaps.set(zappedEvent.id, 5000);

      const results = await relay.query([{ kinds: [1], search: "sort:zaps" }]);

      // Only the zapped event should be returned
      assert.equal(results.length, 1);
      assert.equal(results[0].id, zappedEvent.id);
    });

    it("should return empty results when no events have zaps", async () => {
      const { client } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      await relay.event(
        finalizeEvent(
          { kind: 1, created_at: now - 100, tags: [], content: "No zaps" },
          sk,
        ),
      );

      const results = await relay.query([{ kinds: [1], search: "sort:zaps" }]);

      assert.equal(results.length, 0);
    });

    it("should combine distinct:author with sort:zaps", async () => {
      const { client, zaps } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Author 1: two events, one with 100 sats and one with 5000 sats
      const event1a = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "Author 1 low zaps",
        },
        sk1,
      );

      const event1b = finalizeEvent(
        {
          kind: 1,
          created_at: now - 50,
          tags: [],
          content: "Author 1 high zaps",
        },
        sk1,
      );

      // Author 2: one event with 3000 sats
      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 75,
          tags: [],
          content: "Author 2 medium zaps",
        },
        sk2,
      );

      await relay.event(event1a);
      await relay.event(event1b);
      await relay.event(event2);

      zaps.set(event1a.id, 100);
      zaps.set(event1b.id, 5000);
      zaps.set(event2.id, 3000);

      // Query with sort:zaps and distinct:author
      const results = await relay.query([
        { kinds: [1], search: "sort:zaps distinct:author" },
      ]);

      // Should return 2 events (one per author)
      assert.equal(results.length, 2);
      const pubkeys = results.map((e) => e.pubkey);
      assert.equal(new Set(pubkeys).size, 2);

      // event1b should be first (5000 sats, highest for author 1), event2 second (3000 sats)
      assert.equal(results[0].id, event1b.id);
      assert.equal(results[1].id, event2.id);
    });

    it("should return all events without distinct:author", async () => {
      const { client } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create multiple events from the same author
      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "First event",
        },
        sk,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content: "Second event",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);

      // Query without distinct:author should return all events
      const results = await relay.query([{ kinds: [1] }]);

      assert.equal(results.length, 2);
    });

    it("should count unique authors with distinct:author", async () => {
      const { client } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const sk3 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create multiple events from 3 authors
      await relay.event(
        finalizeEvent(
          { kind: 1, created_at: now, tags: [], content: "Event 1a" },
          sk1,
        ),
      );
      await relay.event(
        finalizeEvent(
          { kind: 1, created_at: now - 10, tags: [], content: "Event 1b" },
          sk1,
        ),
      );
      await relay.event(
        finalizeEvent(
          { kind: 1, created_at: now - 20, tags: [], content: "Event 2" },
          sk2,
        ),
      );
      await relay.event(
        finalizeEvent(
          { kind: 1, created_at: now - 30, tags: [], content: "Event 3" },
          sk3,
        ),
      );

      // COUNT with distinct:author should return 3 (unique authors)
      const result = await relay.count([{ search: "distinct:author" }]);
      assert.equal(result.count, 3);
      assert.equal(result.approximate, true);
    });

    it("should count all events without distinct:author", async () => {
      const { client } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      await relay.event(
        finalizeEvent(
          { kind: 1, created_at: now, tags: [], content: "Event 1a" },
          sk1,
        ),
      );
      await relay.event(
        finalizeEvent(
          { kind: 1, created_at: now - 10, tags: [], content: "Event 1b" },
          sk1,
        ),
      );
      await relay.event(
        finalizeEvent(
          { kind: 1, created_at: now - 20, tags: [], content: "Event 2" },
          sk2,
        ),
      );

      // COUNT without distinct:author should return total events (3)
      const result = await relay.count([{ kinds: [1] }]);
      assert.equal(result.count, 3);
    });
  });

  describe("NIP-48 protocol filter (NIP-50 extension)", () => {
    // Mock client with protocol field support
    const createProtocolMockClient = () => {
      const documents = new Map<string, unknown>();

      return {
        documents,
        client: {
          search: async ({ body }: { body: Record<string, unknown> }) => {
            const results: unknown[] = [];
            const queryMust = (
              (body.query as Record<string, unknown>)?.bool as Record<
                string,
                unknown
              >
            )?.must as Array<Record<string, unknown>> | undefined;

            // Extract protocol filter if present
            let protocolFilter: string | undefined;
            for (const clause of queryMust || []) {
              if ((clause.term as Record<string, unknown>)?.protocol) {
                protocolFilter = (clause.term as Record<string, unknown>)
                  .protocol as string;
              }
            }

            for (const [_id, doc] of documents.entries()) {
              const docTyped = doc as NostrEvent & {
                deleted?: boolean;
                protocol?: string;
              };

              // Skip deleted events
              if (docTyped.deleted) {
                continue;
              }

              // Filter by protocol if specified
              if (protocolFilter && docTyped.protocol !== protocolFilter) {
                continue;
              }

              results.push({ _source: doc });
            }

            return {
              body: {
                hits: { hits: results },
              },
            };
          },
          bulk: async ({ body }: { body: unknown[] }) => {
            const items: Array<Record<string, unknown>> = [];
            for (let i = 0; i < body.length; i += 2) {
              const action = body[i] as {
                index?: { _id: string };
                update?: { _id: string };
              };
              const payload = body[i + 1] as Record<string, unknown>;

              if (action.index) {
                documents.set(action.index._id, payload);
                items.push({ index: {} });
              } else if (action.update) {
                if (payload.upsert) {
                  if (!documents.has(action.update._id)) {
                    documents.set(action.update._id, payload.upsert);
                  }
                }
                items.push({ update: {} });
              }
            }
            return {
              body: {
                errors: false,
                items,
              },
            };
          },
          count: async () => {
            const nonDeleted = Array.from(documents.values()).filter(
              (doc) => !(doc as { deleted?: boolean }).deleted,
            );
            return { body: { count: nonDeleted.length } };
          },
          indices: {
            exists: async () => ({ body: true }),
            create: async () => ({ body: {} }),
          },
          close: async () => {},
        },
      };
    };

    it("should extract protocol from proxy tag", async () => {
      const { client } = createProtocolMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [
            [
              "proxy",
              "https://gleasonator.com/objects/8f6fac53-4f66-4c6e-ac7d-92e5e78c3e79",
              "activitypub",
            ],
          ],
          content: "I'm vegan btw",
        },
        sk,
      );

      await relay.event(event);

      // Verify the document was stored with protocol field
      const results = await relay.query([{ kinds: [1] }]);
      assert.equal(results.length, 1);
    });

    it("should filter by protocol using search extension", async () => {
      const { client } = createProtocolMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Event with activitypub protocol
      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [
            [
              "proxy",
              "https://gleasonator.com/objects/8f6fac53-4f66-4c6e-ac7d-92e5e78c3e79",
              "activitypub",
            ],
          ],
          content: "From ActivityPub",
        },
        sk,
      );

      // Event with atproto protocol
      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 10,
          tags: [
            [
              "proxy",
              "at://did:plc:zhbjlbmir5dganqhueg7y4i3/app.bsky.feed.post/3jt5hlibeol2i",
              "atproto",
            ],
          ],
          content: "From ATProto",
        },
        sk,
      );

      // Event with no protocol
      const event3 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 20,
          tags: [],
          content: "Native Nostr event",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);
      await relay.event(event3);

      // Filter by activitypub protocol
      const results1 = await relay.query([
        { kinds: [1], search: "protocol:activitypub" },
      ]);
      assert.equal(results1.length, 1);
      assert.equal(results1[0].id, event1.id);

      // Filter by atproto protocol
      const results2 = await relay.query([
        { kinds: [1], search: "protocol:atproto" },
      ]);
      assert.equal(results2.length, 1);
      assert.equal(results2[0].id, event2.id);

      // Query without protocol filter should return all events
      const resultsAll = await relay.query([{ kinds: [1] }]);
      assert.equal(resultsAll.length, 3);
    });

    it("should handle events with multiple proxy tags correctly", async () => {
      const { client } = createProtocolMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Event with multiple proxy tags (should use first one)
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [
            [
              "proxy",
              "https://gleasonator.com/objects/8f6fac53-4f66-4c6e-ac7d-92e5e78c3e79",
              "activitypub",
            ],
            ["proxy", "https://example.com/other", "web"],
          ],
          content: "Event with multiple proxy tags",
        },
        sk,
      );

      await relay.event(event);

      // Should filter by the first proxy tag's protocol
      const results = await relay.query([
        { kinds: [1], search: "protocol:activitypub" },
      ]);
      assert.equal(results.length, 1);
      assert.equal(results[0].id, event.id);
    });
  });
});
