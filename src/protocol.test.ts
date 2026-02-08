import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import type { NRelay } from "@nostrify/nostrify";
import type { Filter, NostrEvent } from "nostr-tools";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import {
  handleEventMessage,
  handleReqMessage,
  validateSubscriptionCount,
} from "./protocol.ts";

describe("Protocol Handlers", () => {
  let mockStorage: NRelay;

  beforeEach(() => {
    // Create mock storage with NRelay interface
    mockStorage = {
      event: async (_event: NostrEvent) => {},
      query: async (_filters: Filter[]) => [],
      remove: async (_filters: Filter[]) => {},
    } as unknown as NRelay;
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

      const result = await handleEventMessage(deletionEvent, mockStorage);

      assert.equal(result.accepted, true);
      assert.equal(result.eventId, deletionEvent.id);
      assert.equal(result.message, "");
    });

    it("should successfully store event", async () => {
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
  });

  describe("handleReqMessage", () => {
    it("should accept valid REQ with filters", async () => {
      const filters: Filter[] = [{ kinds: [1] }];
      const mockEvents: NostrEvent[] = [];

      mockStorage.query = async () => mockEvents;

      const result = await handleReqMessage("sub1", filters, mockStorage);

      assert.equal(result.success, true);
      if (result.success) {
        assert.deepEqual(result.events, mockEvents);
      }
    });

    it("should reject empty subscription ID", async () => {
      const filters: Filter[] = [{ kinds: [1] }];

      const result = await handleReqMessage("", filters, mockStorage);

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

      const result = await handleReqMessage(longSubId, filters, mockStorage);

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

      const result = await handleReqMessage("sub1", filters, mockStorage);

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

      const result = await handleReqMessage("sub1", filters, mockStorage);

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

      mockStorage.query = async () => mockEvents;

      const filters: Filter[] = [{ kinds: [1] }];
      const result = await handleReqMessage("sub1", filters, mockStorage);

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

      const result = await handleReqMessage("sub1", filters, mockStorage, {
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

      const result = await handleReqMessage(subId, filters, mockStorage, {
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
