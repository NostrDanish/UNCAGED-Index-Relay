import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import type { Filter, NostrEvent } from "nostr-tools";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import {
  handleEventMessage,
  handleReqMessage,
  validateSubscriptionCount,
} from "./protocol.ts";
import type { EventQuery } from "./query.ts";
import type { EventStorage } from "./storage.ts";

describe("Protocol Handlers", () => {
  let mockStorage: EventStorage;
  let mockQuery: EventQuery;

  beforeEach(() => {
    // Create mock storage
    mockStorage = {
      storeEvent: async (_event: NostrEvent) => true,
      deleteEvents: async (_event: NostrEvent) => 0,
    } as unknown as EventStorage;

    // Create mock query
    mockQuery = {
      query: async (_filters: Filter[]) => [],
    } as unknown as EventQuery;
  });

  describe("handleEventMessage", () => {
    it("should accept valid event", async () => {
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

      const result = await handleEventMessage(event, mockStorage);

      assert.equal(result.accepted, true);
      assert.equal(result.eventId, event.id);
      assert.equal(result.message, "");
    });

    // Note: We don't test invalid signature scenarios because verifyEvent
    // from nostr-tools handles that, and we shouldn't test third-party code

    it("should handle deletion events (kind 5)", async () => {
      const sk = generateSecretKey();
      const deletionEvent = finalizeEvent(
        {
          kind: 5,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["e", "event123"]],
          content: "",
        },
        sk,
      );

      mockStorage.deleteEvents = async () => 3;

      const result = await handleEventMessage(deletionEvent, mockStorage);

      assert.equal(result.accepted, true);
      assert.equal(result.eventId, deletionEvent.id);
      assert.equal(result.message, "deleted: 3 events deleted");
    });

    it("should return duplicate message when event already exists", async () => {
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Duplicate event",
        },
        sk,
      );

      mockStorage.storeEvent = async () => false;

      const result = await handleEventMessage(event, mockStorage);

      assert.equal(result.accepted, true);
      assert.equal(result.eventId, event.id);
      assert.equal(result.message, "duplicate: already have this event");
    });
  });

  describe("handleReqMessage", () => {
    it("should accept valid REQ with filters", async () => {
      const filters: Filter[] = [{ kinds: [1] }];
      const mockEvents: NostrEvent[] = [];

      mockQuery.query = async () => mockEvents;

      const result = await handleReqMessage("sub1", filters, mockQuery);

      assert.equal(result.success, true);
      if (result.success) {
        assert.deepEqual(result.events, mockEvents);
      }
    });

    it("should reject empty subscription ID", async () => {
      const filters: Filter[] = [{ kinds: [1] }];

      const result = await handleReqMessage("", filters, mockQuery);

      assert.equal(result.success, false);
      if (!result.success) {
        assert.equal(
          result.error.message,
          "invalid: subscription ID too long or empty",
        );
      }
    });

    it("should reject subscription ID longer than limit", async () => {
      const filters: Filter[] = [{ kinds: [1] }];
      const longSubId = "a".repeat(101);

      const result = await handleReqMessage(longSubId, filters, mockQuery);

      assert.equal(result.success, false);
      if (!result.success) {
        assert.equal(
          result.error.message,
          "invalid: subscription ID too long or empty",
        );
      }
    });

    it("should reject empty filters array", async () => {
      const filters: Filter[] = [];

      const result = await handleReqMessage("sub1", filters, mockQuery);

      assert.equal(result.success, false);
      if (!result.success) {
        assert.equal(
          result.error.message,
          "invalid: filters must be a non-empty array",
        );
      }
    });

    it("should reject too many filters", async () => {
      const filters: Filter[] = Array.from({ length: 101 }, () => ({
        kinds: [1],
      }));

      const result = await handleReqMessage("sub1", filters, mockQuery);

      assert.equal(result.success, false);
      if (!result.success) {
        assert.equal(result.error.message, "invalid: too many filters");
      }
    });

    it("should return queried events on success", async () => {
      const sk = generateSecretKey();
      const mockEvents: NostrEvent[] = [
        finalizeEvent(
          {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: "Event 1",
          },
          sk,
        ),
        finalizeEvent(
          {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: "Event 2",
          },
          sk,
        ),
      ];

      mockQuery.query = async () => mockEvents;

      const filters: Filter[] = [{ kinds: [1] }];
      const result = await handleReqMessage("sub1", filters, mockQuery);

      assert.equal(result.success, true);
      if (result.success) {
        assert.equal(result.events.length, 2);
        assert.deepEqual(result.events, mockEvents);
      }
    });

    it("should support custom max filters limit", async () => {
      const filters: Filter[] = Array.from({ length: 11 }, () => ({
        kinds: [1],
      }));

      const result = await handleReqMessage("sub1", filters, mockQuery, {
        maxFilters: 10,
      });

      assert.equal(result.success, false);
      if (!result.success) {
        assert.equal(result.error.message, "invalid: too many filters");
      }
    });

    it("should support custom max sub ID length limit", async () => {
      const filters: Filter[] = [{ kinds: [1] }];
      const subId = "a".repeat(51);

      const result = await handleReqMessage(subId, filters, mockQuery, {
        maxSubIdLength: 50,
      });

      assert.equal(result.success, false);
      if (!result.success) {
        assert.equal(
          result.error.message,
          "invalid: subscription ID too long or empty",
        );
      }
    });
  });

  describe("validateSubscriptionCount", () => {
    it("should return null when under limit", () => {
      const result = validateSubscriptionCount(10, 20);
      assert.equal(result, null);
    });

    it("should return error when at limit", () => {
      const result = validateSubscriptionCount(20, 20);
      assert.ok(result);
      assert.equal(result.message, "rate-limited: too many subscriptions");
    });

    it("should return error when over limit", () => {
      const result = validateSubscriptionCount(21, 20);
      assert.ok(result);
      assert.equal(result.message, "rate-limited: too many subscriptions");
    });

    it("should use default limit of 20", () => {
      const result = validateSubscriptionCount(20);
      assert.ok(result);
    });
  });
});
