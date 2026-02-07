import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ServerWebSocket } from "bun";
import type { Filter, NostrEvent } from "nostr-tools";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import type { EventQuery } from "./query.ts";
import { Relay, type WebSocketData } from "./relay.ts";
import type { EventStorage } from "./storage.ts";

describe("Relay", () => {
  let relay: Relay;
  let mockStorage: EventStorage;
  let mockQuery: EventQuery;
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

    // Create mock storage
    mockStorage = {
      storeEvent: async (_event: NostrEvent) => true,
      deleteEvents: async (_event: NostrEvent) => 0,
    } as unknown as EventStorage;

    // Create mock query
    mockQuery = {
      query: async (_filters: Filter[]) => [],
    } as unknown as EventQuery;

    // Create mock WebSocket
    mockWs = {
      send: (message: string) => {
        sentMessages.push(JSON.parse(message));
      },
      data: {
        subscriptions: new Map(),
      },
    } as unknown as ServerWebSocket<WebSocketData>;

    relay = new Relay(mockStorage, mockQuery);
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
      assert.equal(info.software, "ditto-relay");
      assert.equal(info.version, "1.0.0");
      assert.deepEqual(info.supported_nips, [1, 9, 11, 50]);
    });

    it("should allow customizing relay info", () => {
      const customRelay = new Relay(mockStorage, mockQuery, {
        name: "Custom Relay",
        description: "My custom relay",
        pubkey: "abc123",
      });

      const info = customRelay.getRelayInfo();
      assert.equal(info.name, "Custom Relay");
      assert.equal(info.description, "My custom relay");
      assert.equal(info.pubkey, "abc123");
      assert.equal(info.software, "ditto-relay"); // defaults still work
    });
  });

  describe("sendMessage", () => {
    it("should send JSON-encoded message to client", () => {
      relay.sendMessage(mockWs, ["OK", "event123", true, ""]);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], ["OK", "event123", true, ""]);
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

    it("should send duplicate message when event already exists", async () => {
      mockStorage.storeEvent = async () => false;

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

      await relay.handleEvent(mockWs, event);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], [
        "OK",
        event.id,
        true,
        "duplicate: already have this event",
      ]);
    });

    it("should handle deletion events (kind 5)", async () => {
      mockStorage.deleteEvents = async () => 3;

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
      assert.deepEqual(sentMessages[0], [
        "OK",
        deletionEvent.id,
        true,
        "deleted: 3 events deleted",
      ]);
    });

    it("should handle storage errors gracefully", async () => {
      mockStorage.storeEvent = async () => {
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

      mockQuery.query = async () => mockEvents;

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
      mockQuery.query = async () => [];

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
      mockQuery.query = async () => {
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
      mockQuery.query = async () => [];

      const filters: Filter[] = [{ kinds: [1], authors: ["abc"] }];
      await relay.handleReq(mockWs, "sub1", filters);

      const subscription = mockWs.data.subscriptions.get("sub1");
      assert.ok(subscription);
      assert.equal(subscription.id, "sub1");
      assert.deepEqual(subscription.filters, filters);
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
      mockQuery.query = async () => [];

      const message = JSON.stringify(["REQ", "sub1", { kinds: [1] }]);
      await relay.handleMessage(mockWs, message);

      assert.ok(sentMessages.length > 0);
      assert.equal(sentMessages[sentMessages.length - 1][0], "EOSE");
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

    it("should reject CLOSE with wrong parameter count", async () => {
      const message = JSON.stringify(["CLOSE"]);
      await relay.handleMessage(mockWs, message);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "NOTICE");
      assert.ok((sentMessages[0][1] as string).includes("exactly 1 parameter"));
    });

    it("should handle Buffer messages", async () => {
      mockQuery.query = async () => [];

      const messageStr = JSON.stringify(["REQ", "sub1", { kinds: [1] }]);
      const buffer = Buffer.from(messageStr);
      await relay.handleMessage(mockWs, buffer);

      assert.ok(sentMessages.length > 0);
      assert.equal(sentMessages[sentMessages.length - 1][0], "EOSE");
    });
  });

  describe("handleOpen", () => {
    it("should not throw on connection open", () => {
      assert.doesNotThrow(() => {
        relay.handleOpen(mockWs);
      });
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
});
