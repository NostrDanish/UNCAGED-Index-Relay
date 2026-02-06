import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import type { Client } from "@opensearch-project/opensearch";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { EventStorage } from "./storage.ts";

describe("EventStorage", () => {
  let mockClient: Client;
  let storage: EventStorage;
  let indexedDocs: unknown[];
  let deletedIds: string[];
  let updatedDocs: unknown[];

  beforeEach(() => {
    indexedDocs = [];
    deletedIds = [];
    updatedDocs = [];

    mockClient = {
      index: async (params: unknown) => {
        indexedDocs.push(params);
        return { body: {} };
      },
      search: async () => ({
        body: {
          hits: {
            hits: [],
          },
        },
      }),
      delete: async (params: unknown) => {
        const p = params as { id: string };
        deletedIds.push(p.id);
        return { body: {} };
      },
      get: async () => ({
        body: {
          _source: null,
        },
      }),
      update: async (params: unknown) => {
        updatedDocs.push(params);
        return { body: {} };
      },
      updateByQuery: async () => ({
        body: {
          updated: 0,
        },
      }),
    } as unknown as Client;

    storage = new EventStorage(mockClient, "test-index");
  });

  describe("storeEvent", () => {
    it("should store a valid event", async () => {
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Hello, Nostr!",
        },
        sk,
      );

      const result = await storage.storeEvent(event);

      assert.equal(result, true);
      assert.equal(indexedDocs.length, 1);

      const indexed = indexedDocs[0] as {
        id: string;
        body: { deleted: boolean };
      };
      assert.equal(indexed.id, event.id);
      assert.equal(indexed.body.deleted, false);
    });

    it("should build tags_map from tags", async () => {
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["e", "event123"],
            ["p", "pubkey123"],
            ["t", "nostr", "bitcoin"],
          ],
          content: "Tagged event",
        },
        sk,
      );

      await storage.storeEvent(event);

      const indexed = indexedDocs[0] as {
        body: { tags_map: Record<string, string[]> };
      };
      assert.deepEqual(indexed.body.tags_map.e, ["event123"]);
      assert.deepEqual(indexed.body.tags_map.p, ["pubkey123"]);
      assert.deepEqual(indexed.body.tags_map.t, ["nostr", "bitcoin"]);
    });

    it("should extract d tag for parameterized replaceable events", async () => {
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 30000,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["d", "article-1"]],
          content: "Article content",
        },
        sk,
      );

      await storage.storeEvent(event);

      const indexed = indexedDocs[0] as { body: { d_tag: string } };
      assert.equal(indexed.body.d_tag, "article-1");
    });

    it("should reject parameterized replaceable event without d tag", async () => {
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 30000,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Missing d tag",
        },
        sk,
      );

      await assert.rejects(
        () => storage.storeEvent(event),
        /Parameterized replaceable event must have a d tag/,
      );
    });

    it("should replace older replaceable event (kind 0)", async () => {
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);

      const olderEvent = {
        id: "old123",
        pubkey: pk,
        created_at: 1000000000,
        kind: 0,
        tags: [],
        content: "{}",
        sig: "oldsig",
        tags_map: {},
        deleted: false,
      };

      mockClient.search = (async () => ({
        body: {
          hits: {
            hits: [
              {
                _id: "old123",
                _source: olderEvent,
              },
            ],
          },
        },
      })) as never;

      const newerEvent = finalizeEvent(
        {
          kind: 0,
          created_at: 2000000000,
          tags: [],
          content: JSON.stringify({ name: "Alice" }),
        },
        sk,
      );

      const result = await storage.storeEvent(newerEvent);

      assert.equal(result, true);
      assert.equal(deletedIds.length, 1);
      assert.equal(deletedIds[0], "old123");
      assert.equal(indexedDocs.length, 1);
    });

    it("should reject older replaceable event when newer exists", async () => {
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);

      const newerEvent = {
        id: "new123",
        pubkey: pk,
        created_at: 2000000000,
        kind: 0,
        tags: [],
        content: "{}",
        sig: "newsig",
        tags_map: {},
        deleted: false,
      };

      mockClient.search = (async () => ({
        body: {
          hits: {
            hits: [
              {
                _id: "new123",
                _source: newerEvent,
              },
            ],
          },
        },
      })) as never;

      const olderEvent = finalizeEvent(
        {
          kind: 0,
          created_at: 1000000000,
          tags: [],
          content: "{}",
        },
        sk,
      );

      const result = await storage.storeEvent(olderEvent);

      assert.equal(result, false);
      assert.equal(indexedDocs.length, 0);
    });
  });

  describe("deleteEvents", () => {
    it("should only accept kind 5 deletion events", async () => {
      const sk = generateSecretKey();
      const notDeletionEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["e", "event123"]],
          content: "",
        },
        sk,
      );

      await assert.rejects(
        () => storage.deleteEvents(notDeletionEvent),
        /Deletion event must be kind 5/,
      );
    });

    it("should delete event by ID when pubkeys match", async () => {
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);

      const targetEvent = {
        id: "target123",
        pubkey: pk,
        created_at: 1000000000,
        kind: 1,
        tags: [],
        content: "To be deleted",
        sig: "sig",
        tags_map: {},
        deleted: false,
      };

      mockClient.get = (async () => ({
        body: {
          _source: targetEvent,
        },
      })) as never;

      const deletionEvent = finalizeEvent(
        {
          kind: 5,
          created_at: 2000000000,
          tags: [["e", "target123"]],
          content: "",
        },
        sk,
      );

      const deletedCount = await storage.deleteEvents(deletionEvent);

      assert.equal(deletedCount, 1);
      assert.equal(updatedDocs.length, 1);
      const updated = updatedDocs[0] as {
        id: string;
        body: { doc: { deleted: boolean } };
      };
      assert.equal(updated.id, "target123");
      assert.equal(updated.body.doc.deleted, true);
    });

    it("should not delete event when pubkeys don't match", async () => {
      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const pk2 = getPublicKey(sk2);

      const targetEvent = {
        id: "target123",
        pubkey: pk2, // Different pubkey
        created_at: 1000000000,
        kind: 1,
        tags: [],
        content: "Protected",
        sig: "sig",
        tags_map: {},
        deleted: false,
      };

      mockClient.get = (async () => ({
        body: {
          _source: targetEvent,
        },
      })) as never;

      const deletionEvent = finalizeEvent(
        {
          kind: 5,
          created_at: 2000000000,
          tags: [["e", "target123"]],
          content: "",
        },
        sk1,
      );

      const deletedCount = await storage.deleteEvents(deletionEvent);

      assert.equal(deletedCount, 0);
      assert.equal(updatedDocs.length, 0);
    });

    it("should handle event not found gracefully", async () => {
      const sk = generateSecretKey();

      mockClient.get = (async () => {
        const error = new Error("Not found") as Error & {
          meta?: { statusCode: number };
        };
        error.meta = { statusCode: 404 };
        throw error;
      }) as never;

      const deletionEvent = finalizeEvent(
        {
          kind: 5,
          created_at: 2000000000,
          tags: [["e", "nonexistent"]],
          content: "",
        },
        sk,
      );

      const deletedCount = await storage.deleteEvents(deletionEvent);

      assert.equal(deletedCount, 0);
    });

    it("should delete by coordinate when pubkeys match", async () => {
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);

      let updateByQueryCalled = false;
      mockClient.updateByQuery = (async () => {
        updateByQueryCalled = true;
        return {
          body: {
            updated: 2,
          },
        };
      }) as never;

      const deletionEvent = finalizeEvent(
        {
          kind: 5,
          created_at: 2000000000,
          tags: [["a", `30000:${pk}:article-1`]],
          content: "",
        },
        sk,
      );

      const deletedCount = await storage.deleteEvents(deletionEvent);

      assert.equal(deletedCount, 2);
      assert.equal(updateByQueryCalled, true);
    });

    it("should not delete by coordinate when pubkeys don't match", async () => {
      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();
      const pk2 = getPublicKey(sk2);

      let updateByQueryCalled = false;
      mockClient.updateByQuery = (async () => {
        updateByQueryCalled = true;
        return {
          body: {
            updated: 0,
          },
        };
      }) as never;

      const deletionEvent = finalizeEvent(
        {
          kind: 5,
          created_at: 2000000000,
          tags: [["a", `30000:${pk2}:article-1`]], // Different pubkey
          content: "",
        },
        sk1,
      );

      const deletedCount = await storage.deleteEvents(deletionEvent);

      assert.equal(deletedCount, 0);
      assert.equal(updateByQueryCalled, false);
    });
  });
});
