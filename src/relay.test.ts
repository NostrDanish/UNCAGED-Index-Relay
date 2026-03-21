import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ServerWebSocket } from "bun";
import type { Filter, NostrEvent } from "nostr-tools";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import {
  type AnalyzableRelay,
  clampUntil,
  Relay,
  type WebSocketData,
} from "./relay.ts";

describe("Relay", () => {
  let relay: Relay;
  let mockStorage: AnalyzableRelay;
  let mockWs: ServerWebSocket<WebSocketData>;
  let sentMessages: unknown[][];
  let consoleErrorSpy: typeof console.error;
  let consoleLogSpy: typeof console.log;

  beforeEach(() => {
    sentMessages = [];

    // Suppress console output during tests
    consoleErrorSpy = console.error;
    consoleLogSpy = console.log;
    console.error = () => {};
    console.log = () => {};

    // Create mock storage with NRelay interface
    mockStorage = {
      event: async (_event: NostrEvent) => {},
      query: async (_filters: Filter[]) => [],
      remove: async (_filters: Filter[]) => {},
    } as unknown as AnalyzableRelay;

    // Create mock WebSocket
    mockWs = {
      send: (message: string) => {
        sentMessages.push(JSON.parse(message));
      },
      data: {
        subscriptions: new Map(),
        challenge: "",
        challengeSent: false,
        authedPubkeys: new Set(),
      },
    } as unknown as ServerWebSocket<WebSocketData>;

    relay = new Relay(mockStorage, { relayUrl: "wss://relay.test/" });
  });

  afterEach(() => {
    // Restore console output
    console.error = consoleErrorSpy;
    console.log = consoleLogSpy;
  });

  describe("constructor", () => {
    it("should create relay with default relay info", () => {
      const info = relay.getRelayInfo();
      assert.equal(info.name, "Ditto Relay");
      assert.equal(info.software, "https://gitlab.com/soapbox-pub/ditto-relay");
      assert.equal(info.version, "0.1.0");
      assert.deepEqual(info.supported_nips, [1, 9, 11, 40, 42, 45, 50, 62, 70]);
    });

    it("should allow customizing relay info", () => {
      const customRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        relayInfo: {
          name: "Custom Relay",
          description: "My custom relay",
          pubkey: "abc123",
        },
      });

      const info = customRelay.getRelayInfo();
      assert.equal(info.name, "Custom Relay");
      assert.equal(info.description, "My custom relay");
      assert.equal(info.pubkey, "abc123");
      assert.equal(info.software, "https://gitlab.com/soapbox-pub/ditto-relay"); // defaults still work
    });
  });

  describe("handleEvent", () => {
    it("should accept valid event and send OK response", async () => {
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

      await relay.handleEvent(mockWs, event);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", event.id, true, ""]);
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

      await relay.handleEvent(mockWs, event);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", event.id, true, ""]);
    });

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

      await relay.handleEvent(mockWs, deletionEvent);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", deletionEvent.id, true, ""]);
    });

    it("should only allow deletion of own events via a-tag (NIP-09)", async () => {
      const sk = generateSecretKey();
      const otherPubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        generateSecretKey(),
      ).pubkey;

      let removeCalled = false;
      let removeFilters: Filter[] = [];

      mockStorage.remove = async (filters: Filter[]) => {
        removeCalled = true;
        removeFilters = filters;
      };

      const deletionEvent = finalizeEvent(
        {
          kind: 5,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["a", `30023:${otherPubkey}:my-article`], // Trying to delete someone else's event
          ],
          content: "",
        },
        sk,
      );

      await relay.handleEvent(mockWs, deletionEvent);

      // Event should be accepted (deletion events are always stored)
      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", deletionEvent.id, true, ""]);

      // But remove should not be called with the mismatched pubkey
      if (removeCalled) {
        // If remove was called, verify it has no filters (a-tag was rejected)
        assert.equal(removeFilters.length, 0);
      }
    });

    it("should allow deletion of own events via a-tag (NIP-09)", async () => {
      const sk = generateSecretKey();
      const myPubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      let removeCalled = false;
      let removeFilters: Filter[] = [];

      mockStorage.remove = async (filters: Filter[]) => {
        removeCalled = true;
        removeFilters = filters;
      };

      const deletionEvent = finalizeEvent(
        {
          kind: 5,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["a", `30023:${myPubkey}:my-article`], // Deleting own event
          ],
          content: "",
        },
        sk,
      );

      await relay.handleEvent(mockWs, deletionEvent);

      // Event should be accepted
      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", deletionEvent.id, true, ""]);

      // Remove should be called with the correct filter
      assert.ok(removeCalled);
      assert.equal(removeFilters.length, 1);
      assert.deepEqual(removeFilters[0].kinds, [30023]);
      assert.deepEqual(removeFilters[0].authors, [myPubkey]);
      assert.deepEqual(removeFilters[0]["#d"], ["my-article"]);
    });

    it("should handle vanish request targeting this relay (kind 62, NIP-62)", async () => {
      const sk = generateSecretKey();
      const myPubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      const removeCalls: Filter[][] = [];
      mockStorage.remove = async (filters: Filter[]) => {
        removeCalls.push(filters);
      };

      const vanishEvent = finalizeEvent(
        {
          kind: 62,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["relay", "wss://relay.test/"]],
          content: "Requesting removal of all my data.",
        },
        sk,
      );

      await relay.handleEvent(mockWs, vanishEvent);

      // Event should be accepted and stored for bookkeeping
      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", vanishEvent.id, true, ""]);

      // Remove should be called twice: once for all events, once for gift wraps
      assert.equal(removeCalls.length, 2);

      // First call: delete all events from this pubkey
      assert.deepEqual(removeCalls[0], [
        { authors: [myPubkey], until: vanishEvent.created_at },
      ]);

      // Second call: delete gift wraps (kind 1059) p-tagging this pubkey
      assert.deepEqual(removeCalls[1], [
        { kinds: [1059], "#p": [myPubkey], until: vanishEvent.created_at },
      ]);
    });

    it("should handle vanish request with ALL_RELAYS tag (NIP-62)", async () => {
      const sk = generateSecretKey();
      const myPubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      const removeCalls: Filter[][] = [];
      mockStorage.remove = async (filters: Filter[]) => {
        removeCalls.push(filters);
      };

      const vanishEvent = finalizeEvent(
        {
          kind: 62,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["relay", "ALL_RELAYS"]],
          content: "Requesting complete deletion from all relays.",
        },
        sk,
      );

      await relay.handleEvent(mockWs, vanishEvent);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", vanishEvent.id, true, ""]);

      // Should process vanish for ALL_RELAYS
      assert.equal(removeCalls.length, 2);
      assert.deepEqual(removeCalls[0], [
        { authors: [myPubkey], until: vanishEvent.created_at },
      ]);
      assert.deepEqual(removeCalls[1], [
        { kinds: [1059], "#p": [myPubkey], until: vanishEvent.created_at },
      ]);
    });

    it("should ignore vanish request targeting a different relay (NIP-62)", async () => {
      const sk = generateSecretKey();

      let removeCalled = false;
      mockStorage.remove = async (_filters: Filter[]) => {
        removeCalled = true;
      };

      const vanishEvent = finalizeEvent(
        {
          kind: 62,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["relay", "wss://other-relay.example.com/"]],
          content: "Requesting removal from a different relay.",
        },
        sk,
      );

      await relay.handleEvent(mockWs, vanishEvent);

      // Event should be accepted (stored for bookkeeping)
      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", vanishEvent.id, true, ""]);

      // Remove should NOT be called since this relay is not targeted
      assert.ok(!removeCalled);
    });

    it("should reject vanish request with no relay tags (NIP-62)", async () => {
      const sk = generateSecretKey();

      const vanishEvent = finalizeEvent(
        {
          kind: 62,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Invalid vanish request.",
        },
        sk,
      );

      await relay.handleEvent(mockWs, vanishEvent);

      // Event should be rejected
      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], [
        "OK",
        vanishEvent.id,
        false,
        "invalid: kind 62 event must include at least one relay tag",
      ]);
    });

    it("should handle vanish request with relay URL without trailing slash (NIP-62)", async () => {
      const sk = generateSecretKey();
      const myPubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      const removeCalls: Filter[][] = [];
      mockStorage.remove = async (filters: Filter[]) => {
        removeCalls.push(filters);
      };

      const vanishEvent = finalizeEvent(
        {
          kind: 62,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["relay", "wss://relay.test"]], // No trailing slash
          content: "Requesting removal.",
        },
        sk,
      );

      await relay.handleEvent(mockWs, vanishEvent);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", vanishEvent.id, true, ""]);

      // Should still match due to trailing slash tolerance
      assert.equal(removeCalls.length, 2);
      assert.deepEqual(removeCalls[0], [
        { authors: [myPubkey], until: vanishEvent.created_at },
      ]);
    });

    it("should handle storage errors gracefully", async () => {
      mockStorage.event = async () => {
        throw new Error("Storage error");
      };

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Error event",
        },
        sk,
      );

      await relay.handleEvent(mockWs, event);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], [
        "OK",
        event.id,
        false,
        "error: Storage error",
      ]);
    });

    it("should not store ephemeral events (kinds 20000-29999)", async () => {
      let storageEventCalled = false;
      mockStorage.event = async () => {
        storageEventCalled = true;
      };

      const sk = generateSecretKey();
      const ephemeralEvent = finalizeEvent(
        {
          kind: 20000, // ephemeral event
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Ephemeral event",
        },
        sk,
      );

      await relay.handleEvent(mockWs, ephemeralEvent);

      // Should accept the event
      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", ephemeralEvent.id, true, ""]);

      // But should NOT call storage.event
      assert.equal(storageEventCalled, false);
    });

    it("should broadcast ephemeral events to active subscribers", async () => {
      let storageEventCalled = false;
      mockStorage.event = async () => {
        storageEventCalled = true;
      };

      // Create a subscriber
      const sub = {
        send: (message: string) => {
          sentMessages.push(JSON.parse(message));
        },
        data: {
          subscriptions: new Map(),
          challenge: "",
          authedPubkeys: new Set(),
        },
      } as unknown as ServerWebSocket<WebSocketData>;

      relay.handleOpen(sub);
      mockStorage.query = async () => [];
      await relay.handleReq(sub, "sub1", [{ kinds: [20000] }]);
      sentMessages.length = 0;

      // Publish ephemeral event
      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const ephemeralEvent = finalizeEvent(
        {
          kind: 20000,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Ephemeral broadcast",
        },
        sk,
      );

      await relay.handleEvent(mockWs, ephemeralEvent);

      // Should be accepted and broadcast
      const okMsg = sentMessages.find((m) => m[0] === "OK");
      const eventMsg = sentMessages.find((m) => m[0] === "EVENT");
      assert.ok(okMsg);
      assert.ok(eventMsg);
      assert.equal(eventMsg[1], "sub1");
      assert.equal((eventMsg[2] as NostrEvent).id, ephemeralEvent.id);

      // But NOT stored
      assert.equal(storageEventCalled, false);
    });
  });

  describe("handleReq", () => {
    it("should accept valid REQ and send events with EOSE", async () => {
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
      ];

      mockStorage.query = async () => mockEvents;

      const filters: Filter[] = [{ kinds: [1] }];
      await relay.handleReq(mockWs, "sub1", filters);

      assert.equal(sentMessages.length, 2);
      assert.equal(sentMessages[0][0], "EVENT");
      assert.equal(sentMessages[0][1], "sub1");
      // Check the event fields
      const sentEvent = sentMessages[0][2] as NostrEvent;
      assert.equal(sentEvent.id, mockEvents[0].id);
      assert.equal(sentEvent.content, mockEvents[0].content);
      assert.deepEqual(sentMessages[1], ["EOSE", "sub1"]);
      assert.equal(mockWs.data.subscriptions.size, 1);
      assert.ok(mockWs.data.subscriptions.has("sub1"));
    });

    it("should send EOSE even when no events match", async () => {
      mockStorage.query = async () => [];

      const filters: Filter[] = [{ kinds: [999] }];
      await relay.handleReq(mockWs, "sub1", filters);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["EOSE", "sub1"]);
      assert.equal(mockWs.data.subscriptions.size, 1);
    });

    it("should reject when subscription limit reached", async () => {
      // Fill up subscriptions to the limit
      for (let i = 0; i < 20; i++) {
        mockWs.data.subscriptions.set(`sub${i}`, {
          id: `sub${i}`,
          filters: [{ kinds: [1] }],
        });
      }

      const filters: Filter[] = [{ kinds: [1] }];
      await relay.handleReq(mockWs, "sub21", filters);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], [
        "CLOSED",
        "sub21",
        "rate-limited: too many subscriptions",
      ]);
      assert.equal(mockWs.data.subscriptions.size, 20); // Not added
    });

    it("should send CLOSED on validation error", async () => {
      const filters: Filter[] = []; // Empty filters - invalid

      await relay.handleReq(mockWs, "sub1", filters);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "CLOSED");
      assert.equal(sentMessages[0][1], "sub1");
      assert.ok((sentMessages[0][2] as string).includes("non-empty array"));
    });

    it("should handle query errors gracefully", async () => {
      mockStorage.query = async () => {
        throw new Error("Query failed");
      };

      const filters: Filter[] = [{ kinds: [1] }];
      await relay.handleReq(mockWs, "sub1", filters);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], [
        "CLOSED",
        "sub1",
        "error: Query failed",
      ]);
    });

    it("should store subscription on success", async () => {
      mockStorage.query = async () => [];

      const filters: Filter[] = [{ kinds: [1], authors: ["abc"] }];
      await relay.handleReq(mockWs, "sub1", filters);

      const subscription = mockWs.data.subscriptions.get("sub1");
      assert.ok(subscription);
      assert.equal(subscription.id, "sub1");
      assert.deepEqual(subscription.filters, filters);
    });
  });

  describe("handleCount", () => {
    it("should return count when storage supports it", async () => {
      mockStorage.count = async () => ({ count: 42 });

      const filters: Filter[] = [{ kinds: [1] }];
      await relay.handleCount(mockWs, "count1", filters);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "COUNT");
      assert.equal(sentMessages[0][1], "count1");
      assert.deepEqual(sentMessages[0][2], { count: 42 });
    });

    it("should return count with approximate flag for multiple filters", async () => {
      mockStorage.count = async (filters: Filter[]) => ({
        count: 1000,
        approximate: filters.length > 1 ? true : undefined,
      });

      const filters: Filter[] = [{ kinds: [1] }, { kinds: [7] }];
      await relay.handleCount(mockWs, "count1", filters);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "COUNT");
      assert.equal(sentMessages[0][1], "count1");
      assert.deepEqual(sentMessages[0][2], { count: 1000, approximate: true });
    });

    it("should not set approximate flag for single filter", async () => {
      mockStorage.count = async (filters: Filter[]) => ({
        count: 42,
        approximate: filters.length > 1 ? true : undefined,
      });

      const filters: Filter[] = [{ kinds: [1] }];
      await relay.handleCount(mockWs, "count1", filters);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "COUNT");
      assert.equal(sentMessages[0][1], "count1");
      assert.deepEqual(sentMessages[0][2], { count: 42 });
    });

    it("should send CLOSED when storage does not support count", async () => {
      // Remove count method from storage
      mockStorage.count = undefined;

      const filters: Filter[] = [{ kinds: [1] }];
      await relay.handleCount(mockWs, "count1", filters);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "CLOSED");
      assert.equal(sentMessages[0][1], "count1");
      assert.ok((sentMessages[0][2] as string).includes("COUNT not supported"));
    });

    it("should send CLOSED on validation error (empty filters)", async () => {
      mockStorage.count = async () => ({ count: 0 });

      const filters: Filter[] = []; // Empty filters - invalid
      await relay.handleCount(mockWs, "count1", filters);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "CLOSED");
      assert.equal(sentMessages[0][1], "count1");
      assert.ok((sentMessages[0][2] as string).includes("non-empty array"));
    });

    it("should handle count errors gracefully", async () => {
      mockStorage.count = async () => {
        throw new Error("Count failed");
      };

      const filters: Filter[] = [{ kinds: [1] }];
      await relay.handleCount(mockWs, "count1", filters);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], [
        "CLOSED",
        "count1",
        "error: Count failed",
      ]);
    });
  });

  describe("handleClose", () => {
    it("should remove subscription", () => {
      // Add a subscription
      mockWs.data.subscriptions.set("sub1", {
        id: "sub1",
        filters: [{ kinds: [1] }],
      });

      relay.handleClose(mockWs, "sub1");

      assert.equal(mockWs.data.subscriptions.size, 0);
    });

    it("should not error when closing non-existent subscription", () => {
      assert.doesNotThrow(() => {
        relay.handleClose(mockWs, "nonexistent");
      });
    });
  });

  describe("handleMessage", () => {
    it("should handle EVENT message", async () => {
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "Test",
        },
        sk,
      );

      const message = JSON.stringify(["EVENT", event]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "OK");
      assert.equal(sentMessages[0][1], event.id);
    });

    it("should handle REQ message", async () => {
      mockStorage.query = async () => [];

      const message = JSON.stringify(["REQ", "sub1", { kinds: [1] }]);
      await relay.handleMessage(mockWs, message);

      assert.ok(sentMessages.length > 0);
      assert.equal(sentMessages[sentMessages.length - 1][0], "EOSE");
    });

    it("should handle COUNT message", async () => {
      mockStorage.count = async () => ({ count: 5 });

      const message = JSON.stringify(["COUNT", "count1", { kinds: [1] }]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "COUNT");
      assert.equal(sentMessages[0][1], "count1");
      assert.deepEqual(sentMessages[0][2], { count: 5 });
    });

    it("should handle CLOSE message", async () => {
      mockWs.data.subscriptions.set("sub1", {
        id: "sub1",
        filters: [{ kinds: [1] }],
      });

      const message = JSON.stringify(["CLOSE", "sub1"]);
      await relay.handleMessage(mockWs, message);

      assert.equal(mockWs.data.subscriptions.size, 0);
    });

    it("should reject invalid JSON", async () => {
      const message = "not valid json";
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok(
        (sentMessages[0][1] as string).includes("failed to process message"),
      );
    });

    it("should reject non-array message", async () => {
      const message = JSON.stringify({ type: "EVENT" });
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok(
        (sentMessages[0][1] as string).includes("non-empty JSON array"),
      );
    });

    it("should reject empty array", async () => {
      const message = JSON.stringify([]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok(
        (sentMessages[0][1] as string).includes("non-empty JSON array"),
      );
    });

    it("should reject unknown message type", async () => {
      const message = JSON.stringify(["UNKNOWN", "param"]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok(
        (sentMessages[0][1] as string).includes("unknown message type"),
      );
    });

    it("should reject EVENT with wrong parameter count", async () => {
      const message = JSON.stringify(["EVENT"]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok((sentMessages[0][1] as string).includes("exactly 1 parameter"));
    });

    it("should reject REQ with missing parameters", async () => {
      const message = JSON.stringify(["REQ", "sub1"]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok((sentMessages[0][1] as string).includes("at least 1 filter"));
    });

    it("should reject COUNT with missing parameters", async () => {
      const message = JSON.stringify(["COUNT", "count1"]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok((sentMessages[0][1] as string).includes("at least 1 filter"));
    });

    it("should reject CLOSE with wrong parameter count", async () => {
      const message = JSON.stringify(["CLOSE"]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok((sentMessages[0][1] as string).includes("exactly 1 parameter"));
    });

    it("should handle Buffer messages", async () => {
      mockStorage.query = async () => [];

      const messageStr = JSON.stringify(["REQ", "sub1", { kinds: [1] }]);
      const buffer = Buffer.from(messageStr);
      await relay.handleMessage(mockWs, buffer);

      assert.ok(sentMessages.length > 0);
      assert.equal(sentMessages[sentMessages.length - 1][0], "EOSE");
    });
  });

  describe("handleOpen", () => {
    it("should generate AUTH challenge but not send it on connection open", () => {
      relay.handleOpen(mockWs);

      // No messages should be sent on connection open
      assert.equal(sentMessages.length, 0);
      // Challenge should be generated and stored in connection data
      assert.equal(typeof mockWs.data.challenge, "string");
      assert.ok(mockWs.data.challenge.length > 0);
      // Challenge should not be marked as sent
      assert.equal(mockWs.data.challengeSent, false);
    });
  });

  describe("handleCloseConnection", () => {
    it("should clear all subscriptions on connection close", () => {
      mockWs.data.subscriptions.set("sub1", {
        id: "sub1",
        filters: [{ kinds: [1] }],
      });
      mockWs.data.subscriptions.set("sub2", {
        id: "sub2",
        filters: [{ kinds: [1] }],
      });

      relay.handleCloseConnection(mockWs);

      assert.equal(mockWs.data.subscriptions.size, 0);
    });

    it("should handle undefined data gracefully", () => {
      const wsWithNoData = {
        data: undefined,
      } as unknown as ServerWebSocket<WebSocketData>;

      assert.doesNotThrow(() => {
        relay.handleCloseConnection(wsWithNoData);
      });
    });
  });

  describe("broadcast / live subscriptions", () => {
    /** Helper to create a mock WebSocket that records sent messages. */
    function createMockWs(): {
      ws: ServerWebSocket<WebSocketData>;
      messages: unknown[][];
    } {
      const messages: unknown[][] = [];
      const ws = {
        send: (message: string) => {
          messages.push(JSON.parse(message));
        },
        data: {
          subscriptions: new Map(),
          challenge: "",
          authedPubkeys: new Set(),
        },
      } as unknown as ServerWebSocket<WebSocketData>;
      return { ws, messages };
    }

    it("should broadcast event to matching subscription on another connection", async () => {
      // Subscriber
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [1] }]);
      sub.messages.length = 0; // clear EOSE

      // Publisher (uses the default mockWs)
      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "live!",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event);

      // Subscriber should have received the event
      assert.equal(sub.messages.length, 1);
      assert.equal(sub.messages[0][0], "EVENT");
      assert.equal(sub.messages[0][1], "sub1");
      assert.equal((sub.messages[0][2] as NostrEvent).id, event.id);
    });

    it("should not broadcast to non-matching kind", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [7] }]); // wants kind 7
      sub.messages.length = 0;

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "nope",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event);

      // Subscriber should NOT receive the event
      assert.equal(sub.messages.length, 0);
    });

    it("should broadcast to subscription with matching author filter", async () => {
      const authorSk = generateSecretKey();
      const authorEvent = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        authorSk,
      );
      const authorPubkey = authorEvent.pubkey;

      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [
        { kinds: [1], authors: [authorPubkey] },
      ]);
      sub.messages.length = 0;

      relay.handleOpen(mockWs);

      // Event from matching author
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "match",
        },
        authorSk,
      );
      await relay.handleEvent(mockWs, event);
      assert.equal(sub.messages.length, 1);
      assert.equal((sub.messages[0][2] as NostrEvent).id, event.id);

      // Event from different author — should NOT match
      sub.messages.length = 0;
      const otherSk = generateSecretKey();
      const otherEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "no match",
        },
        otherSk,
      );
      await relay.handleEvent(mockWs, otherEvent);
      assert.equal(sub.messages.length, 0);
    });

    it("should not broadcast after CLOSE", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [1] }]);
      sub.messages.length = 0;

      // Close the subscription
      relay.handleClose(sub.ws, "sub1");

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "too late",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event);

      assert.equal(sub.messages.length, 0);
    });

    it("should not broadcast after connection close", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [1] }]);
      sub.messages.length = 0;

      // Close the connection
      relay.handleCloseConnection(sub.ws);

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "gone",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event);

      assert.equal(sub.messages.length, 0);
    });

    it("should broadcast to multiple subscriptions on the same connection", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [1] }]);
      await relay.handleReq(sub.ws, "sub2", [{ kinds: [1] }]);
      sub.messages.length = 0;

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "multi",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event);

      // Both subscriptions should receive the event
      const eventMessages = sub.messages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMessages.length, 2);
      const subIds = eventMessages.map((m) => m[1]).sort();
      assert.deepEqual(subIds, ["sub1", "sub2"]);
    });

    it("should deduplicate when multiple filters in one subscription match", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      // Two filters that both match kind 1
      await relay.handleReq(sub.ws, "sub1", [
        { kinds: [1] },
        { kinds: [1, 7] },
      ]);
      sub.messages.length = 0;

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "dedup",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event);

      // Should only receive the event ONCE
      const eventMessages = sub.messages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMessages.length, 1);
    });

    it("should broadcast to catchAll subscription with empty filter", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{}]); // empty filter = match everything
      sub.messages.length = 0;

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 42,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "catch all",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event);

      assert.equal(sub.messages.length, 1);
      assert.equal(sub.messages[0][0], "EVENT");
      assert.equal((sub.messages[0][2] as NostrEvent).id, event.id);
    });

    it("should update broadcast filters when subscription is replaced", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [1] }]);
      sub.messages.length = 0;

      // Replace subscription to only want kind 7
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [7] }]);
      sub.messages.length = 0;

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();

      // Kind 1 should NOT match anymore
      const event1 = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "old",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event1);
      assert.equal(sub.messages.length, 0);

      // Kind 7 should match now
      const event7 = finalizeEvent(
        {
          kind: 7,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "+",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event7);
      assert.equal(sub.messages.length, 1);
      assert.equal((sub.messages[0][2] as NostrEvent).id, event7.id);
    });

    it("should also broadcast to the publisher's own matching subscriptions", async () => {
      relay.handleOpen(mockWs);
      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [{ kinds: [1] }]);
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "echo",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event);

      // Should have OK + EVENT (broadcast to own subscription)
      const okMsg = sentMessages.find((m) => m[0] === "OK");
      const eventMsg = sentMessages.find((m) => m[0] === "EVENT");
      assert.ok(okMsg);
      assert.ok(eventMsg);
      assert.equal(eventMsg[1], "sub1");
      assert.equal((eventMsg[2] as NostrEvent).id, event.id);
    });

    it("should not broadcast rejected events", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [1] }]);
      sub.messages.length = 0;

      relay.handleOpen(mockWs);

      // Submit an event with a bad signature
      const event = {
        id: "a".repeat(64),
        pubkey: "b".repeat(64),
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [],
        content: "bad sig",
        sig: "c".repeat(128),
      } as NostrEvent;
      await relay.handleEvent(mockWs, event);

      // Subscriber should NOT receive a rejected event
      assert.equal(sub.messages.length, 0);
    });
  });

  describe("NIP-42 AUTH", () => {
    it("should handle AUTH message via handleMessage", async () => {
      relay.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://relay.test/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk,
      );

      const message = JSON.stringify(["AUTH", authEvent]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "OK");
      assert.equal(sentMessages[0][1], authEvent.id);
      assert.equal(sentMessages[0][2], true);
    });

    it("should accept valid AUTH event and mark pubkey as authenticated", async () => {
      relay.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://relay.test/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk,
      );

      await relay.handleAuth(mockWs, authEvent);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", authEvent.id, true, ""]);
      assert.ok(relay.isAuthenticated(mockWs, authEvent.pubkey));
    });

    it("should allow multiple pubkeys to authenticate on the same connection", async () => {
      relay.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();

      const authEvent1 = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://relay.test/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk1,
      );

      const authEvent2 = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://relay.test/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk2,
      );

      await relay.handleAuth(mockWs, authEvent1);
      await relay.handleAuth(mockWs, authEvent2);

      assert.ok(relay.isAuthenticated(mockWs, authEvent1.pubkey));
      assert.ok(relay.isAuthenticated(mockWs, authEvent2.pubkey));
    });

    it("should reject AUTH event with invalid signature", async () => {
      relay.handleOpen(mockWs);
      sentMessages.length = 0;

      const event = {
        id: "a".repeat(64),
        pubkey: "b".repeat(64),
        created_at: Math.floor(Date.now() / 1000),
        kind: 22242,
        tags: [
          ["relay", "wss://relay.test/"],
          ["challenge", mockWs.data.challenge],
        ],
        content: "",
        sig: "c".repeat(128),
      } as NostrEvent;

      await relay.handleAuth(mockWs, event);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][2], false);
      assert.ok(
        (sentMessages[0][3] as string).includes("signature verification"),
      );
      assert.ok(!relay.isAuthenticated(mockWs, event.pubkey));
    });

    it("should reject AUTH event with wrong kind", async () => {
      relay.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const authEvent = finalizeEvent(
        {
          kind: 1, // wrong kind
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://relay.test/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk,
      );

      await relay.handleAuth(mockWs, authEvent);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][2], false);
      assert.ok((sentMessages[0][3] as string).includes("kind 22242"));
      assert.ok(!relay.isAuthenticated(mockWs, authEvent.pubkey));
    });

    it("should reject AUTH event with timestamp too far in the past", async () => {
      relay.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000) - 700, // ~11 minutes ago
          tags: [
            ["relay", "wss://relay.test/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk,
      );

      await relay.handleAuth(mockWs, authEvent);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][2], false);
      assert.ok((sentMessages[0][3] as string).includes("timestamp"));
    });

    it("should reject AUTH event with wrong challenge", async () => {
      relay.handleOpen(mockWs);
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://relay.test/"],
            ["challenge", "wrong-challenge"],
          ],
          content: "",
        },
        sk,
      );

      await relay.handleAuth(mockWs, authEvent);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][2], false);
      assert.ok(
        (sentMessages[0][3] as string).includes("challenge does not match"),
      );
    });

    it("should reject AUTH event with missing relay tag", async () => {
      relay.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["challenge", challenge]], // no relay tag
          content: "",
        },
        sk,
      );

      await relay.handleAuth(mockWs, authEvent);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][2], false);
      assert.ok((sentMessages[0][3] as string).includes("missing relay tag"));
    });

    it("should reject AUTH when relay URL does not match", async () => {
      const relayWithUrl = new Relay(mockStorage, {
        relayUrl: "wss://myrelay.example.com/",
      });

      relayWithUrl.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();

      const badAuthEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://other-relay.example.com/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk,
      );

      await relayWithUrl.handleAuth(mockWs, badAuthEvent);
      assert.equal(sentMessages[0][2], false);
      assert.ok(
        (sentMessages[0][3] as string).includes("relay URL does not match"),
      );
    });

    it("should accept AUTH with exact relay URL match", async () => {
      const relayWithUrl = new Relay(mockStorage, {
        relayUrl: "wss://myrelay.example.com/",
      });

      relayWithUrl.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();

      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://myrelay.example.com/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk,
      );

      await relayWithUrl.handleAuth(mockWs, authEvent);
      assert.equal(sentMessages[0][2], true);
    });

    it("should tolerate optional trailing slash for root path", async () => {
      // Configured without trailing slash
      const relayWithUrl = new Relay(mockStorage, {
        relayUrl: "wss://myrelay.example.com",
      });

      relayWithUrl.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();

      // Client sends with trailing slash — should still match
      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://myrelay.example.com/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk,
      );

      await relayWithUrl.handleAuth(mockWs, authEvent);
      assert.equal(sentMessages[0][2], true);
    });

    it("should not tolerate trailing slash leniency for non-root paths", async () => {
      const relayWithUrl = new Relay(mockStorage, {
        relayUrl: "wss://myrelay.example.com/custom-path",
      });

      relayWithUrl.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();

      // Client sends with trailing slash on non-root path — should NOT match
      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://myrelay.example.com/custom-path/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk,
      );

      await relayWithUrl.handleAuth(mockWs, authEvent);
      assert.equal(sentMessages[0][2], false);
      assert.ok(
        (sentMessages[0][3] as string).includes("relay URL does not match"),
      );
    });

    it("should reject AUTH message with wrong parameter count", async () => {
      const message = JSON.stringify(["AUTH"]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok((sentMessages[0][1] as string).includes("exactly 1 parameter"));
    });
  });

  describe("NIP-70 protected events", () => {
    it("should reject protected event from unauthenticated client and send AUTH challenge", async () => {
      relay.handleOpen(mockWs);
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const protectedEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["-"]],
          content: "secret message",
        },
        sk,
      );

      await relay.handleEvent(mockWs, protectedEvent);

      // AUTH challenge should be sent before the OK rejection
      assert.equal(sentMessages.length, 2);
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[0][1], mockWs.data.challenge);
      assert.equal(sentMessages[1][0], "OK");
      assert.equal(sentMessages[1][1], protectedEvent.id);
      assert.equal(sentMessages[1][2], false);
      assert.ok((sentMessages[1][3] as string).includes("auth-required"));
    });

    it("should accept protected event from authenticated author", async () => {
      relay.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk = generateSecretKey();

      // Authenticate first
      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://relay.test/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk,
      );
      await relay.handleAuth(mockWs, authEvent);
      sentMessages.length = 0;

      // Now publish protected event
      const protectedEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["-"]],
          content: "secret message",
        },
        sk,
      );

      await relay.handleEvent(mockWs, protectedEvent);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "OK");
      assert.equal(sentMessages[0][1], protectedEvent.id);
      assert.equal(sentMessages[0][2], true);
    });

    it("should reject protected event when authenticated as different pubkey", async () => {
      relay.handleOpen(mockWs);
      const challenge = mockWs.data.challenge;
      sentMessages.length = 0;

      const sk1 = generateSecretKey();
      const sk2 = generateSecretKey();

      // Authenticate as sk1
      const authEvent = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", "wss://relay.test/"],
            ["challenge", challenge],
          ],
          content: "",
        },
        sk1,
      );
      await relay.handleAuth(mockWs, authEvent);
      sentMessages.length = 0;

      // Try to publish protected event as sk2
      const protectedEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["-"]],
          content: "not my event",
        },
        sk2,
      );

      await relay.handleEvent(mockWs, protectedEvent);

      // AUTH challenge is sent lazily before the rejection
      assert.equal(sentMessages.length, 2);
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[1][2], false);
      assert.ok((sentMessages[1][3] as string).includes("auth-required"));
    });

    it("should accept non-protected event from unauthenticated client", async () => {
      relay.handleOpen(mockWs);
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const normalEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "public message",
        },
        sk,
      );

      await relay.handleEvent(mockWs, normalEvent);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][2], true);
    });

    it("should not treat tags with extra elements as protected", async () => {
      relay.handleOpen(mockWs);
      sentMessages.length = 0;

      const sk = generateSecretKey();
      // ["-", "something"] is NOT a protection tag — must be exactly ["-"]
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["-", "not-a-protection-tag"]],
          content: "normal message",
        },
        sk,
      );

      await relay.handleEvent(mockWs, event);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][2], true);
    });

    it("should handle protected event via handleMessage", async () => {
      relay.handleOpen(mockWs);
      sentMessages.length = 0;

      const sk = generateSecretKey();
      const protectedEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["-"]],
          content: "secret",
        },
        sk,
      );

      const message = JSON.stringify(["EVENT", protectedEvent]);
      await relay.handleMessage(mockWs, message);

      // AUTH challenge should be sent before the OK rejection
      assert.equal(sentMessages.length, 2);
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[1][0], "OK");
      assert.equal(sentMessages[1][2], false);
      assert.ok((sentMessages[1][3] as string).includes("auth-required"));
    });
  });

  describe("NIP-40 expiration", () => {
    it("should include NIP-40 in supported NIPs", () => {
      const info = relay.getRelayInfo();
      assert.ok(info.supported_nips?.includes(40));
    });

    it("should reject an event that is already expired", async () => {
      const sk = generateSecretKey();
      const pastTimestamp = String(Math.floor(Date.now() / 1000) - 3600); // 1 hour ago
      const expiredEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000) - 7200,
          tags: [["expiration", pastTimestamp]],
          content: "This has expired",
        },
        sk,
      );

      await relay.handleEvent(mockWs, expiredEvent);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "OK");
      assert.equal(sentMessages[0][1], expiredEvent.id);
      assert.equal(sentMessages[0][2], false);
      assert.ok((sentMessages[0][3] as string).includes("expired"));
    });

    it("should accept an event with a future expiration", async () => {
      const sk = generateSecretKey();
      const futureTimestamp = String(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["expiration", futureTimestamp]],
          content: "Not expired yet",
        },
        sk,
      );

      await relay.handleEvent(mockWs, event);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", event.id, true, ""]);
    });

    it("should accept an event with no expiration tag", async () => {
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "No expiration",
        },
        sk,
      );

      await relay.handleEvent(mockWs, event);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", event.id, true, ""]);
    });

    it("should not broadcast an expired event", async () => {
      // Create a subscriber
      const sub = {
        send: (message: string) => {
          sentMessages.push(JSON.parse(message));
        },
        data: {
          subscriptions: new Map(),
          challenge: "",
          authedPubkeys: new Set(),
        },
      } as unknown as ServerWebSocket<WebSocketData>;

      relay.handleOpen(sub);
      mockStorage.query = async () => [];
      await relay.handleReq(sub, "sub1", [{ kinds: [1] }]);
      sentMessages.length = 0;

      // Publish an expired event
      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const expiredEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000) - 7200,
          tags: [["expiration", String(Math.floor(Date.now() / 1000) - 3600)]],
          content: "Expired broadcast",
        },
        sk,
      );

      await relay.handleEvent(mockWs, expiredEvent);

      // The event should be rejected, so no EVENT message to subscriber
      const eventMessages = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMessages.length, 0);
    });
  });

  describe("clampUntil", () => {
    it("should set until to current time when not provided", () => {
      const before = Math.floor(Date.now() / 1000);
      const result = clampUntil({ kinds: [1] });
      const after = Math.floor(Date.now() / 1000);
      assert.ok(result.until !== undefined);
      assert.ok(result.until! >= before);
      assert.ok(result.until! <= after);
    });

    it("should add fuzz to until when provided", () => {
      const before = Math.floor(Date.now() / 1000);
      const result = clampUntil({ kinds: [1] }, 60);
      const after = Math.floor(Date.now() / 1000);
      assert.ok(result.until !== undefined);
      assert.ok(result.until! >= before + 60);
      assert.ok(result.until! <= after + 60);
    });

    it("should not override an explicit until", () => {
      const filter = { kinds: [1], until: 9999999999 };
      const result = clampUntil(filter);
      assert.equal(result.until, 9999999999);
    });

    it("should not set until when since is in the future", () => {
      const future = Math.floor(Date.now() / 1000) + 3600;
      const filter = { kinds: [1], since: future };
      const result = clampUntil(filter);
      assert.equal(result.until, undefined);
    });

    it("should set until when since is in the past", () => {
      const past = Math.floor(Date.now() / 1000) - 3600;
      const before = Math.floor(Date.now() / 1000);
      const filter = { kinds: [1], since: past };
      const result = clampUntil(filter);
      const after = Math.floor(Date.now() / 1000);
      assert.ok(result.until !== undefined);
      assert.ok(result.until! >= before);
      assert.ok(result.until! <= after);
    });

    it("should not mutate the original filter", () => {
      const filter: Filter = { kinds: [1] };
      const result = clampUntil(filter);
      assert.equal(filter.until, undefined);
      assert.notStrictEqual(result, filter);
    });
  });

  describe("future event filtering", () => {
    it("should not return future events in REQ queries by default", async () => {
      const futureEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000) + 3600,
          tags: [],
          content: "future",
        },
        generateSecretKey(),
      );

      // Mock storage returns the future event
      mockStorage.query = async (filters: Filter[]) => {
        // Verify that the filter has until set to approximately now
        assert.ok(filters[0].until !== undefined);
        assert.ok(filters[0].until! <= Math.floor(Date.now() / 1000) + 1);
        return [futureEvent];
      };

      relay.handleOpen(mockWs);
      await relay.handleReq(mockWs, "sub1", [{ kinds: [1] }]);

      // Should still get events from storage (storage decides what matches)
      const eventMessages = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMessages.length, 1);
    });

    it("should pass through explicit until to storage", async () => {
      const futureUntil = Math.floor(Date.now() / 1000) + 7200;

      mockStorage.query = async (filters: Filter[]) => {
        assert.equal(filters[0].until, futureUntil);
        return [];
      };

      relay.handleOpen(mockWs);
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [1], until: futureUntil },
      ]);
    });

    it("should not set until when since is in the future", async () => {
      const futureSince = Math.floor(Date.now() / 1000) + 3600;

      mockStorage.query = async (filters: Filter[]) => {
        assert.equal(filters[0].until, undefined);
        assert.equal(filters[0].since, futureSince);
        return [];
      };

      relay.handleOpen(mockWs);
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [1], since: futureSince },
      ]);
    });

    it("should not broadcast future events to subscriptions without explicit until", async () => {
      /** Helper to create a mock WebSocket that records sent messages. */
      function createMockWs(): {
        ws: ServerWebSocket<WebSocketData>;
        messages: unknown[][];
      } {
        const messages: unknown[][] = [];
        const ws = {
          send: (message: string) => {
            messages.push(JSON.parse(message));
          },
          data: {
            subscriptions: new Map(),
            challenge: "",
            authedPubkeys: new Set(),
          },
        } as unknown as ServerWebSocket<WebSocketData>;
        return { ws, messages };
      }

      // Subscriber with no until filter
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [1] }]);
      sub.messages.length = 0;

      // Publish a future-dated event
      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const futureEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000) + 3600,
          tags: [],
          content: "future event",
        },
        sk,
      );
      await relay.handleEvent(mockWs, futureEvent);

      // Subscriber should NOT receive the future event
      const eventMessages = sub.messages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMessages.length, 0);
    });

    it("should reject future-dated ephemeral events with OK false", async () => {
      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const futureEphemeral = finalizeEvent(
        {
          kind: 20000,
          created_at: Math.floor(Date.now() / 1000) + 3600,
          tags: [],
          content: "future ephemeral",
        },
        sk,
      );
      await relay.handleEvent(mockWs, futureEphemeral);

      const okMsg = sentMessages.find((m) => m[0] === "OK");
      assert.ok(okMsg);
      assert.equal(okMsg[1], futureEphemeral.id);
      assert.equal(okMsg[2], false);
      assert.ok(
        (okMsg[3] as string).includes("ephemeral event is in the future"),
      );
    });
  });
});
