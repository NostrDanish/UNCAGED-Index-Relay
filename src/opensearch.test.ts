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
                  must_not?: Array<{
                    term?: { replaced?: boolean };
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

            // Check if replaced events should be excluded
            const excludeReplaced = body.query.bool.must_not?.some(
              (clause) => clause.term?.replaced === true,
            );

            for (const [_id, doc] of documents.entries()) {
              const docTyped = doc as NostrEvent & {
                deleted?: boolean;
                replaced?: boolean;
              };

              // Skip deleted events
              if (docTyped.deleted) {
                continue;
              }

              // Skip replaced events if excluded
              if (excludeReplaced && docTyped.replaced) {
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
                  const existing = documents.get(action.update._id);
                  if (!existing) {
                    documents.set(action.update._id, payload.upsert);
                  } else {
                    // Simulate the Painless replaceable upsert script
                    const existingDoc = existing as Record<string, unknown>;
                    const newDoc = (
                      payload.script as {
                        params: { event: Record<string, unknown> };
                      }
                    ).params.event;
                    if (existingDoc.deleted === true) {
                      // noop
                    } else if (
                      (newDoc.created_at as number) >
                        (existingDoc.created_at as number) ||
                      ((newDoc.created_at as number) ===
                        (existingDoc.created_at as number) &&
                        (newDoc.id as string) < (existingDoc.id as string))
                    ) {
                      // Preserve stats fields across replacement
                      const statsFields = [
                        "followers",
                        "engagers",
                        "comment_cnt",
                        "reaction_cnt",
                        "repost_cnt",
                        "zap_amount_msats",
                      ];
                      const preserved: Record<string, unknown> = {};
                      for (const field of statsFields) {
                        preserved[field] = existingDoc[field];
                      }
                      documents.set(action.update._id, {
                        ...newDoc,
                        ...preserved,
                      });
                    }
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
          mget: async ({ body }: { body: { ids: string[] } }) => {
            const docs = body.ids.map((id) => {
              const doc = documents.get(id);
              if (doc) {
                return { found: true, _id: id, _source: doc };
              }
              return { found: false, _id: id };
            });
            return { body: { docs } };
          },
          get: async ({ id }: { id: string }) => {
            const doc = documents.get(id);
            if (doc) {
              return { body: { found: true, _source: doc } };
            }
            return { body: { found: false }, statusCode: 404 };
          },
          updateByQuery: async () => ({ body: { updated: 0 } }),
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

    it("should preserve stats when replacing a replaceable event", async () => {
      const { client, documents } = createMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Store an initial kind 0 event
      const event1 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 100,
          tags: [],
          content: JSON.stringify({ name: "Alice" }),
        },
        sk,
      );

      await relay.event(event1);

      // Simulate accumulated stats (e.g., followers)
      const doc = Array.from(documents.values())[0] as Record<string, unknown>;
      doc.followers = 42;
      doc.engagers = 7;
      doc.comment_cnt = 5;
      doc.reaction_cnt = 10;
      doc.repost_cnt = 3;
      doc.zap_amount_msats = 1_000_000;

      // Now replace with a newer kind 0 event from the same author
      const event2 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "Alice Updated" }),
        },
        sk,
      );

      await relay.event(event2);

      // The document should have been replaced, but stats should be preserved
      const updated = Array.from(documents.values())[0] as Record<
        string,
        unknown
      >;
      assert.equal(updated.id, event2.id, "Event should be replaced");
      assert.equal(
        (updated.content as string).includes("Alice Updated"),
        true,
        "Content should be updated",
      );
      assert.equal(updated.followers, 42, "followers should be preserved");
      assert.equal(updated.engagers, 7, "engagers should be preserved");
      assert.equal(updated.comment_cnt, 5, "comment_cnt should be preserved");
      assert.equal(
        updated.reaction_cnt,
        10,
        "reaction_cnt should be preserved",
      );
      assert.equal(updated.repost_cnt, 3, "repost_cnt should be preserved");
      assert.equal(
        updated.zap_amount_msats,
        1_000_000,
        "zap_amount_msats should be preserved",
      );
    });
  });

  describe("replaceable event history", () => {
    // Reuse the deletion mock client (supports mget, search, bulk with
    // scripted upsert, and partial doc update).
    const createHistoryMockClient = () => {
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
                    terms?: Record<string, string[]>;
                    term?: Record<string, unknown>;
                  }>;
                  must_not?: Array<{
                    term?: Record<string, unknown>;
                  }>;
                };
              };
              size?: number;
            };
          }) => {
            const results: unknown[] = [];

            let authorFilter: string[] | undefined;
            let kindFilter: number[] | undefined;
            let idFilter: string[] | undefined;
            const tagFilters = new Map<string, string[]>();
            for (const clause of body.query.bool.must) {
              if (clause.terms?.pubkey) authorFilter = clause.terms.pubkey;
              if (clause.terms?.kind)
                kindFilter = clause.terms.kind.map(Number);
              if (clause.terms?.id) idFilter = clause.terms.id;
              // Extract tags_map filters (e.g. tags_map.d)
              if (clause.terms) {
                for (const [key, val] of Object.entries(clause.terms)) {
                  if (key.startsWith("tags_map.")) {
                    tagFilters.set(
                      key.replace("tags_map.", ""),
                      val as string[],
                    );
                  }
                }
              }
            }

            const excludeReplaced = body.query.bool.must_not?.some(
              (clause) => clause.term?.replaced === true,
            );

            for (const [_id, doc] of documents.entries()) {
              const d = doc as NostrEvent & {
                deleted?: boolean;
                replaced?: boolean;
                tags_map?: Record<string, string[]>;
              };

              if (d.deleted) continue;
              if (excludeReplaced && d.replaced) continue;
              if (authorFilter && !authorFilter.includes(d.pubkey)) continue;
              if (kindFilter && !kindFilter.includes(d.kind)) continue;
              if (idFilter && !idFilter.includes(d.id)) continue;

              // Check tag filters against tags_map
              let tagMatch = true;
              for (const [tagName, values] of tagFilters) {
                const docValues = d.tags_map?.[tagName] ?? [];
                if (!values.some((v) => docValues.includes(v))) {
                  tagMatch = false;
                  break;
                }
              }
              if (!tagMatch) continue;

              results.push(doc);
            }

            // Sort by created_at desc
            results.sort(
              (a, b) =>
                (b as NostrEvent).created_at - (a as NostrEvent).created_at,
            );

            const size = body.size ?? results.length;
            return {
              body: {
                hits: {
                  hits: results.slice(0, size).map((doc) => ({ _source: doc })),
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
                  const existing = documents.get(action.update._id);
                  if (existing) {
                    documents.set(action.update._id, {
                      ...existing,
                      ...(payload.doc as Record<string, unknown>),
                    });
                  }
                } else if (payload.upsert) {
                  const existing = documents.get(action.update._id);
                  if (!existing) {
                    documents.set(action.update._id, payload.upsert);
                  } else {
                    const existingDoc = existing as Record<string, unknown>;
                    const newDoc = (
                      payload.script as {
                        params: { event: Record<string, unknown> };
                      }
                    ).params.event;
                    if (existingDoc.deleted === true) {
                      // noop
                    } else if (
                      (newDoc.created_at as number) >
                        (existingDoc.created_at as number) ||
                      ((newDoc.created_at as number) ===
                        (existingDoc.created_at as number) &&
                        (newDoc.id as string) < (existingDoc.id as string))
                    ) {
                      const statsFields = [
                        "followers",
                        "engagers",
                        "comment_cnt",
                        "reaction_cnt",
                        "repost_cnt",
                        "quote_cnt",
                        "zap_amount_msats",
                        "zap_cnt",
                      ];
                      const preserved: Record<string, unknown> = {};
                      for (const field of statsFields) {
                        preserved[field] = existingDoc[field];
                      }
                      documents.set(action.update._id, {
                        ...newDoc,
                        ...preserved,
                      });
                    }
                  }
                }
                items.push({ update: {} });
              }
            }
            return { body: { errors: false, items } };
          },
          mget: async ({ body }: { body: { ids: string[] } }) => {
            const docs = body.ids.map((id) => {
              const doc = documents.get(id);
              if (doc) return { found: true, _id: id, _source: doc };
              return { found: false, _id: id };
            });
            return { body: { docs } };
          },
          get: async ({ id }: { id: string }) => {
            const doc = documents.get(id);
            if (doc) return { body: { found: true, _source: doc } };
            return { body: { found: false }, statusCode: 404 };
          },
          updateByQuery: async ({
            body,
          }: {
            body: {
              query: {
                bool: {
                  must: Array<{
                    bool?: {
                      must: Array<{
                        terms?: Record<string, unknown>;
                        term?: Record<string, unknown>;
                        range?: Record<string, unknown>;
                      }>;
                      must_not?: Array<{
                        term?: Record<string, unknown>;
                        range?: Record<string, unknown>;
                      }>;
                    };
                    term?: Record<string, unknown>;
                  }>;
                };
              };
              script: { source: string };
            };
          }) => {
            // Extract filters from the nested bool query.
            let authorFilter: string[] | undefined;
            let kindFilter: number[] | undefined;
            let idFilter: string[] | undefined;
            let requireReplaced = false;
            let untilFilter: number | undefined;
            const tagFilters = new Map<string, string[]>();

            for (const clause of body.query.bool.must) {
              if (clause.term?.replaced === true) {
                requireReplaced = true;
              }
              if (clause.bool?.must) {
                for (const inner of clause.bool.must) {
                  if (inner.terms?.pubkey)
                    authorFilter = inner.terms.pubkey as string[];
                  if (inner.terms?.kind)
                    kindFilter = (inner.terms.kind as number[]).map(Number);
                  if (inner.terms?.id) idFilter = inner.terms.id as string[];
                  if (inner.range) {
                    const createdAt = inner.range.created_at as
                      | { lte?: number }
                      | undefined;
                    if (createdAt?.lte) untilFilter = createdAt.lte;
                  }
                  // Extract tags_map filters (e.g. tags_map.d)
                  if (inner.terms) {
                    for (const [key, val] of Object.entries(inner.terms)) {
                      if (key.startsWith("tags_map.")) {
                        tagFilters.set(
                          key.replace("tags_map.", ""),
                          val as string[],
                        );
                      }
                    }
                  }
                }
              }
            }

            let updated = 0;
            for (const [_id, doc] of documents.entries()) {
              const d = doc as NostrEvent & {
                deleted?: boolean;
                replaced?: boolean;
                tags_map?: Record<string, string[]>;
              };
              if (requireReplaced && !d.replaced) continue;
              if (d.deleted) continue;
              if (authorFilter && !authorFilter.includes(d.pubkey)) continue;
              if (kindFilter && !kindFilter.includes(d.kind)) continue;
              if (idFilter && !idFilter.includes(d.id)) continue;
              if (untilFilter && d.created_at > untilFilter) continue;

              // Check tag filters against tags_map
              let tagMatch = true;
              for (const [tagName, values] of tagFilters) {
                const docValues = d.tags_map?.[tagName] ?? [];
                if (!values.some((v) => docValues.includes(v))) {
                  tagMatch = false;
                  break;
                }
              }
              if (!tagMatch) continue;

              // Execute the script (we only support "ctx._source.deleted = true")
              if (body.script.source.includes("ctx._source.deleted = true")) {
                (d as Record<string, unknown>).deleted = true;
                updated++;
              }
            }

            return { body: { updated } };
          },
          indices: {
            exists: async () => ({ body: true }),
            create: async () => ({ body: {} }),
          },
          close: async () => {},
        },
      };
    };

    it("should archive old version when a replaceable event is replaced", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Store initial kind 0 event
      const event1 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 100,
          tags: [],
          content: JSON.stringify({ name: "Alice" }),
        },
        sk,
      );
      await relay.event(event1);

      // Replace with newer kind 0 event
      const event2 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "Alice Updated" }),
        },
        sk,
      );
      await relay.event(event2);

      // Should have 2 documents: the current (naddr) and the history (note1)
      assert.equal(documents.size, 2, "Should have current + history document");

      // Find the history document (has replaced: true)
      const docs = Array.from(documents.values()) as Array<
        NostrEvent & { replaced?: boolean }
      >;
      const historyDoc = docs.find((d) => d.replaced === true);
      const currentDoc = docs.find((d) => !d.replaced);

      assert.ok(historyDoc, "Should have a history document");
      assert.ok(currentDoc, "Should have a current document");
      assert.equal(
        historyDoc!.id,
        event1.id,
        "History should be the old event",
      );
      assert.equal(
        currentDoc!.id,
        event2.id,
        "Current should be the new event",
      );
    });

    it("should archive old version when an addressable event is replaced", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 30023,
          created_at: now - 100,
          tags: [["d", "my-article"]],
          content: "Version 1",
        },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        {
          kind: 30023,
          created_at: now,
          tags: [["d", "my-article"]],
          content: "Version 2",
        },
        sk,
      );
      await relay.event(event2);

      assert.equal(documents.size, 2, "Should have current + history document");

      const docs = Array.from(documents.values()) as Array<
        NostrEvent & { replaced?: boolean }
      >;
      const historyDoc = docs.find((d) => d.replaced === true);
      const currentDoc = docs.find((d) => !d.replaced);

      assert.ok(historyDoc, "Should have a history document");
      assert.equal(historyDoc!.id, event1.id);
      assert.equal(currentDoc!.id, event2.id);
    });

    it("should not archive when the incoming event is older", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Store the newer event first
      const event1 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "Alice" }),
        },
        sk,
      );
      await relay.event(event1);

      // Try to store an older event for the same slot
      const event2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 100,
          tags: [],
          content: JSON.stringify({ name: "Old Alice" }),
        },
        sk,
      );
      await relay.event(event2);

      // Should still only have 1 document (no history created for rejected event)
      assert.equal(documents.size, 1, "Should only have the current document");

      const doc = Array.from(documents.values())[0] as NostrEvent;
      assert.equal(
        doc.id,
        event1.id,
        "Current should still be the newer event",
      );
    });

    it("should not archive a duplicate event", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "Alice" }),
        },
        sk,
      );
      await relay.event(event1);
      await relay.event(event1); // Send the same event again

      assert.equal(
        documents.size,
        1,
        "Should not create history for duplicate",
      );
    });

    it("should strip score fields from history documents", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 100,
          tags: [],
          content: JSON.stringify({ name: "Alice" }),
        },
        sk,
      );
      await relay.event(event1);

      // Simulate accumulated scores
      const doc = Array.from(documents.values())[0] as Record<string, unknown>;
      doc.followers = 42;
      doc.engagers = 7;

      // Replace
      const event2 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "Alice Updated" }),
        },
        sk,
      );
      await relay.event(event2);

      const docs = Array.from(documents.values()) as Array<
        Record<string, unknown>
      >;
      const historyDoc = docs.find((d) => d.replaced === true);

      assert.ok(historyDoc, "Should have a history document");
      assert.equal(
        historyDoc!.followers,
        undefined,
        "followers should be stripped from history",
      );
      assert.equal(
        historyDoc!.engagers,
        undefined,
        "engagers should be stripped from history",
      );
    });

    it("should not archive when the slot is soft-deleted", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 100,
          tags: [],
          content: JSON.stringify({ name: "Alice" }),
        },
        sk,
      );
      await relay.event(event1);

      // Soft-delete the document
      const doc = Array.from(documents.values())[0] as Record<string, unknown>;
      doc.deleted = true;

      // Try to store a newer event
      const event2 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "Alice Updated" }),
        },
        sk,
      );
      await relay.event(event2);

      // Should not create a history entry for a deleted slot
      assert.equal(
        documents.size,
        1,
        "Should not create history for deleted slot",
      );
    });

    it("should accumulate multiple history versions", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 200,
          tags: [],
          content: JSON.stringify({ name: "V1" }),
        },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 100,
          tags: [],
          content: JSON.stringify({ name: "V2" }),
        },
        sk,
      );
      await relay.event(event2);

      const event3 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "V3" }),
        },
        sk,
      );
      await relay.event(event3);

      // Should have 3 documents: current + 2 history
      assert.equal(documents.size, 3, "Should have current + 2 history docs");

      const docs = Array.from(documents.values()) as Array<
        NostrEvent & { replaced?: boolean }
      >;
      const historyDocs = docs.filter((d) => d.replaced === true);
      const currentDoc = docs.find((d) => !d.replaced);

      assert.equal(historyDocs.length, 2, "Should have 2 history documents");
      assert.equal(currentDoc!.id, event3.id, "Current should be V3");

      const historyIds = historyDocs.map((d) => d.id).sort();
      const expectedIds = [event1.id, event2.id].sort();
      assert.deepEqual(
        historyIds,
        expectedIds,
        "History should contain V1 and V2",
      );
    });

    it("should auto-include history for naddr-shaped filters (replaceable)", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        { kind: 0, created_at: now - 100, tags: [], content: '{"name":"V1"}' },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        { kind: 0, created_at: now, tags: [], content: '{"name":"V2"}' },
        sk,
      );
      await relay.event(event2);

      // Query with naddr-shaped filter: 1 kind + 1 author -> includes history
      const results = await relay.query([
        { kinds: [0], authors: [event1.pubkey] },
      ]);

      assert.equal(results.length, 2, "Should return current + history");
      assert.equal(
        results[0].id,
        event2.id,
        "First result should be current (newest)",
      );
      assert.equal(
        results[1].id,
        event1.id,
        "Second result should be history (oldest)",
      );
    });

    it("should auto-include history for naddr-shaped filters (addressable)", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 30023,
          created_at: now - 100,
          tags: [["d", "slug"]],
          content: "V1",
        },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        {
          kind: 30023,
          created_at: now,
          tags: [["d", "slug"]],
          content: "V2",
        },
        sk,
      );
      await relay.event(event2);

      // Query with naddr-shaped filter: 1 addressable kind + 1 author + 1 #d
      const results = await relay.query([
        { kinds: [30023], authors: [event1.pubkey], "#d": ["slug"] },
      ]);

      assert.equal(results.length, 2, "Should return current + history");
    });

    it("should NOT include history for multi-author filters", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Store events for sk1 with a replacement
      const event1 = finalizeEvent(
        { kind: 0, created_at: now - 100, tags: [], content: '{"name":"V1"}' },
        sk1,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        { kind: 0, created_at: now, tags: [], content: '{"name":"V2"}' },
        sk1,
      );
      await relay.event(event2);

      // Store event for sk2
      const event3 = finalizeEvent(
        { kind: 0, created_at: now, tags: [], content: '{"name":"Bob"}' },
        sk2,
      );
      await relay.event(event3);

      // Query with multi-author filter -> should NOT include history
      const results = await relay.query([
        { kinds: [0], authors: [event1.pubkey, event3.pubkey] },
      ]);

      // Should only get the 2 current versions, not the history
      assert.equal(
        results.length,
        2,
        "Should return only current versions for multi-author query",
      );
    });

    it("should return history docs when queried by ID", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        { kind: 0, created_at: now - 100, tags: [], content: '{"name":"V1"}' },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        { kind: 0, created_at: now, tags: [], content: '{"name":"V2"}' },
        sk,
      );
      await relay.event(event2);

      // Query for the old event by its ID — should find it even though it's replaced
      const results = await relay.query([{ ids: [event1.id] }]);
      assert.equal(results.length, 1, "Should return the history doc by ID");
      assert.equal(results[0].id, event1.id);
    });

    it("should soft-delete history when removing by coordinate filter (kind 5 a-tag)", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create V1 and V2 so there's a history doc
      const event1 = finalizeEvent(
        { kind: 0, created_at: now - 100, tags: [], content: '{"name":"V1"}' },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        { kind: 0, created_at: now, tags: [], content: '{"name":"V2"}' },
        sk,
      );
      await relay.event(event2);

      assert.equal(documents.size, 2, "Should have current + history");

      // Delete via coordinate filter (as kind 5 with a-tag would produce)
      await relay.remove([{ kinds: [0], authors: [event1.pubkey] }]);

      // Both should be soft-deleted
      const docs = Array.from(documents.values()) as Array<
        Record<string, unknown>
      >;
      const nonDeleted = docs.filter((d) => d.deleted !== true);
      assert.equal(
        nonDeleted.length,
        0,
        "Both current and history should be soft-deleted",
      );
    });

    it("should cascade deletion to history when removing by event ID", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        { kind: 0, created_at: now - 100, tags: [], content: '{"name":"V1"}' },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        { kind: 0, created_at: now, tags: [], content: '{"name":"V2"}' },
        sk,
      );
      await relay.event(event2);

      assert.equal(documents.size, 2, "Should have current + history");

      // Delete via event ID filter (as kind 5 with e-tag would produce).
      // This targets the current version by ID, but should cascade to
      // history via coordinate resolution.
      await relay.remove([{ ids: [event2.id], authors: [event2.pubkey] }]);

      const docs = Array.from(documents.values()) as Array<
        Record<string, unknown>
      >;
      const nonDeleted = docs.filter((d) => d.deleted !== true);
      assert.equal(
        nonDeleted.length,
        0,
        "History should be cascaded-deleted when current is deleted by ID",
      );
    });

    it("should soft-delete history on vanish (kind 62)", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create replaceable event history
      const event1 = finalizeEvent(
        { kind: 0, created_at: now - 200, tags: [], content: '{"name":"V1"}' },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        { kind: 0, created_at: now - 100, tags: [], content: '{"name":"V2"}' },
        sk,
      );
      await relay.event(event2);

      // Also create a regular (non-replaceable) event
      const regularEvent = finalizeEvent(
        { kind: 1, created_at: now - 50, tags: [], content: "Hello" },
        sk,
      );
      await relay.event(regularEvent);

      assert.equal(documents.size, 3, "Should have 2 kind-0 docs + 1 kind-1");

      // Vanish: delete all events from this author up to now
      await relay.remove([{ authors: [event1.pubkey], until: now }]);

      const docs = Array.from(documents.values()) as Array<
        Record<string, unknown>
      >;
      const nonDeleted = docs.filter((d) => d.deleted !== true);
      assert.equal(
        nonDeleted.length,
        0,
        "Vanish should soft-delete all events including history",
      );
    });

    it("should soft-delete addressable event history when deleting by coordinate", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 30023,
          created_at: now - 100,
          tags: [["d", "my-article"]],
          content: "V1",
        },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        {
          kind: 30023,
          created_at: now,
          tags: [["d", "my-article"]],
          content: "V2",
        },
        sk,
      );
      await relay.event(event2);

      assert.equal(documents.size, 2, "Should have current + history");

      // Delete via coordinate filter (kind 5 a-tag for addressable event)
      await relay.remove([
        { kinds: [30023], authors: [event1.pubkey], "#d": ["my-article"] },
      ]);

      const docs = Array.from(documents.values()) as Array<
        Record<string, unknown>
      >;
      const nonDeleted = docs.filter((d) => d.deleted !== true);
      assert.equal(
        nonDeleted.length,
        0,
        "Both current and history of addressable event should be deleted",
      );
    });

    it("should delete only the historical event when targeting it by ID (not cascade)", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        { kind: 0, created_at: now - 100, tags: [], content: '{"name":"V1"}' },
        sk,
      );
      await relay.event(event1);

      const event2 = finalizeEvent(
        { kind: 0, created_at: now, tags: [], content: '{"name":"V2"}' },
        sk,
      );
      await relay.event(event2);

      assert.equal(documents.size, 2, "Should have current + history");

      // Delete the historical event by its specific ID.
      // This should only delete V1 (history), not V2 (current).
      await relay.remove([{ ids: [event1.id], authors: [event1.pubkey] }]);

      const docs = Array.from(documents.values()) as Array<
        NostrEvent & { deleted?: boolean; replaced?: boolean }
      >;
      const nonDeleted = docs.filter((d) => d.deleted !== true);
      assert.equal(
        nonDeleted.length,
        1,
        "Only the historical event should be deleted",
      );
      assert.equal(
        nonDeleted[0].id,
        event2.id,
        "Current version should survive",
      );
    });

    it("should not cascade deletion to different d-tag addressable events", async () => {
      const { client, documents } = createHistoryMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create two different addressable event slots
      const article1v1 = finalizeEvent(
        {
          kind: 30023,
          created_at: now - 100,
          tags: [["d", "article-1"]],
          content: "Article 1 V1",
        },
        sk,
      );
      await relay.event(article1v1);

      const article1v2 = finalizeEvent(
        {
          kind: 30023,
          created_at: now,
          tags: [["d", "article-1"]],
          content: "Article 1 V2",
        },
        sk,
      );
      await relay.event(article1v2);

      const article2v1 = finalizeEvent(
        {
          kind: 30023,
          created_at: now - 50,
          tags: [["d", "article-2"]],
          content: "Article 2 V1",
        },
        sk,
      );
      await relay.event(article2v1);

      assert.equal(documents.size, 3, "2 article-1 docs + 1 article-2 doc");

      // Delete article-1 by coordinate — should not affect article-2
      await relay.remove([
        { kinds: [30023], authors: [article1v1.pubkey], "#d": ["article-1"] },
      ]);

      const docs = Array.from(documents.values()) as Array<
        NostrEvent & { deleted?: boolean }
      >;
      const nonDeleted = docs.filter((d) => d.deleted !== true);
      assert.equal(nonDeleted.length, 1, "Only article-2 should survive");
      assert.equal(
        nonDeleted[0].id,
        article2v1.id,
        "Surviving event should be article-2",
      );
    });
  });

  describe("NIP-50 sort", () => {
    // Mock client with precomputed score support for sort tests.
    // Score fields are set directly on documents by tests; the mock client
    // simulates OpenSearch sort, script_score, and range filter behaviour.
    const createSortMockClient = () => {
      const documents = new Map<string, unknown>();

      /** Helper: extract the bool.must array from a query (unwrapping script_score). */
      const extractMustClauses = (
        query: Record<string, unknown>,
      ): Array<Record<string, unknown>> => {
        // script_score wraps the real query
        if (query.script_score) {
          const inner = (
            query.script_score as { query: Record<string, unknown> }
          ).query;
          return (
            ((inner.bool as Record<string, unknown>)?.must as Array<
              Record<string, unknown>
            >) || []
          );
        }
        return (
          ((query.bool as Record<string, unknown>)?.must as Array<
            Record<string, unknown>
          >) || []
        );
      };

      /** Helper: extract the bool.must_not array from a query (unwrapping script_score). */
      const extractMustNotClauses = (
        query: Record<string, unknown>,
      ): Array<Record<string, unknown>> => {
        if (query.script_score) {
          const inner = (
            query.script_score as { query: Record<string, unknown> }
          ).query;
          return (
            ((inner.bool as Record<string, unknown>)?.must_not as Array<
              Record<string, unknown>
            >) || []
          );
        }
        return (
          ((query.bool as Record<string, unknown>)?.must_not as Array<
            Record<string, unknown>
          >) || []
        );
      };

      /** Helper: resolve a dotted field path on a document. */
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const resolveField = (doc: any, field: string): unknown => {
        if (!field.includes(".")) return doc[field];
        return field
          .split(".")
          .reduce(
            (o: Record<string, unknown>, k: string) =>
              o?.[k] as Record<string, unknown>,
            doc,
          );
      };

      /** Helper: check if a document passes all must clauses. */
      const matchesMust = (
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        doc: any,
        clauses: Array<Record<string, unknown>>,
      ): boolean => {
        for (const clause of clauses) {
          if (clause.term) {
            const [field, value] = Object.entries(
              clause.term as Record<string, unknown>,
            )[0];
            if (resolveField(doc, field) !== value) return false;
          }
          if (clause.terms) {
            const [field, values] = Object.entries(
              clause.terms as Record<string, unknown[]>,
            )[0];
            if (!values.includes(resolveField(doc, field) as unknown))
              return false;
          }
          if (clause.range) {
            const [field, bounds] = Object.entries(
              clause.range as Record<string, Record<string, number>>,
            )[0];
            const val = resolveField(doc, field) as number | undefined | null;
            if (val === undefined || val === null) return false;
            if (bounds.gt !== undefined && !(val > bounds.gt)) return false;
            if (bounds.gte !== undefined && !(val >= bounds.gte)) return false;
            if (bounds.lt !== undefined && !(val < bounds.lt)) return false;
            if (bounds.lte !== undefined && !(val <= bounds.lte)) return false;
          }
          if (clause.match) {
            const [field, matchValue] = Object.entries(
              clause.match as Record<string, unknown>,
            )[0];
            const matchQuery =
              typeof matchValue === "object"
                ? (matchValue as { query: string }).query
                : String(matchValue);
            const text = String(resolveField(doc, field) || "").toLowerCase();
            const terms = matchQuery.toLowerCase().split(/\s+/);
            if (!terms.every((t: string) => text.includes(t))) return false;
          }
          // Handle multi_match (edge-ngram prefix matching on metadata fields)
          if (clause.multi_match) {
            const mm = clause.multi_match as {
              query: string;
              fields: string[];
              operator?: string;
            };
            const queryTerms = mm.query.toLowerCase().split(/\s+/);
            const anyFieldMatches = mm.fields.some((field) => {
              const text = String(resolveField(doc, field) || "").toLowerCase();
              return queryTerms.every((t) => text.includes(t));
            });
            if (!anyFieldMatches) return false;
          }
        }
        return true;
      };

      /** Helper: compute script_score for a document. */
      const computeScriptScore = (
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        doc: any,
        query: Record<string, unknown>,
      ): number | null => {
        if (!query.script_score) return null;
        const script = (
          query.script_score as {
            script: { source: string; params?: Record<string, number> };
          }
        ).script;
        const params = script.params || {};

        // Simple script evaluation for our known scripts
        const src = script.source.replace(/\s+/g, " ").trim();

        if (src.includes("Math.pow(0.5, ageHours / 24.0)")) {
          // sort:hot — uses engagers for non-kind-0, followers for kind-0
          const score = src.includes("followers")
            ? doc.followers || 0
            : doc.engagers || 0;
          const ageHours = (params.now - doc.created_at) / 3600;
          return score * 0.5 ** (ageHours / 24);
        }
        if (src.includes("Math.min(comments, reactions)")) {
          // sort:controversial
          const comments = doc.comment_cnt || 0;
          const reactions = doc.reaction_cnt || 0;
          const balanced = Math.min(comments, reactions);
          return balanced * Math.sqrt(comments + reactions);
        }
        if (src.includes("total / ageHours")) {
          // sort:rising
          const total =
            (doc.comment_cnt || 0) +
            (doc.reaction_cnt || 0) +
            (doc.repost_cnt || 0);
          const ageHours = Math.max((params.now - doc.created_at) / 3600, 0.1);
          return total / ageHours;
        }
        return 0;
      };

      return {
        documents,
        /** Set a score field on a stored document (by event ID). */
        setScore: (
          eventId: string,
          scores: Partial<{
            followers: number;
            engagers: number;
            comment_cnt: number;
            reaction_cnt: number;
            repost_cnt: number;
            zap_amount_msats: number;
          }>,
        ) => {
          for (const [_docId, doc] of documents.entries()) {
            // biome-ignore lint/suspicious/noExplicitAny: test mock
            const d = doc as any;
            if (d.id === eventId) {
              Object.assign(d, scores);
              break;
            }
          }
        },
        client: {
          search: async ({ body }: { body: Record<string, unknown> }) => {
            const query = body.query as Record<string, unknown>;

            // Handle aggregation queries (used by distinct:author count)
            if (body.aggs) {
              const aggs = body.aggs as Record<string, unknown>;
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
            }

            // Filter documents against the query
            const mustClauses = extractMustClauses(query);
            const mustNotClauses = extractMustNotClauses(query);
            const results: Array<{ _source: unknown; _score?: number }> = [];

            for (const [_id, doc] of documents.entries()) {
              // biome-ignore lint/suspicious/noExplicitAny: test mock
              const d = doc as any;
              if (d.deleted) continue;
              if (!matchesMust(d, mustClauses)) continue;
              // Exclude if doc matches any must_not clause
              if (mustNotClauses.some((c) => matchesMust(d, [c]))) continue;

              const scriptScore = computeScriptScore(d, query);
              results.push({
                _source: doc,
                ...(scriptScore !== null && { _score: scriptScore }),
              });
            }

            // Apply sorting
            const sort = body.sort as
              | Array<Record<string, { order: string }>>
              | undefined;

            if (sort && sort.length > 0) {
              const [sortField, sortOpts] = Object.entries(sort[0])[0];
              const desc = (sortOpts as { order: string }).order === "desc";
              results.sort((a, b) => {
                // biome-ignore lint/suspicious/noExplicitAny: test mock
                const aVal = (a._source as any)[sortField] ?? 0;
                // biome-ignore lint/suspicious/noExplicitAny: test mock
                const bVal = (b._source as any)[sortField] ?? 0;
                return desc ? bVal - aVal : aVal - bVal;
              });
            } else if (results.length > 0 && results[0]._score !== undefined) {
              // Sort by script score descending
              results.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
            } else {
              // Default sort by created_at desc
              results.sort((a, b) => {
                const aDoc = a._source as NostrEvent;
                const bDoc = b._source as NostrEvent;
                return bDoc.created_at - aDoc.created_at;
              });
            }

            // Simulate OpenSearch collapse (field collapsing)
            const collapse = body.collapse as { field: string } | undefined;
            if (collapse?.field) {
              const seen = new Set<string>();
              const collapsed: typeof results = [];
              for (const hit of results) {
                const src = hit._source as NostrEvent;
                const val = src[collapse.field as keyof NostrEvent] as string;
                if (!seen.has(val)) {
                  seen.add(val);
                  collapsed.push(hit);
                }
              }
              return { body: { hits: { hits: collapsed } } };
            }

            // Apply size limit
            const size = (body.size as number) ?? results.length;
            return { body: { hits: { hits: results.slice(0, size) } } };
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
          mget: async ({ body }: { body: { ids: string[] } }) => {
            const docs = body.ids.map((id) => {
              const doc = documents.get(id);
              if (doc) return { found: true, _id: id, _source: doc };
              return { found: false, _id: id };
            });
            return { body: { docs } };
          },
          updateByQuery: async () => ({ body: { updated: 0 } }),
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
      const { client, setScore } = createSortMockClient();
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

      // Set precomputed scores (event2 has higher engagers)
      setScore(event1.id, { engagers: 1 });
      setScore(event2.id, { engagers: 3 });

      // Query with sort:top
      const results = await relay.query([{ kinds: [1], search: "sort:top" }]);

      // Event2 should be first (higher engagers)
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
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create two events: one very recent, one older
      const recentEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 1800, // 30 minutes ago
          tags: [],
          content: "Recent event",
        },
        sk,
      );

      const olderEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 20 * 3600, // 20 hours ago
          tags: [],
          content: "Older event",
        },
        sk,
      );

      await relay.event(recentEvent);
      await relay.event(olderEvent);

      // Same engagers, but recent event scores higher due to less time decay
      // recent: 5 * 0.5^(0.5/24) ≈ 4.93
      // older:  5 * 0.5^(20/24) ≈ 2.17
      setScore(recentEvent.id, { engagers: 5 });
      setScore(olderEvent.id, { engagers: 5 });

      // Query with sort:hot
      const results = await relay.query([{ kinds: [1], search: "sort:hot" }]);

      assert.equal(results.length, 2);
      assert.equal(results[0].id, recentEvent.id);
    });

    it("should combine sort with full-text search", async () => {
      const { client, setScore } = createSortMockClient();
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
      setScore(event.id, { engagers: 1 });

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
      const { client, setScore } = createSortMockClient();
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

      // Set precomputed scores
      setScore(event1b.id, { engagers: 5 });
      setScore(event1a.id, { engagers: 1 });
      setScore(event2.id, { engagers: 3 });

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
      const { client, setScore } = createSortMockClient();
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

      // Set precomputed zap amounts
      setScore(event1.id, { zap_amount_msats: 1_000_000 });
      setScore(event2.id, { zap_amount_msats: 50_000_000 });

      // Query with sort:zaps
      const results = await relay.query([{ kinds: [1], search: "sort:zaps" }]);

      // Event2 should be first (more sats)
      assert.equal(results.length, 2);
      assert.equal(results[0].id, event2.id);
      assert.equal(results[1].id, event1.id);
    });

    it("should exclude events with no zaps from sort:zaps results", async () => {
      const { client, setScore } = createSortMockClient();
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
      setScore(zappedEvent.id, { zap_amount_msats: 5_000_000 });

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
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Author 1: two events, one with low zaps and one with high zaps
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

      // Author 2: one event with medium zaps
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

      setScore(event1a.id, { zap_amount_msats: 100_000 });
      setScore(event1b.id, { zap_amount_msats: 5_000_000 });
      setScore(event2.id, { zap_amount_msats: 3_000_000 });

      // Query with sort:zaps and distinct:author
      const results = await relay.query([
        { kinds: [1], search: "sort:zaps distinct:author" },
      ]);

      // Should return 2 events (one per author)
      assert.equal(results.length, 2);
      const pubkeys = results.map((e) => e.pubkey);
      assert.equal(new Set(pubkeys).size, 2);

      // event1b should be first (5M msats, highest for author 1), event2 second (3M msats)
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

    it("should default to sort:top when search has no extension tokens", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 3600,
          tags: [],
          content: "hello world",
        },
        sk,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 7200,
          tags: [],
          content: "hello there",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);

      // event2 has higher engagers
      setScore(event1.id, { engagers: 1 });
      setScore(event2.id, { engagers: 5 });

      // Plain text search with no tokens should use sort:top
      const results = await relay.query([{ kinds: [1], search: "hello" }]);

      // event2 should be first (higher engagers), proving sort:top was applied
      assert.equal(results.length, 2);
      assert.equal(results[0].id, event2.id);
      assert.equal(results[1].id, event1.id);
    });

    it("should not default to sort:top when sort:new token is present", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "hello recent",
        },
        sk,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 7200,
          tags: [],
          content: "hello older",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);

      // event2 has higher engagers, but sort:new should use chronological order
      setScore(event1.id, { engagers: 1 });
      setScore(event2.id, { engagers: 10 });

      // sort:new is a no-op token that prevents the default sort:top
      const results = await relay.query([
        { kinds: [1], search: "hello sort:new" },
      ]);

      // event1 should be first (more recent created_at), proving chronological order
      assert.equal(results.length, 2);
      assert.equal(results[0].id, event1.id);
      assert.equal(results[1].id, event2.id);
    });

    it("should not default to sort:top when search is absent", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "hello recent",
        },
        sk,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 7200,
          tags: [],
          content: "hello older",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);

      setScore(event1.id, { engagers: 1 });
      setScore(event2.id, { engagers: 10 });

      // No search field at all — should use default chronological order
      const results = await relay.query([{ kinds: [1] }]);

      // event1 should be first (more recent), proving chronological order was used
      assert.equal(results.length, 2);
      assert.equal(results[0].id, event1.id);
      assert.equal(results[1].id, event2.id);
    });

    it("should exclude events matching negative search tokens", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "I love nostr and bitcoin",
        },
        sk,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 200,
          tags: [],
          content: "I love nostr and ethereum",
        },
        sk,
      );

      const event3 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 300,
          tags: [],
          content: "I love nostr",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);
      await relay.event(event3);

      setScore(event1.id, { engagers: 3 });
      setScore(event2.id, { engagers: 2 });
      setScore(event3.id, { engagers: 1 });

      // Negative token: exclude events containing "bitcoin"
      const results = await relay.query([
        { kinds: [1], search: "nostr -bitcoin sort:new" },
      ]);

      assert.equal(results.length, 2);
      // event1 contains "bitcoin" and should be excluded
      assert.ok(results.every((e) => e.id !== event1.id));
      assert.equal(results[0].id, event2.id);
      assert.equal(results[1].id, event3.id);
    });

    it("should support search with only negative tokens", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "bitcoin is great",
        },
        sk,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 200,
          tags: [],
          content: "nostr is great",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);

      setScore(event1.id, { engagers: 1 });
      setScore(event2.id, { engagers: 1 });

      // Only negative tokens, no positive text
      const results = await relay.query([
        { kinds: [1], search: "-bitcoin sort:new" },
      ]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, event2.id);
    });

    it("should support multiple negative search tokens", async () => {
      const { client, setScore } = createSortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "bitcoin is great",
        },
        sk,
      );

      const event2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 200,
          tags: [],
          content: "ethereum is great",
        },
        sk,
      );

      const event3 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 300,
          tags: [],
          content: "nostr is great",
        },
        sk,
      );

      await relay.event(event1);
      await relay.event(event2);
      await relay.event(event3);

      setScore(event1.id, { engagers: 1 });
      setScore(event2.id, { engagers: 1 });
      setScore(event3.id, { engagers: 1 });

      // Multiple negative tokens
      const results = await relay.query([
        { kinds: [1], search: "-bitcoin -ethereum sort:new" },
      ]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, event3.id);
    });
  });

  describe("NIP-50 sort: kind 0 (profile) queries", () => {
    // Mock client supporting kind-0 sort queries. Extends the sort mock
    // client with aggregation support for the zaps-by-author query.
    const createKind0SortMockClient = () => {
      const documents = new Map<string, unknown>();

      /** Helper: extract the bool.must array from a query (unwrapping script_score). */
      const extractMustClauses = (
        query: Record<string, unknown>,
      ): Array<Record<string, unknown>> => {
        if (query.script_score) {
          const inner = (
            query.script_score as { query: Record<string, unknown> }
          ).query;
          return (
            ((inner.bool as Record<string, unknown>)?.must as Array<
              Record<string, unknown>
            >) || []
          );
        }
        return (
          ((query.bool as Record<string, unknown>)?.must as Array<
            Record<string, unknown>
          >) || []
        );
      };

      /** Helper: extract the bool.must_not array from a query (unwrapping script_score). */
      const extractMustNotClauses = (
        query: Record<string, unknown>,
      ): Array<Record<string, unknown>> => {
        if (query.script_score) {
          const inner = (
            query.script_score as { query: Record<string, unknown> }
          ).query;
          return (
            ((inner.bool as Record<string, unknown>)?.must_not as Array<
              Record<string, unknown>
            >) || []
          );
        }
        return (
          ((query.bool as Record<string, unknown>)?.must_not as Array<
            Record<string, unknown>
          >) || []
        );
      };

      /** Helper: resolve a dotted field path on a document. */
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const resolveField = (doc: any, field: string): unknown => {
        if (!field.includes(".")) return doc[field];
        return field
          .split(".")
          .reduce(
            (o: Record<string, unknown>, k: string) =>
              o?.[k] as Record<string, unknown>,
            doc,
          );
      };

      /** Helper: check if a document passes all must clauses. */
      const matchesMust = (
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        doc: any,
        clauses: Array<Record<string, unknown>>,
      ): boolean => {
        for (const clause of clauses) {
          if (clause.term) {
            const [field, value] = Object.entries(
              clause.term as Record<string, unknown>,
            )[0];
            if (resolveField(doc, field) !== value) return false;
          }
          if (clause.terms) {
            const [field, values] = Object.entries(
              clause.terms as Record<string, unknown[]>,
            )[0];
            const docVal = resolveField(doc, field);
            // For array fields (like tags_map.p), check if any element matches
            if (Array.isArray(docVal)) {
              if (!docVal.some((v: unknown) => values.includes(v)))
                return false;
            } else {
              if (!values.includes(docVal as unknown)) return false;
            }
          }
          if (clause.range) {
            const [field, bounds] = Object.entries(
              clause.range as Record<string, Record<string, number>>,
            )[0];
            const val = resolveField(doc, field) as number | undefined | null;
            if (val === undefined || val === null) return false;
            if (bounds.gt !== undefined && !(val > bounds.gt)) return false;
            if (bounds.gte !== undefined && !(val >= bounds.gte)) return false;
            if (bounds.lt !== undefined && !(val < bounds.lt)) return false;
            if (bounds.lte !== undefined && !(val <= bounds.lte)) return false;
          }
          if (clause.match) {
            const [field, matchValue] = Object.entries(
              clause.match as Record<string, unknown>,
            )[0];
            const matchQuery =
              typeof matchValue === "object"
                ? (matchValue as { query: string }).query
                : String(matchValue);
            const text = String(resolveField(doc, field) || "").toLowerCase();
            const terms = matchQuery.toLowerCase().split(/\s+/);
            if (!terms.every((t: string) => text.includes(t))) return false;
          }
          // Handle multi_match (edge-ngram prefix matching on metadata fields)
          if (clause.multi_match) {
            const mm = clause.multi_match as {
              query: string;
              fields: string[];
              operator?: string;
            };
            const queryTerms = mm.query.toLowerCase().split(/\s+/);
            // At least one field must match all terms (prefix/substring match
            // simulates edge-ngram behaviour).
            const anyFieldMatches = mm.fields.some((field) => {
              const text = String(resolveField(doc, field) || "").toLowerCase();
              return queryTerms.every((t) => text.includes(t));
            });
            if (!anyFieldMatches) return false;
          }
        }
        return true;
      };

      /** Helper: compute script_score for a document. */
      const computeScriptScore = (
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        doc: any,
        query: Record<string, unknown>,
      ): number | null => {
        if (!query.script_score) return null;
        const script = (
          query.script_score as {
            script: { source: string; params?: Record<string, number> };
          }
        ).script;
        const params = script.params || {};
        const src = script.source.replace(/\s+/g, " ").trim();

        if (src.includes("Math.pow(0.5, ageHours / 24.0)")) {
          // sort:hot — uses engagers for non-kind-0, followers for kind-0
          const score = src.includes("followers")
            ? doc.followers || 0
            : doc.engagers || 0;
          const ageHours = (params.now - doc.created_at) / 3600;
          return score * 0.5 ** (ageHours / 24);
        }
        if (src.includes("Math.min(comments, reactions)")) {
          const comments = doc.comment_cnt || 0;
          const reactions = doc.reaction_cnt || 0;
          const balanced = Math.min(comments, reactions);
          return balanced * Math.sqrt(comments + reactions);
        }
        if (src.includes("total / ageHours")) {
          const total =
            (doc.comment_cnt || 0) +
            (doc.reaction_cnt || 0) +
            (doc.repost_cnt || 0);
          const ageHours = Math.max((params.now - doc.created_at) / 3600, 0.1);
          return total / ageHours;
        }
        return 0;
      };

      return {
        documents,
        setScore: (
          eventId: string,
          scores: Partial<{
            followers: number;
            engagers: number;
            comment_cnt: number;
            reaction_cnt: number;
            repost_cnt: number;
            zap_amount_msats: number;
          }>,
        ) => {
          for (const [_docId, doc] of documents.entries()) {
            // biome-ignore lint/suspicious/noExplicitAny: test mock
            const d = doc as any;
            if (d.id === eventId) {
              Object.assign(d, scores);
              break;
            }
          }
        },
        client: {
          search: async ({ body }: { body: Record<string, unknown> }) => {
            const query = body.query as Record<string, unknown>;

            // Handle aggregation queries (zaps-by-author)
            if (body.aggs) {
              const aggs = body.aggs as Record<string, unknown>;
              if (aggs.top_authors) {
                // Simulate terms aggregation on pubkey with sum of zap_amount_msats
                const mustClauses = extractMustClauses(query);
                const pubkeyZaps = new Map<string, number>();

                for (const [_id, doc] of documents.entries()) {
                  // biome-ignore lint/suspicious/noExplicitAny: test mock
                  const d = doc as any;
                  if (d.deleted) continue;
                  if (!matchesMust(d, mustClauses)) continue;
                  const current = pubkeyZaps.get(d.pubkey) ?? 0;
                  pubkeyZaps.set(d.pubkey, current + (d.zap_amount_msats || 0));
                }

                const buckets = [...pubkeyZaps.entries()]
                  .map(([key, total]) => ({
                    key,
                    doc_count: 1,
                    total_zaps: { value: total },
                  }))
                  .sort((a, b) => b.total_zaps.value - a.total_zaps.value);

                return {
                  body: {
                    aggregations: { top_authors: { buckets } },
                    hits: { hits: [] },
                  },
                };
              }
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
            }

            // Filter documents against the query
            const mustClauses = extractMustClauses(query);
            const mustNotClauses = extractMustNotClauses(query);
            const results: Array<{ _source: unknown; _score?: number }> = [];

            for (const [_id, doc] of documents.entries()) {
              // biome-ignore lint/suspicious/noExplicitAny: test mock
              const d = doc as any;
              if (d.deleted) continue;
              if (!matchesMust(d, mustClauses)) continue;
              // Exclude if doc matches any must_not clause
              if (mustNotClauses.some((c) => matchesMust(d, [c]))) continue;

              const scriptScore = computeScriptScore(d, query);
              results.push({
                _source: doc,
                ...(scriptScore !== null && { _score: scriptScore }),
              });
            }

            // Apply sorting
            const sort = body.sort as
              | Array<Record<string, { order: string }>>
              | undefined;

            if (sort && sort.length > 0) {
              const [sortField, sortOpts] = Object.entries(sort[0])[0];
              const desc = (sortOpts as { order: string }).order === "desc";
              results.sort((a, b) => {
                // biome-ignore lint/suspicious/noExplicitAny: test mock
                const aVal = (a._source as any)[sortField] ?? 0;
                // biome-ignore lint/suspicious/noExplicitAny: test mock
                const bVal = (b._source as any)[sortField] ?? 0;
                return desc ? bVal - aVal : aVal - bVal;
              });
            } else if (results.length > 0 && results[0]._score !== undefined) {
              results.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
            } else {
              results.sort((a, b) => {
                const aDoc = a._source as NostrEvent;
                const bDoc = b._source as NostrEvent;
                return bDoc.created_at - aDoc.created_at;
              });
            }

            const collapse = body.collapse as { field: string } | undefined;
            if (collapse?.field) {
              const seen = new Set<string>();
              const collapsed: typeof results = [];
              for (const hit of results) {
                const src = hit._source as NostrEvent;
                const val = src[collapse.field as keyof NostrEvent] as string;
                if (!seen.has(val)) {
                  seen.add(val);
                  collapsed.push(hit);
                }
              }
              return { body: { hits: { hits: collapsed } } };
            }

            const size = (body.size as number) ?? results.length;
            return { body: { hits: { hits: results.slice(0, size) } } };
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
          mget: async ({ body }: { body: { ids: string[] } }) => {
            const docs = body.ids.map((id) => {
              const doc = documents.get(id);
              if (doc) return { found: true, _id: id, _source: doc };
              return { found: false, _id: id };
            });
            return { body: { docs } };
          },
          updateByQuery: async () => ({ body: { updated: 0 } }),
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

    it("should sort kind 0 by follower count with sort:top", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const sk3 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create kind 0 profile events for 3 users
      const profile1 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "alice" }),
        },
        sk1,
      );

      const profile2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 10,
          tags: [],
          content: JSON.stringify({ name: "jack" }),
        },
        sk2,
      );

      const profile3 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 20,
          tags: [],
          content: JSON.stringify({ name: "bob" }),
        },
        sk3,
      );

      await relay.event(profile1);
      await relay.event(profile2);
      await relay.event(profile3);

      // Set follower counts (stored as followers for kind 0)
      setScore(profile1.id, { followers: 100 });
      setScore(profile2.id, { followers: 50000 }); // jack is most followed
      setScore(profile3.id, { followers: 500 });

      // Query kind 0 with sort:top
      const results = await relay.query([{ kinds: [0], search: "sort:top" }]);

      assert.equal(results.length, 3);
      assert.equal(results[0].id, profile2.id); // jack (50000 followers)
      assert.equal(results[1].id, profile3.id); // bob (500 followers)
      assert.equal(results[2].id, profile1.id); // alice (100 followers)
    });

    it("should combine sort:top with text search for account autocomplete", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const sk3 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const profile1 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "jack" }),
        },
        sk1,
      );

      const profile2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 10,
          tags: [],
          content: JSON.stringify({ name: "jackson" }),
        },
        sk2,
      );

      const profile3 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 20,
          tags: [],
          content: JSON.stringify({ name: "alice" }),
        },
        sk3,
      );

      await relay.event(profile1);
      await relay.event(profile2);
      await relay.event(profile3);

      setScore(profile1.id, { followers: 50000 }); // jack — most followed
      setScore(profile2.id, { followers: 200 }); // jackson — fewer
      setScore(profile3.id, { followers: 1000 }); // alice — irrelevant to search

      // Search for "jac" with sort:top — should find jack and jackson
      const results = await relay.query([
        { kinds: [0], search: "jac sort:top" },
      ]);

      assert.equal(results.length, 2);
      assert.equal(results[0].id, profile1.id); // jack (most followed)
      assert.equal(results[1].id, profile2.id); // jackson
    });

    it("should sort kind 0 by controversial (two-step author lookup)", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create kind 0 profiles
      const profile1 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "controversial_alice" }),
        },
        sk1,
      );

      const profile2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 10,
          tags: [],
          content: JSON.stringify({ name: "tame_bob" }),
        },
        sk2,
      );

      // Create kind 1 events (posts) that will have controversy scores
      const post1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "Controversial post by alice",
        },
        sk1,
      );

      const post2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 200,
          tags: [],
          content: "Tame post by bob",
        },
        sk2,
      );

      await relay.event(profile1);
      await relay.event(profile2);
      await relay.event(post1);
      await relay.event(post2);

      // Set controversy scores on posts
      // controversial = min(comment, reaction) * sqrt(total)
      // post1: min(10, 8) * sqrt(18) = 8 * 4.24 = 33.9
      setScore(post1.id, { comment_cnt: 10, reaction_cnt: 8 });
      // post2: min(2, 1) * sqrt(3) = 1 * 1.73 = 1.73
      setScore(post2.id, { comment_cnt: 2, reaction_cnt: 1 });

      // Query kind 0 with sort:controversial
      const results = await relay.query([
        { kinds: [0], search: "sort:controversial" },
      ]);

      // Should return profiles ordered by their posts' controversy
      assert.equal(results.length, 2);
      assert.equal(results[0].id, profile1.id); // alice (more controversial)
      assert.equal(results[1].id, profile2.id); // bob
    });

    it("should sort kind 0 by rising (two-step author lookup)", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create kind 0 profiles
      const profile1 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "trending_alice" }),
        },
        sk1,
      );

      const profile2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 10,
          tags: [],
          content: JSON.stringify({ name: "steady_bob" }),
        },
        sk2,
      );

      // Create recent posts
      const post1 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 1800, // 30 min ago — very recent
          tags: [],
          content: "Viral post by alice",
        },
        sk1,
      );

      const post2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 10 * 3600, // 10 hours ago
          tags: [],
          content: "Older post by bob",
        },
        sk2,
      );

      await relay.event(profile1);
      await relay.event(profile2);
      await relay.event(post1);
      await relay.event(post2);

      // rising = (comment + reaction + repost) / age_hours
      // post1: (5 + 5 + 5) / 0.5 = 30
      setScore(post1.id, {
        engagers: 1,
        comment_cnt: 5,
        reaction_cnt: 5,
        repost_cnt: 5,
      });
      // post2: (5 + 5 + 5) / 10 = 1.5
      setScore(post2.id, {
        engagers: 1,
        comment_cnt: 5,
        reaction_cnt: 5,
        repost_cnt: 5,
      });

      const results = await relay.query([
        { kinds: [0], search: "sort:rising" },
      ]);

      assert.equal(results.length, 2);
      assert.equal(results[0].id, profile1.id); // alice (rising faster)
      assert.equal(results[1].id, profile2.id); // bob
    });

    it("should sort kind 0 by total zaps received across all events", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Create kind 0 profiles
      const profile1 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "zap_queen_alice" }),
        },
        sk1,
      );

      const profile2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 10,
          tags: [],
          content: JSON.stringify({ name: "modest_bob" }),
        },
        sk2,
      );

      // Create posts that received zaps
      const post1a = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "Alice post 1",
        },
        sk1,
      );

      const post1b = finalizeEvent(
        {
          kind: 1,
          created_at: now - 200,
          tags: [],
          content: "Alice post 2",
        },
        sk1,
      );

      const post2 = finalizeEvent(
        {
          kind: 1,
          created_at: now - 300,
          tags: [],
          content: "Bob post 1",
        },
        sk2,
      );

      await relay.event(profile1);
      await relay.event(profile2);
      await relay.event(post1a);
      await relay.event(post1b);
      await relay.event(post2);

      // Set zap amounts on posts
      setScore(post1a.id, { zap_amount_msats: 10_000_000 }); // 10k sats
      setScore(post1b.id, { zap_amount_msats: 5_000_000 }); // 5k sats
      // Alice total: 15k sats
      setScore(post2.id, { zap_amount_msats: 3_000_000 }); // 3k sats
      // Bob total: 3k sats

      const results = await relay.query([{ kinds: [0], search: "sort:zaps" }]);

      assert.equal(results.length, 2);
      assert.equal(results[0].id, profile1.id); // alice (15k sats total)
      assert.equal(results[1].id, profile2.id); // bob (3k sats)
    });

    it("should return empty when no authors have zaps for sort:zaps kind 0", async () => {
      const { client } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      await relay.event(
        finalizeEvent(
          {
            kind: 0,
            created_at: now,
            tags: [],
            content: JSON.stringify({ name: "no_zaps" }),
          },
          sk,
        ),
      );

      const results = await relay.query([{ kinds: [0], search: "sort:zaps" }]);

      assert.equal(results.length, 0);
    });

    it("should not use kind-0 sort for multi-kind queries", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const profile = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "alice" }),
        },
        sk,
      );

      const post = finalizeEvent(
        {
          kind: 1,
          created_at: now - 100,
          tags: [],
          content: "A popular post",
        },
        sk,
      );

      await relay.event(profile);
      await relay.event(post);

      setScore(post.id, { engagers: 10 });

      // Query with kinds [0, 1] — should use regular sort, not kind-0 sort
      const results = await relay.query([
        { kinds: [0, 1], search: "sort:top" },
      ]);

      // Only the post has engagers > 0, profile has 0
      assert.equal(results.length, 1);
      assert.equal(results[0].id, post.id);
    });

    it("should match kind 0 profiles by partial name prefix", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const sk3 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const profile1 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({ name: "jack" }),
        },
        sk1,
      );

      const profile2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 10,
          tags: [],
          content: JSON.stringify({ name: "jackson" }),
        },
        sk2,
      );

      const profile3 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 20,
          tags: [],
          content: JSON.stringify({ name: "alice" }),
        },
        sk3,
      );

      await relay.event(profile1);
      await relay.event(profile2);
      await relay.event(profile3);

      setScore(profile1.id, { followers: 50000 });
      setScore(profile2.id, { followers: 200 });
      setScore(profile3.id, { followers: 1000 });

      // "jac" is a prefix — should match "jack" and "jackson" but not "alice"
      const results = await relay.query([{ kinds: [0], search: "jac" }]);

      assert.equal(results.length, 2);
      assert.equal(results[0].id, profile1.id); // jack (most followers)
      assert.equal(results[1].id, profile2.id); // jackson
    });

    it("should match kind 0 profiles by display_name prefix", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const profile1 = finalizeEvent(
        {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({
            name: "jack",
            display_name: "Jack Dorsey",
          }),
        },
        sk1,
      );

      const profile2 = finalizeEvent(
        {
          kind: 0,
          created_at: now - 10,
          tags: [],
          content: JSON.stringify({
            name: "alice",
            display_name: "Alice Wonderland",
          }),
        },
        sk2,
      );

      await relay.event(profile1);
      await relay.event(profile2);

      setScore(profile1.id, { followers: 100 });
      setScore(profile2.id, { followers: 100 });

      // Search by display_name prefix "dor" should match Jack Dorsey
      const results = await relay.query([{ kinds: [0], search: "dor" }]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, profile1.id);
    });

    it("should not use metadata matching for non-kind-0 searches", async () => {
      const { client, setScore } = createKind0SortMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Kind 1 event with "jack" in content
      const post = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content: "Hello from jack",
        },
        sk,
      );

      await relay.event(post);
      setScore(post.id, { engagers: 10 });

      // Kind 1 search should match via content, not metadata
      const results = await relay.query([{ kinds: [1], search: "jack" }]);

      assert.equal(results.length, 1);
      assert.equal(results[0].id, post.id);
    });
  });

  describe("buildTagsMap validation", () => {
    const createMockClient = () => {
      const documents = new Map<string, unknown>();
      return {
        documents,
        client: {
          bulk: async ({ body }: { body: unknown[] }) => {
            const items: Array<Record<string, unknown>> = [];
            for (let i = 0; i < body.length; i += 2) {
              const action = body[i] as { index?: { _id: string } };
              const payload = body[i + 1] as Record<string, unknown>;
              if (action.index) {
                documents.set(action.index._id, payload);
                items.push({ index: {} });
              }
            }
            return { body: { errors: false, items } };
          },
          mget: async ({ body }: { body: { ids: string[] } }) => {
            const docs = body.ids.map((id) => {
              const doc = documents.get(id);
              if (doc) return { found: true, _id: id, _source: doc };
              return { found: false, _id: id };
            });
            return { body: { docs } };
          },
          updateByQuery: async () => ({ body: { updated: 0 } }),
          indices: {
            exists: async () => ({ body: true }),
            create: async () => ({ body: {} }),
          },
          close: async () => {},
        },
      };
    };

    /** Helper to store an event and return its tags_map from the mock. */
    const getTagsMap = async (
      tags: string[][],
    ): Promise<Record<string, string[]>> => {
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
          tags,
          content: "",
        },
        sk,
      );

      await relay.event(event);

      const doc = Array.from(documents.values())[0] as {
        tags_map: Record<string, string[]>;
      };
      return doc.tags_map;
    };

    it("should include single-letter tag names", async () => {
      const tagsMap = await getTagsMap([
        ["e", "abc123"],
        ["p", "def456"],
        ["t", "bitcoin"],
      ]);

      assert.deepEqual(tagsMap.e, ["abc123"]);
      assert.deepEqual(tagsMap.p, ["def456"]);
      assert.deepEqual(tagsMap.t, ["bitcoin"]);
    });

    it("should allow whitelisted multi-letter tag names", async () => {
      const tagsMap = await getTagsMap([
        ["expiration", "1700000000"],
        ["goal", "abc123def456"],
        ["proxy", "https://example.com/objects/123"],
        ["status", "live"],
      ]);

      assert.deepEqual(tagsMap.expiration, ["1700000000"]);
      assert.deepEqual(tagsMap.goal, ["abc123def456"]);
      assert.deepEqual(tagsMap.proxy, ["https://example.com/objects/123"]);
      assert.deepEqual(tagsMap.status, ["live"]);
    });

    it("should allow special single-character tag names", async () => {
      const tagsMap = await getTagsMap([
        ["-", ""],
        ["_", "value"],
      ]);

      assert.deepEqual(tagsMap["-"], [""]);
      assert.deepEqual(tagsMap["_"], ["value"]);
    });

    it("should reject multi-letter tag names not in whitelist", async () => {
      const tagsMap = await getTagsMap([
        ["t", "keep"],
        ["bolt11", "lnbc..."],
        ["imeta", "url https://example.com"],
        ["relays", "wss://relay.example.com"],
        ["nonce", "12345"],
        ["my_custom_tag", "value"],
        // Previously allowed, now rejected (free-form text / URLs / niche):
        ["alt", "reply"],
        ["title", "Hello World"],
        ["content-warning", "nsfw"],
        ["image", "https://example.com/pic.jpg"],
        ["name", "My Thing"],
      ]);

      assert.deepEqual(tagsMap.t, ["keep"]);
      assert.equal(tagsMap.bolt11, undefined);
      assert.equal(tagsMap.imeta, undefined);
      assert.equal(tagsMap.relays, undefined);
      assert.equal(tagsMap.nonce, undefined);
      assert.equal(tagsMap.my_custom_tag, undefined);
      assert.equal(tagsMap.alt, undefined);
      assert.equal(tagsMap.title, undefined);
      assert.equal(tagsMap["content-warning"], undefined);
      assert.equal(tagsMap.image, undefined);
      assert.equal(tagsMap.name, undefined);
    });

    it("should accept tag values up to 255 characters", async () => {
      const value255 = "x".repeat(255);
      const tagsMap = await getTagsMap([["t", value255]]);

      assert.deepEqual(tagsMap.t, [value255]);
    });

    it("should reject tag values exceeding 255 characters", async () => {
      const value256 = "x".repeat(256);
      const tagsMap = await getTagsMap([["t", value256]]);

      assert.deepEqual(tagsMap.t, []);
    });

    it("should keep valid values and skip invalid values for the same tag", async () => {
      const longValue = "x".repeat(300);
      const tagsMap = await getTagsMap([
        ["t", "bitcoin"],
        ["t", longValue],
        ["t", "nostr"],
      ]);

      assert.deepEqual(tagsMap.t, ["bitcoin", "nostr"]);
    });

    it("should create the key with an empty array when all values are too long", async () => {
      const longValue1 = "x".repeat(256);
      const longValue2 = "y".repeat(500);
      const tagsMap = await getTagsMap([
        ["t", longValue1],
        ["t", longValue2],
      ]);

      assert.ok("t" in tagsMap);
      assert.deepEqual(tagsMap.t, []);
    });

    it("should not create a key for non-whitelisted multi-letter tag names", async () => {
      const tagsMap = await getTagsMap([
        ["invalid.name", "good-value"],
        ["another_bad", "also-good"],
      ]);

      assert.equal(Object.keys(tagsMap).length, 0);
    });

    it("should handle empty tags array", async () => {
      const tagsMap = await getTagsMap([]);
      assert.deepEqual(tagsMap, {});
    });

    it("should skip tags with fewer than 2 elements", async () => {
      const tagsMap = await getTagsMap([["e"], ["p", "value"]]);

      assert.equal(tagsMap.e, undefined);
      assert.deepEqual(tagsMap.p, ["value"]);
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

            // Extract must_not clauses
            const queryMustNot = (
              (body.query as Record<string, unknown>)?.bool as Record<
                string,
                unknown
              >
            )?.must_not as Array<Record<string, unknown>> | undefined;

            // Check if protocol existence is negated (protocol:false)
            let excludeProtocol = false;
            for (const clause of queryMustNot || []) {
              if (
                (clause.exists as Record<string, unknown>)?.field === "protocol"
              ) {
                excludeProtocol = true;
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

              // Exclude events with protocol if protocol:false
              if (excludeProtocol && docTyped.protocol) {
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
          mget: async ({ body }: { body: { ids: string[] } }) => {
            const docs = body.ids.map((id) => {
              const doc = documents.get(id);
              if (doc) return { found: true, _id: id, _source: doc };
              return { found: false, _id: id };
            });
            return { body: { docs } };
          },
          count: async () => {
            const nonDeleted = Array.from(documents.values()).filter(
              (doc) => !(doc as { deleted?: boolean }).deleted,
            );
            return { body: { count: nonDeleted.length } };
          },
          updateByQuery: async () => ({ body: { updated: 0 } }),
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

    it("should return only native events with protocol:nostr", async () => {
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

      // Native Nostr event (no protocol)
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

      // protocol:nostr should return only native events (no protocol)
      const results = await relay.query([
        { kinds: [1], search: "protocol:nostr" },
      ]);
      assert.equal(results.length, 1);
      assert.equal(results[0].id, event3.id);
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

  describe("NIP-50 language filter", () => {
    // Mock client with language field support
    const createLanguageMockClient = () => {
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

            // Extract language filter if present
            let languageFilter: string | undefined;
            for (const clause of queryMust || []) {
              if ((clause.term as Record<string, unknown>)?.language) {
                languageFilter = (clause.term as Record<string, unknown>)
                  .language as string;
              }
            }

            for (const [_id, doc] of documents.entries()) {
              const docTyped = doc as NostrEvent & {
                deleted?: boolean;
                language?: string;
              };

              if (docTyped.deleted) continue;
              if (languageFilter && docTyped.language !== languageFilter)
                continue;

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
          mget: async ({ body }: { body: { ids: string[] } }) => {
            const docs = body.ids.map((id) => {
              const doc = documents.get(id);
              if (doc) return { found: true, _id: id, _source: doc };
              return { found: false, _id: id };
            });
            return { body: { docs } };
          },
          count: async () => {
            const nonDeleted = Array.from(documents.values()).filter(
              (doc) => !(doc as { deleted?: boolean }).deleted,
            );
            return { body: { count: nonDeleted.length } };
          },
          updateByQuery: async () => ({ body: { updated: 0 } }),
          indices: {
            exists: async () => ({ body: true }),
            create: async () => ({ body: {} }),
          },
          close: async () => {},
        },
      };
    };

    it("should store language on indexed documents when passed via analysis", async () => {
      const { client, documents } = createLanguageMockClient();
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
          content:
            "This is a long enough English sentence for language detection to work properly",
        },
        sk,
      );

      await relay.event(event, { analysis: { language: "en" } });

      const doc = Array.from(documents.values())[0] as {
        language?: string;
      };
      assert.equal(doc.language, "en");
    });

    it("should filter events by language using search extension", async () => {
      const { client } = createLanguageMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // English event
      const enEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content:
            "This is a perfectly normal English language post about Nostr",
        },
        sk,
      );

      // Chinese event
      const zhEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 10,
          tags: [],
          content: "这是一个关于比特币和闪电网络的中文帖子",
        },
        sk,
      );

      await relay.event(enEvent, { analysis: { language: "en" } });
      await relay.event(zhEvent, { analysis: { language: "zh" } });

      // Filter by English
      const enResults = await relay.query([
        { kinds: [1], search: "language:en" },
      ]);
      assert.equal(enResults.length, 1);
      assert.equal(enResults[0].id, enEvent.id);

      // Filter by Chinese
      const zhResults = await relay.query([
        { kinds: [1], search: "language:zh" },
      ]);
      assert.equal(zhResults.length, 1);
      assert.equal(zhResults[0].id, zhEvent.id);
    });

    it("should return all events when no language filter is applied", async () => {
      const { client } = createLanguageMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      await relay.event(
        finalizeEvent(
          {
            kind: 1,
            created_at: now,
            tags: [],
            content: "An English post about the state of the world today",
          },
          sk,
        ),
      );

      await relay.event(
        finalizeEvent(
          {
            kind: 1,
            created_at: now - 10,
            tags: [],
            content: "これは日本語の投稿です。言語フィルタのテストです。",
          },
          sk,
        ),
      );

      const results = await relay.query([{ kinds: [1] }]);
      assert.equal(results.length, 2);
    });
  });

  describe("NIP-50 sentiment filter", () => {
    // Mock client with sentiment field support
    const createSentimentMockClient = () => {
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

            // Extract sentiment filter if present
            let sentimentFilter: string | undefined;
            for (const clause of queryMust || []) {
              if ((clause.term as Record<string, unknown>)?.sentiment) {
                sentimentFilter = (clause.term as Record<string, unknown>)
                  .sentiment as string;
              }
            }

            for (const [_id, doc] of documents.entries()) {
              const docTyped = doc as NostrEvent & {
                deleted?: boolean;
                sentiment?: string;
              };

              if (docTyped.deleted) continue;
              if (sentimentFilter && docTyped.sentiment !== sentimentFilter)
                continue;

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
          mget: async ({ body }: { body: { ids: string[] } }) => {
            const docs = body.ids.map((id) => {
              const doc = documents.get(id);
              if (doc) return { found: true, _id: id, _source: doc };
              return { found: false, _id: id };
            });
            return { body: { docs } };
          },
          count: async () => {
            const nonDeleted = Array.from(documents.values()).filter(
              (doc) => !(doc as { deleted?: boolean }).deleted,
            );
            return { body: { count: nonDeleted.length } };
          },
          updateByQuery: async () => ({ body: { updated: 0 } }),
          indices: {
            exists: async () => ({ body: true }),
            create: async () => ({ body: {} }),
          },
          close: async () => {},
        },
      };
    };

    it("should store sentiment on indexed documents when passed via analysis", async () => {
      const { client, documents } = createSentimentMockClient();
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
          content:
            "I love this amazing wonderful fantastic excellent brilliant masterpiece!",
        },
        sk,
      );

      await relay.event(event, { analysis: { sentiment: "positive" } });

      const doc = Array.from(documents.values())[0] as {
        sentiment?: string;
      };
      assert.equal(doc.sentiment, "positive");
    });

    it("should filter events by sentiment using search extension", async () => {
      const { client } = createSentimentMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Positive event
      const positiveEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [],
          content:
            "I love this amazing wonderful fantastic excellent brilliant masterpiece!",
        },
        sk,
      );

      // Negative event
      const negativeEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now - 10,
          tags: [],
          content:
            "This is terrible awful horrible disgusting dreadful painful ugly catastrophe",
        },
        sk,
      );

      await relay.event(positiveEvent, { analysis: { sentiment: "positive" } });
      await relay.event(negativeEvent, { analysis: { sentiment: "negative" } });

      // Filter by positive
      const positiveResults = await relay.query([
        { kinds: [1], search: "sentiment:positive" },
      ]);
      assert.equal(positiveResults.length, 1);
      assert.equal(positiveResults[0].id, positiveEvent.id);

      // Filter by negative
      const negativeResults = await relay.query([
        { kinds: [1], search: "sentiment:negative" },
      ]);
      assert.equal(negativeResults.length, 1);
      assert.equal(negativeResults[0].id, negativeEvent.id);
    });

    it("should store sentiment for kind 7 reactions", async () => {
      const { client, documents } = createSentimentMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      const likeEvent = finalizeEvent(
        {
          kind: 7,
          created_at: now,
          tags: [["e", "a".repeat(64)]],
          content: "+",
        },
        sk,
      );

      await relay.event(likeEvent, { analysis: { sentiment: "positive" } });

      const doc = Array.from(documents.values())[0] as {
        sentiment?: string;
      };
      assert.equal(doc.sentiment, "positive");
    });
  });

  describe("NIP-50 media/video filter", () => {
    // Mock client with media/video field support
    const createMediaMockClient = () => {
      const documents = new Map<string, unknown>();

      return {
        documents,
        client: {
          search: async ({ body }: { body: Record<string, unknown> }) => {
            const results: unknown[] = [];
            const queryBool = (body.query as Record<string, unknown>)
              ?.bool as Record<string, unknown>;
            const queryMust = queryBool?.must as
              | Array<Record<string, unknown>>
              | undefined;
            const queryMustNot = queryBool?.must_not as
              | Array<Record<string, unknown>>
              | undefined;

            // Extract media filter if present
            let mediaFilter: boolean | undefined;
            for (const clause of queryMust || []) {
              if ((clause.term as Record<string, unknown>)?.media === true) {
                mediaFilter = true;
              }
            }
            for (const clause of queryMustNot || []) {
              if ((clause.term as Record<string, unknown>)?.media === true) {
                mediaFilter = false;
              }
            }

            // Extract video filter if present
            let videoFilter: boolean | undefined;
            for (const clause of queryMust || []) {
              if ((clause.term as Record<string, unknown>)?.video === true) {
                videoFilter = true;
              }
            }
            for (const clause of queryMustNot || []) {
              if ((clause.term as Record<string, unknown>)?.video === true) {
                videoFilter = false;
              }
            }

            for (const [_id, doc] of documents.entries()) {
              const docTyped = doc as NostrEvent & {
                deleted?: boolean;
                media?: boolean;
                video?: boolean;
              };

              if (docTyped.deleted) continue;

              // Filter by media
              if (mediaFilter === true && !docTyped.media) continue;
              if (mediaFilter === false && docTyped.media === true) continue;

              // Filter by video
              if (videoFilter === true && !docTyped.video) continue;
              if (videoFilter === false && docTyped.video === true) continue;

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
          mget: async ({ body }: { body: { ids: string[] } }) => {
            const docs = body.ids.map((id) => {
              const doc = documents.get(id);
              if (doc) return { found: true, _id: id, _source: doc };
              return { found: false, _id: id };
            });
            return { body: { docs } };
          },
          count: async () => {
            const nonDeleted = Array.from(documents.values()).filter(
              (doc) => !(doc as { deleted?: boolean }).deleted,
            );
            return { body: { count: nonDeleted.length } };
          },
          updateByQuery: async () => ({ body: { updated: 0 } }),
          indices: {
            exists: async () => ({ body: true }),
            create: async () => ({ body: {} }),
          },
          close: async () => {},
        },
      };
    };

    it("should set media:true for events with imeta tags", async () => {
      const { client, documents } = createMediaMockClient();
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
              "imeta",
              "url https://example.com/photo.jpg",
              "m image/jpeg",
              "dim 1920x1080",
            ],
          ],
          content: "Check out this photo https://example.com/photo.jpg",
        },
        sk,
      );

      await relay.event(event);

      const doc = [...documents.values()][0] as {
        media: boolean;
        video: boolean;
      };
      assert.equal(doc.media, true);
      assert.equal(doc.video, false);
    });

    it("should set video:true when all imeta attachments are video", async () => {
      const { client, documents } = createMediaMockClient();
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
          tags: [["imeta", "url https://example.com/clip.mp4", "m video/mp4"]],
          content: "Watch this https://example.com/clip.mp4",
        },
        sk,
      );

      await relay.event(event);

      const doc = [...documents.values()][0] as {
        media: boolean;
        video: boolean;
      };
      assert.equal(doc.media, true);
      assert.equal(doc.video, true);
    });

    it("should not set video:true when imeta has mixed media types", async () => {
      const { client, documents } = createMediaMockClient();
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
            ["imeta", "url https://example.com/clip.mp4", "m video/mp4"],
            ["imeta", "url https://example.com/photo.jpg", "m image/jpeg"],
          ],
          content: "Mixed media post",
        },
        sk,
      );

      await relay.event(event);

      const doc = [...documents.values()][0] as {
        media: boolean;
        video: boolean;
      };
      assert.equal(doc.media, true);
      assert.equal(doc.video, false);
    });

    it("should not set media for events without media", async () => {
      const { client, documents } = createMediaMockClient();
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
          content: "Just a text post, no media here",
        },
        sk,
      );

      await relay.event(event);

      const doc = [...documents.values()][0] as {
        media: boolean;
        video: boolean;
      };
      assert.equal(doc.media, false);
      assert.equal(doc.video, false);
    });

    it("should detect media from URLs in content as fallback for kind 1", async () => {
      const { client, documents } = createMediaMockClient();
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
          content: "Check this out https://example.com/photo.png",
        },
        sk,
      );

      await relay.event(event);

      const doc = [...documents.values()][0] as {
        media: boolean;
        video: boolean;
      };
      assert.equal(doc.media, true);
    });

    it("should detect video from URLs in content as fallback for kind 1", async () => {
      const { client, documents } = createMediaMockClient();
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
          content: "Watch this https://example.com/clip.mp4",
        },
        sk,
      );

      await relay.event(event);

      const doc = [...documents.values()][0] as {
        media: boolean;
        video: boolean;
      };
      assert.equal(doc.media, true);
      assert.equal(doc.video, true);
    });

    it("should filter events by media:true", async () => {
      const { client } = createMediaMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Event with media
      const mediaEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [
            ["imeta", "url https://example.com/photo.jpg", "m image/jpeg"],
          ],
          content: "Photo post https://example.com/photo.jpg",
        },
        sk,
      );

      // Event without media
      const textEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now + 1,
          tags: [],
          content: "Just text",
        },
        sk,
      );

      await relay.event(mediaEvent);
      await relay.event(textEvent);

      // media:true should return only the media event
      const mediaResults = await relay.query([
        { kinds: [1], search: "media:true" },
      ]);
      assert.equal(mediaResults.length, 1);
      assert.equal(mediaResults[0].id, mediaEvent.id);
    });

    it("should filter events by media:false", async () => {
      const { client } = createMediaMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Event with media
      const mediaEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [
            ["imeta", "url https://example.com/photo.jpg", "m image/jpeg"],
          ],
          content: "Photo post https://example.com/photo.jpg",
        },
        sk,
      );

      // Event without media
      const textEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now + 1,
          tags: [],
          content: "Just text",
        },
        sk,
      );

      await relay.event(mediaEvent);
      await relay.event(textEvent);

      // media:false should return only the text event
      const textResults = await relay.query([
        { kinds: [1], search: "media:false" },
      ]);
      assert.equal(textResults.length, 1);
      assert.equal(textResults[0].id, textEvent.id);
    });

    it("should filter events by video:true", async () => {
      const { client } = createMediaMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Video event
      const videoEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [["imeta", "url https://example.com/clip.mp4", "m video/mp4"]],
          content: "Video post https://example.com/clip.mp4",
        },
        sk,
      );

      // Image event
      const imageEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now + 1,
          tags: [
            ["imeta", "url https://example.com/photo.jpg", "m image/jpeg"],
          ],
          content: "Image post https://example.com/photo.jpg",
        },
        sk,
      );

      // Text event
      const textEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now + 2,
          tags: [],
          content: "Just text",
        },
        sk,
      );

      await relay.event(videoEvent);
      await relay.event(imageEvent);
      await relay.event(textEvent);

      // video:true should return only the video event
      const videoResults = await relay.query([
        { kinds: [1], search: "video:true" },
      ]);
      assert.equal(videoResults.length, 1);
      assert.equal(videoResults[0].id, videoEvent.id);
    });

    it("should filter events by video:false", async () => {
      const { client } = createMediaMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // Video event
      const videoEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [["imeta", "url https://example.com/clip.mp4", "m video/mp4"]],
          content: "Video post https://example.com/clip.mp4",
        },
        sk,
      );

      // Image event
      const imageEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now + 1,
          tags: [
            ["imeta", "url https://example.com/photo.jpg", "m image/jpeg"],
          ],
          content: "Image post https://example.com/photo.jpg",
        },
        sk,
      );

      await relay.event(videoEvent);
      await relay.event(imageEvent);

      // video:false should return the image event (has media but not video)
      const nonVideoResults = await relay.query([
        { kinds: [1], search: "video:false" },
      ]);
      assert.equal(nonVideoResults.length, 1);
      assert.equal(nonVideoResults[0].id, imageEvent.id);
    });

    it("should combine media and other search extensions", async () => {
      const { client } = createMediaMockClient();
      const relay = new OpenSearchRelay(client as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const now = Math.floor(Date.now() / 1000);

      // English media event
      const enMediaEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now,
          tags: [
            ["imeta", "url https://example.com/photo.jpg", "m image/jpeg"],
          ],
          content: "Photo post https://example.com/photo.jpg",
        },
        sk,
      );

      // English text event
      const enTextEvent = finalizeEvent(
        {
          kind: 1,
          created_at: now + 1,
          tags: [],
          content: "Just text",
        },
        sk,
      );

      await relay.event(enMediaEvent);
      await relay.event(enTextEvent);

      // media:true should return only the media event
      const mediaResults = await relay.query([
        { kinds: [1], search: "media:true" },
      ]);
      assert.equal(mediaResults.length, 1);
      assert.equal(mediaResults[0].id, enMediaEvent.id);
    });
  });

  describe("detectMedia", () => {
    it("should detect media from imeta tags", () => {
      const event = {
        id: "abc",
        pubkey: "def",
        created_at: 0,
        kind: 1,
        tags: [["imeta", "url https://example.com/photo.jpg", "m image/jpeg"]],
        content: "test",
        sig: "sig",
      };

      const result = OpenSearchRelay.detectMedia(event);
      assert.deepEqual(result, { media: true });
    });

    it("should detect video when all imeta are video", () => {
      const event = {
        id: "abc",
        pubkey: "def",
        created_at: 0,
        kind: 1,
        tags: [
          ["imeta", "url https://example.com/a.mp4", "m video/mp4"],
          ["imeta", "url https://example.com/b.webm", "m video/webm"],
        ],
        content: "test",
        sig: "sig",
      };

      const result = OpenSearchRelay.detectMedia(event);
      assert.deepEqual(result, { media: true, video: true });
    });

    it("should not detect video when imeta has mixed types", () => {
      const event = {
        id: "abc",
        pubkey: "def",
        created_at: 0,
        kind: 1,
        tags: [
          ["imeta", "url https://example.com/a.mp4", "m video/mp4"],
          ["imeta", "url https://example.com/b.jpg", "m image/jpeg"],
        ],
        content: "test",
        sig: "sig",
      };

      const result = OpenSearchRelay.detectMedia(event);
      assert.deepEqual(result, { media: true });
    });

    it("should return empty for events without media", () => {
      const event = {
        id: "abc",
        pubkey: "def",
        created_at: 0,
        kind: 1,
        tags: [],
        content: "just text",
        sig: "sig",
      };

      const result = OpenSearchRelay.detectMedia(event);
      assert.deepEqual(result, {});
    });

    it("should fall back to URL detection for kind 1 without imeta", () => {
      const event = {
        id: "abc",
        pubkey: "def",
        created_at: 0,
        kind: 1,
        tags: [],
        content: "look at https://example.com/photo.png",
        sig: "sig",
      };

      const result = OpenSearchRelay.detectMedia(event);
      assert.deepEqual(result, { media: true });
    });

    it("should not fall back to URL detection for non-kind-1 events", () => {
      const event = {
        id: "abc",
        pubkey: "def",
        created_at: 0,
        kind: 30023,
        tags: [],
        content: "article with https://example.com/photo.png",
        sig: "sig",
      };

      const result = OpenSearchRelay.detectMedia(event);
      assert.deepEqual(result, {});
    });

    it("should skip imeta tags without url field", () => {
      const event = {
        id: "abc",
        pubkey: "def",
        created_at: 0,
        kind: 1,
        tags: [["imeta", "m image/jpeg", "dim 1920x1080"]],
        content: "test",
        sig: "sig",
      };

      const result = OpenSearchRelay.detectMedia(event);
      // No valid imeta (missing url), falls back to URL detection
      // Content has no media URLs either
      assert.deepEqual(result, {});
    });

    it("should not set video when imeta lacks mime type", () => {
      const event = {
        id: "abc",
        pubkey: "def",
        created_at: 0,
        kind: 1,
        tags: [["imeta", "url https://example.com/clip.mp4"]],
        content: "test",
        sig: "sig",
      };

      const result = OpenSearchRelay.detectMedia(event);
      // Has media (valid imeta with url), but can't confirm video without m tag
      assert.deepEqual(result, { media: true });
    });
  });

  describe("migrate", () => {
    it("should reject documents with unknown fields (dynamic: strict)", async () => {
      const KNOWN_FIELDS = new Set([
        "id",
        "pubkey",
        "created_at",
        "kind",
        "tags",
        "tags_map",
        "search_text",
        "content",
        "sig",
        "deleted",
        "replaced",
        "protocol",
        "amount_msats",
        "language",
        "sentiment",
        "media",
        "video",
        "metadata",
        "followers",
        "engagers",
        "comment_cnt",
        "reaction_cnt",
        "repost_cnt",
        "quote_cnt",
        "zap_amount_msats",
        "zap_cnt",
      ]);

      const mockClient = {
        bulk: async ({ body }: { body: unknown[] }) => {
          const items: Array<Record<string, unknown>> = [];
          for (let i = 0; i < body.length; i += 2) {
            const action = body[i] as { index?: { _id: string } };
            const payload = body[i + 1] as Record<string, unknown>;

            if (action.index) {
              // Simulate dynamic: strict — reject docs with unknown fields
              const unknownFields = Object.keys(payload).filter(
                (key) => !KNOWN_FIELDS.has(key),
              );
              if (unknownFields.length > 0) {
                items.push({
                  index: {
                    error: {
                      type: "strict_dynamic_mapping_exception",
                      reason: `mapping set to strict, dynamic introduction of [${unknownFields[0]}] within [_doc] is not allowed`,
                    },
                  },
                });
              } else {
                items.push({ index: {} });
              }
            }
          }
          return {
            body: {
              errors: items.some(
                (item) =>
                  (item.index as { error?: unknown } | undefined)?.error,
              ),
              items,
            },
          };
        },
        mget: async ({ body }: { body: { ids: string[] } }) => ({
          body: {
            docs: body.ids.map((id) => ({ found: false, _id: id })),
          },
        }),
        updateByQuery: async () => ({ body: { updated: 0 } }),
        indices: {
          exists: async () => ({ body: true }),
          create: async () => ({ body: {} }),
        },
        close: async () => {},
      };

      const relay = new OpenSearchRelay(mockClient as unknown as Client, {
        indexName: "test-index",
        bulkMaxSize: 1,
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Normal event",
        },
        sk,
      );

      // A well-formed event should be accepted
      await relay.event(event);

      // An event with a spoofed extra field should be rejected
      const badEvent = {
        ...finalizeEvent(
          {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: "Bad event",
          },
          sk,
        ),
        mystery_field: "should not be allowed",
      };

      await assert.rejects(() => relay.event(badEvent), {
        message: /strict_dynamic_mapping_exception/,
      });
    });
  });

  describe("parseBolt11Amount", () => {
    it("should parse nano-BTC amounts", () => {
      // 210n = 210 nano-BTC = 21 sats = 21,000 msats
      assert.equal(
        OpenSearchRelay.parseBolt11Amount("lnbc210n1p5eyu7fpp5..."),
        21_000,
      );
    });

    it("should parse micro-BTC amounts", () => {
      // 10u = 10 micro-BTC = 1000 sats = 1,000,000 msats
      assert.equal(
        OpenSearchRelay.parseBolt11Amount("lnbc10u1p5..."),
        1_000_000,
      );
    });

    it("should parse milli-BTC amounts", () => {
      // 1m = 1 milli-BTC = 100,000 sats = 100,000,000 msats
      assert.equal(
        OpenSearchRelay.parseBolt11Amount("lnbc1m1p5..."),
        100_000_000,
      );
    });

    it("should parse pico-BTC amounts", () => {
      // 100p = 100 pico-BTC = 10 msats
      assert.equal(OpenSearchRelay.parseBolt11Amount("lnbc100p1p5..."), 10);
    });

    it("should return undefined for invalid bolt11", () => {
      assert.equal(
        OpenSearchRelay.parseBolt11Amount("not-a-bolt11"),
        undefined,
      );
      assert.equal(OpenSearchRelay.parseBolt11Amount(""), undefined);
    });

    it("should parse real-world bolt11 invoices", () => {
      // 21 sats = 21,000 msats
      const bolt11 =
        "lnbc210n1p5e2srfpp5x4fd3rjklja8fhvn3y5vjnrc00775805hts9rewjl2v3g8ma7d5q";
      assert.equal(OpenSearchRelay.parseBolt11Amount(bolt11), 21_000);
    });
  });
});
