import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ServerWebSocket } from "bun";
import type { Filter, NostrEvent } from "nostr-tools";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { AnalyzePoolOverloaded, StorageOverloaded } from "./errors.ts";
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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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

    it("should NACK with 'relay overloaded' when analyze pool throws AnalyzePoolOverloaded", async () => {
      const overloadedRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        analyze: () => {
          throw new AnalyzePoolOverloaded(1000, 1000);
        },
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "overloaded analyze",
        },
        sk,
      );

      await overloadedRelay.handleEvent(mockWs, event);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], [
        "OK",
        event.id,
        false,
        "error: relay overloaded, try again",
      ]);
    });

    it("should NACK with 'relay overloaded' when storage.event throws StorageOverloaded", async () => {
      const overloadedStorage = {
        ...mockStorage,
        event: async () => {
          throw new StorageOverloaded(5000, 5000);
        },
      } as unknown as AnalyzableRelay;

      const overloadedRelay = new Relay(overloadedStorage, {
        relayUrl: "wss://relay.test/",
        analyze: () => ({ verified: true }),
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "overloaded storage",
        },
        sk,
      );

      await overloadedRelay.handleEvent(mockWs, event);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], [
        "OK",
        event.id,
        false,
        "error: relay overloaded, try again",
      ]);
    });
  });

  describe("banned hashtags", () => {
    it("should reject an event containing a banned hashtag", async () => {
      let storageEventCalled = false;
      const storage = {
        ...mockStorage,
        event: async () => {
          storageEventCalled = true;
        },
      } as unknown as AnalyzableRelay;
      const bannedRelay = new Relay(storage, {
        relayUrl: "wss://relay.test/",
        bannedHashtags: new Set(["spam"]),
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["t", "spam"]],
          content: "buy now",
        },
        sk,
      );

      await bannedRelay.handleEvent(mockWs, event);

      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], [
        "OK",
        event.id,
        false,
        "blocked: event contains a banned hashtag",
      ]);
      assert.equal(storageEventCalled, false);
    });

    it("should match banned hashtags case-insensitively", async () => {
      const bannedRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        bannedHashtags: new Set(["spam"]),
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["t", "SPAM"]],
          content: "buy now",
        },
        sk,
      );

      await bannedRelay.handleEvent(mockWs, event);

      assert.equal(sentMessages[0][2], false);
      assert.equal(
        sentMessages[0][3],
        "blocked: event contains a banned hashtag",
      );
    });

    it("should accept an event with a non-banned hashtag", async () => {
      const bannedRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        bannedHashtags: new Set(["spam"]),
      });

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["t", "nostr"]],
          content: "hello",
        },
        sk,
      );

      await bannedRelay.handleEvent(mockWs, event);
      bannedRelay.flushBroadcasts();

      assert.deepEqual(sentMessages[0], ["OK", event.id, true, ""]);
    });

    it("should accept any event when no hashtags are banned", async () => {
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["t", "spam"]],
          content: "hello",
        },
        sk,
      );

      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      assert.deepEqual(sentMessages[0], ["OK", event.id, true, ""]);
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

    it("should yield to the event loop while sending a large REQ result", async () => {
      // Generate 120 events (well over REQ_SEND_CHUNK=50) so the send loop
      // crosses the yield boundary at least twice.
      const sk = generateSecretKey();
      const mockEvents: NostrEvent[] = [];
      for (let i = 0; i < 120; i++) {
        mockEvents.push(
          finalizeEvent(
            {
              kind: 1,
              created_at: Math.floor(Date.now() / 1000),
              tags: [],
              content: `Event ${i}`,
            },
            sk,
          ),
        );
      }
      mockStorage.query = async () => mockEvents;

      // Schedule a setImmediate callback that runs only if the REQ send loop
      // yields. If the loop is fully synchronous, this callback will not fire
      // until after handleReq's await chain unwinds.
      let interleaved = false;
      let eventsSentBeforeInterleave = 0;
      const reqPromise = relay.handleReq(mockWs, "sub1", [{ kinds: [1] }]);

      // Race a setImmediate against the REQ completion. If the REQ yields,
      // the setImmediate callback fires before EOSE, and at that point we
      // should see some but not all events already sent.
      const yieldPromise = new Promise<void>((resolve) => {
        setImmediate(() => {
          interleaved = true;
          eventsSentBeforeInterleave = sentMessages.length;
          resolve();
        });
      });

      await Promise.race([reqPromise, yieldPromise]);
      await reqPromise;

      assert.equal(interleaved, true, "REQ send loop did not yield");
      // Some events were sent before the yield, and more were sent after.
      // The exact count depends on scheduling but we should have at least
      // one chunk (50) and fewer than the total + EOSE.
      assert.ok(
        eventsSentBeforeInterleave > 0 &&
          eventsSentBeforeInterleave < mockEvents.length + 1,
        `expected partial progress at yield, got ${eventsSentBeforeInterleave} of ${mockEvents.length}`,
      );
      // After completion, all events + EOSE were sent.
      assert.equal(sentMessages.length, mockEvents.length + 1);
      assert.equal(sentMessages[sentMessages.length - 1][0], "EOSE");
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

    describe("EVENT payload schema validation", () => {
      // A well-formed EVENT payload with a valid 64-hex id. Individual tests
      // mutate a single field to prove validation catches it.
      const validIdHex = "a".repeat(64);
      const validPubkey = "b".repeat(64);
      const validSig = "c".repeat(128);
      const baseEvent = () => ({
        id: validIdHex,
        pubkey: validPubkey,
        created_at: 1_700_000_000,
        kind: 1,
        tags: [],
        content: "hi",
        sig: validSig,
      });

      it("rejects EVENT with non-object payload (string)", async () => {
        const message = JSON.stringify(["EVENT", "not an event"]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "NOTICE");
        assert.ok((sentMessages[0][1] as string).includes("schema validation"));
      });

      it("rejects EVENT with null payload", async () => {
        const message = JSON.stringify(["EVENT", null]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "NOTICE");
      });

      it("rejects EVENT with missing id (no OK reply, falls back to NOTICE)", async () => {
        const bad = baseEvent();
        delete (bad as { id?: string }).id;
        const message = JSON.stringify(["EVENT", bad]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "NOTICE");
      });

      it("replies OK/false when id is valid-looking but other fields fail", async () => {
        const bad = { ...baseEvent(), kind: "not-a-number" };
        const message = JSON.stringify(["EVENT", bad]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.deepEqual(sentMessages[0], [
          "OK",
          validIdHex,
          false,
          "invalid: event failed schema validation",
        ]);
      });

      it("rejects EVENT with short id", async () => {
        const bad = { ...baseEvent(), id: "abc" };
        const message = JSON.stringify(["EVENT", bad]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        // id isn't 64-hex, so fallback to NOTICE
        assert.equal(sentMessages[0][0], "NOTICE");
      });

      it("rejects EVENT with tags as string", async () => {
        const bad = { ...baseEvent(), tags: "lol" };
        const message = JSON.stringify(["EVENT", bad]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "OK");
        assert.equal(sentMessages[0][2], false);
      });

      it("rejects EVENT with non-string tag element", async () => {
        const bad = { ...baseEvent(), tags: [["e", 123]] };
        const message = JSON.stringify(["EVENT", bad]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "OK");
        assert.equal(sentMessages[0][2], false);
      });

      it("rejects EVENT with missing sig", async () => {
        const bad = baseEvent();
        delete (bad as { sig?: string }).sig;
        const message = JSON.stringify(["EVENT", bad]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "OK");
        assert.equal(sentMessages[0][2], false);
      });

      it("rejects EVENT with non-integer created_at", async () => {
        const bad = { ...baseEvent(), created_at: 1.5 };
        const message = JSON.stringify(["EVENT", bad]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "OK");
        assert.equal(sentMessages[0][2], false);
      });

      it("does not pollute Object.prototype from __proto__ payload", async () => {
        // Object literal written as JSON so __proto__ is treated as a data
        // key by JSON.parse, not as the literal prototype slot.
        const message = `["EVENT", {
          "id": "${validIdHex}",
          "pubkey": "${validPubkey}",
          "created_at": 1700000000,
          "kind": 1,
          "tags": "bogus",
          "content": "",
          "sig": "${validSig}",
          "__proto__": { "polluted": true }
        }]`;
        await relay.handleMessage(mockWs, message);
        // Schema rejects the event entirely (tags is a string, not array)...
        assert.equal(sentMessages[0][0], "OK");
        assert.equal(sentMessages[0][2], false);
        // ...and critically, no pollution leaked into Object.prototype.
        assert.equal(({} as Record<string, unknown>).polluted, undefined);
      });
    });

    describe("AUTH payload schema validation", () => {
      it("rejects AUTH with non-object payload", async () => {
        const message = JSON.stringify(["AUTH", "not an event"]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "NOTICE");
        assert.ok((sentMessages[0][1] as string).includes("schema validation"));
      });

      it("rejects AUTH with malformed event (no OK reply for AUTH)", async () => {
        const bad = {
          id: "a".repeat(64),
          pubkey: "b".repeat(64),
          created_at: 1_700_000_000,
          kind: "not-a-number",
          tags: [],
          content: "",
          sig: "c".repeat(128),
        };
        const message = JSON.stringify(["AUTH", bad]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "NOTICE");
      });
    });

    describe("REQ/COUNT filter schema validation", () => {
      it("rejects REQ filter with non-array kinds", async () => {
        const message = JSON.stringify(["REQ", "sub1", { kinds: "nope" }]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.equal(sentMessages[0][1], "sub1");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });

      it("rejects REQ filter with non-numeric kind element", async () => {
        const message = JSON.stringify(["REQ", "sub1", { kinds: ["1"] }]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });

      it("rejects REQ filter with non-hex author", async () => {
        const message = JSON.stringify([
          "REQ",
          "sub1",
          { authors: ["not-hex"] },
        ]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });

      it("rejects REQ filter with short id", async () => {
        const message = JSON.stringify(["REQ", "sub1", { ids: ["deadbeef"] }]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });

      it("rejects REQ filter with negative limit", async () => {
        const message = JSON.stringify(["REQ", "sub1", { limit: -1 }]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });

      it("rejects REQ filter with non-numeric since", async () => {
        const message = JSON.stringify(["REQ", "sub1", { since: "yesterday" }]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });

      it("rejects REQ filter with non-string search", async () => {
        const message = JSON.stringify(["REQ", "sub1", { search: 123 }]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });

      it("rejects REQ filter that is not an object", async () => {
        const message = JSON.stringify(["REQ", "sub1", "not-a-filter"]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });

      it("rejects if ANY filter in the REQ is invalid (rest are ignored)", async () => {
        mockStorage.query = async () => [];
        const message = JSON.stringify([
          "REQ",
          "sub1",
          { kinds: [1] }, // valid
          { kinds: ["2"] }, // invalid
        ]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });

      it("accepts REQ with valid filter", async () => {
        mockStorage.query = async () => [];
        const message = JSON.stringify([
          "REQ",
          "sub1",
          { kinds: [1], authors: ["a".repeat(64)], limit: 10 },
        ]);
        await relay.handleMessage(mockWs, message);
        // Last message should be EOSE — no CLOSED with schema error.
        const last = sentMessages[sentMessages.length - 1];
        assert.equal(last[0], "EOSE");
      });

      it("accepts REQ with unknown top-level key (silently dropped)", async () => {
        // NSchema.filter() uses looseObject + transform that strips unknowns,
        // so an extra key doesn't cause rejection. The key simply isn't passed
        // downstream to OpenSearch.
        mockStorage.query = async () => [];
        const message = JSON.stringify([
          "REQ",
          "sub1",
          { kinds: [1], weirdKey: { nested: "attack" } },
        ]);
        await relay.handleMessage(mockWs, message);
        const last = sentMessages[sentMessages.length - 1];
        assert.equal(last[0], "EOSE");
      });

      it("rejects COUNT with invalid filter", async () => {
        const message = JSON.stringify([
          "COUNT",
          "c1",
          { authors: ["not-hex"] },
        ]);
        await relay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.equal(sentMessages[0][1], "c1");
        assert.ok((sentMessages[0][2] as string).includes("schema validation"));
      });
    });

    describe("REQ/COUNT per-field max_filter_values cap", () => {
      let smallRelay: Relay;
      beforeEach(() => {
        smallRelay = new Relay(mockStorage, {
          relayUrl: "wss://relay.test/",
          maxFilterValues: 3,
        });
      });

      it("advertises max_filter_values in NIP-11 limitation", () => {
        const info = smallRelay.getRelayInfo();
        const lim = info.limitation as
          | { max_filter_values?: number }
          | undefined;
        assert.equal(lim?.max_filter_values, 3);
      });

      it("rejects REQ with authors array over cap", async () => {
        const authors = Array.from({ length: 4 }, (_, i) =>
          `${i}`.padStart(64, "0"),
        );
        const message = JSON.stringify(["REQ", "sub1", { authors }]);
        await smallRelay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.equal(sentMessages[0][1], "sub1");
        assert.ok((sentMessages[0][2] as string).includes("max_filter_values"));
        assert.ok((sentMessages[0][2] as string).includes("authors"));
      });

      it("rejects REQ with ids array over cap", async () => {
        const ids = Array.from({ length: 4 }, (_, i) =>
          `${i}`.padStart(64, "a"),
        );
        const message = JSON.stringify(["REQ", "sub1", { ids }]);
        await smallRelay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes('"ids"'));
      });

      it("rejects REQ with kinds array over cap", async () => {
        const kinds = [1, 2, 3, 4];
        const message = JSON.stringify(["REQ", "sub1", { kinds }]);
        await smallRelay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes('"kinds"'));
      });

      it("rejects REQ with #tag array over cap", async () => {
        const message = JSON.stringify([
          "REQ",
          "sub1",
          { "#e": ["a", "b", "c", "d"] },
        ]);
        await smallRelay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.ok((sentMessages[0][2] as string).includes('"#e"'));
      });

      it("accepts REQ with authors array exactly at cap", async () => {
        mockStorage.query = async () => [];
        const authors = Array.from({ length: 3 }, (_, i) =>
          `${i}`.padStart(64, "0"),
        );
        const message = JSON.stringify(["REQ", "sub1", { authors }]);
        await smallRelay.handleMessage(mockWs, message);
        const last = sentMessages[sentMessages.length - 1];
        assert.equal(last[0], "EOSE");
      });

      it("rejects COUNT when filter exceeds cap", async () => {
        const authors = Array.from({ length: 4 }, (_, i) =>
          `${i}`.padStart(64, "0"),
        );
        const message = JSON.stringify(["COUNT", "c1", { authors }]);
        await smallRelay.handleMessage(mockWs, message);
        assert.equal(sentMessages[0][0], "CLOSED");
        assert.equal(sentMessages[0][1], "c1");
        assert.ok((sentMessages[0][2] as string).includes("max_filter_values"));
      });

      it("default cap is 5000 when not configured", () => {
        const defaultRelay = new Relay(mockStorage, {
          relayUrl: "wss://relay.test/",
        });
        const info = defaultRelay.getRelayInfo();
        const lim = info.limitation as
          | { max_filter_values?: number }
          | undefined;
        assert.equal(lim?.max_filter_values, 5000);
      });
    });

    describe("NIP-11 limitation accuracy", () => {
      it("advertises max_event_tags matching the constructor option", () => {
        const customRelay = new Relay(mockStorage, {
          relayUrl: "wss://relay.test/",
          maxEventTags: 1234,
        });
        const lim = customRelay.getRelayInfo().limitation as
          | { max_event_tags?: number }
          | undefined;
        assert.equal(lim?.max_event_tags, 1234);
      });

      it("defaults max_event_tags to 5000 when unset", () => {
        const defaultRelay = new Relay(mockStorage, {
          relayUrl: "wss://relay.test/",
        });
        const lim = defaultRelay.getRelayInfo().limitation as
          | { max_event_tags?: number }
          | undefined;
        assert.equal(lim?.max_event_tags, 5000);
      });

      it("does not advertise max_content_length (not enforced beyond max_message_length)", () => {
        const defaultRelay = new Relay(mockStorage, {
          relayUrl: "wss://relay.test/",
        });
        const lim = defaultRelay.getRelayInfo().limitation as
          | Record<string, unknown>
          | undefined;
        assert.ok(lim, "limitation object is present");
        assert.ok(
          !("max_content_length" in (lim as object)),
          "max_content_length should not be advertised",
        );
      });
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

  describe("per-connection inflight cap", () => {
    it("should serialize EVENT processing on one connection past the cap", async () => {
      // Build a relay with a small cap and a slow analyze so we can observe
      // that the (cap+1)th event waits for the first to complete.
      const CAP = 2;
      let analyzeInflight = 0;
      let peakInflight = 0;
      const releaseFns: Array<() => void> = [];

      const cappedRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        maxInflightPerConn: CAP,
        analyze: () => {
          analyzeInflight++;
          if (analyzeInflight > peakInflight) peakInflight = analyzeInflight;
          return new Promise((resolve) => {
            releaseFns.push(() => {
              analyzeInflight--;
              resolve({ verified: true });
            });
          });
        },
      });

      const sk = generateSecretKey();
      const messages: string[] = [];
      for (let i = 0; i < 5; i++) {
        const ev = finalizeEvent(
          {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: `event ${i}`,
          },
          sk,
        );
        messages.push(JSON.stringify(["EVENT", ev]));
      }

      // Fire-and-forget all 5 messages.
      const pending = messages.map((m) => cappedRelay.handleMessage(mockWs, m));

      // Let microtasks settle so the first CAP analyze() calls fire.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(
        analyzeInflight,
        CAP,
        `expected only ${CAP} concurrent analyze() calls, got ${analyzeInflight}`,
      );
      assert.equal(
        peakInflight,
        CAP,
        `peak concurrent analyze() should never exceed cap, got ${peakInflight}`,
      );

      // Release the first batch. Each release lets the next waiter through.
      while (releaseFns.length > 0) {
        const next = releaseFns.shift()!;
        next();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
      }

      await Promise.all(pending);

      // All 5 events should have been processed (OK responses sent).
      const okMessages = sentMessages.filter((m) => m[0] === "OK");
      assert.equal(okMessages.length, 5);
      assert.equal(
        peakInflight,
        CAP,
        "cap should have been respected throughout",
      );
    });

    it("should not gate REQ behind the EVENT inflight cap", async () => {
      // EVENTs hold the cap; a REQ on the same socket must still complete.
      const CAP = 1;
      const releaseFns: Array<() => void> = [];

      const cappedRelay = new Relay(mockStorage, {
        relayUrl: "wss://relay.test/",
        maxInflightPerConn: CAP,
        analyze: () =>
          new Promise((resolve) => {
            releaseFns.push(() => resolve({ verified: true }));
          }),
      });

      mockStorage.query = async () => [];

      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "blocker",
        },
        sk,
      );

      // Start an EVENT that will hold the cap until we release.
      const eventPromise = cappedRelay.handleMessage(
        mockWs,
        JSON.stringify(["EVENT", event]),
      );

      // Let the EVENT acquire the semaphore.
      await new Promise((resolve) => setImmediate(resolve));

      // Now send a REQ on the same socket — it must complete without
      // waiting on the held EVENT.
      const reqPromise = cappedRelay.handleMessage(
        mockWs,
        JSON.stringify(["REQ", "subA", { kinds: [1] }]),
      );

      // REQ should finish promptly.
      await reqPromise;
      const lastBeforeRelease = sentMessages[sentMessages.length - 1];
      assert.equal(
        lastBeforeRelease[0],
        "EOSE",
        "REQ should have completed while EVENT was still gated",
      );

      // Now release the EVENT and await it.
      for (const fn of releaseFns) fn();
      await eventPromise;
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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();
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
      relay.flushBroadcasts();
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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();
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
      relay.flushBroadcasts();
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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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
      relay.flushBroadcasts();

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

describe("Relay with authKinds", () => {
  let relay: Relay;
  let mockStorage: AnalyzableRelay;
  let mockWs: ServerWebSocket<WebSocketData>;
  let sentMessages: unknown[][];

  beforeEach(() => {
    sentMessages = [];
    console.error = () => {};
    console.log = () => {};

    mockStorage = {
      event: async (_event: NostrEvent) => {},
      query: async (_filters: Filter[]) => [],
      remove: async (_filters: Filter[]) => {},
    } as unknown as AnalyzableRelay;

    mockWs = {
      send: (message: string) => {
        sentMessages.push(JSON.parse(message));
      },
      data: {
        subscriptions: new Map(),
        challenge: "test-challenge",
        challengeSent: false,
        authedPubkeys: new Set(),
      },
    } as unknown as ServerWebSocket<WebSocketData>;

    relay = new Relay(mockStorage, {
      relayUrl: "wss://relay.test/",
      authKinds: new Set([4, 1059]),
    });
  });

  afterEach(() => {
    console.error = () => {};
    console.log = () => {};
  });

  describe("REQ with auth kinds", () => {
    it("should reject REQ for auth kind without authors or #p (unauthenticated)", async () => {
      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [{ kinds: [4] }]);

      assert.equal(sentMessages.length, 2); // AUTH challenge + CLOSED
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[1][0], "CLOSED");
      assert.equal(sentMessages[1][1], "sub1");
      assert.ok((sentMessages[1][2] as string).startsWith("auth-required:"));
    });

    it("should reject REQ for kind 1059 without authors or #p (unauthenticated)", async () => {
      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [{ kinds: [1059] }]);

      assert.equal(sentMessages.length, 2); // AUTH challenge + CLOSED
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[1][0], "CLOSED");
      assert.ok((sentMessages[1][2] as string).startsWith("auth-required:"));
    });

    it("should reject REQ with auth kind and unauthenticated authors", async () => {
      mockStorage.query = async () => [];
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      await relay.handleReq(mockWs, "sub1", [
        { kinds: [4], authors: [pubkey] },
      ]);

      assert.equal(sentMessages.length, 2); // AUTH challenge + CLOSED
      assert.equal(sentMessages[0][0], "AUTH"); // challenge sent
      assert.equal(sentMessages[1][0], "CLOSED");
      assert.ok((sentMessages[1][2] as string).startsWith("auth-required:"));
    });

    it("should reject REQ with auth kind and unauthenticated #p", async () => {
      mockStorage.query = async () => [];
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      await relay.handleReq(mockWs, "sub1", [
        { kinds: [1059], "#p": [pubkey] },
      ]);

      assert.equal(sentMessages.length, 2); // AUTH challenge + CLOSED
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[1][0], "CLOSED");
      assert.ok((sentMessages[1][2] as string).startsWith("auth-required:"));
    });

    it("should allow REQ for auth kind with authenticated authors", async () => {
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      // Authenticate the pubkey
      mockWs.data.authedPubkeys.add(pubkey);

      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [4], authors: [pubkey] },
      ]);

      // Should get EOSE (no CLOSED)
      const eose = sentMessages.find((m) => m[0] === "EOSE");
      assert.ok(eose);
      assert.equal(eose[1], "sub1");
    });

    it("should allow REQ for auth kind with authenticated #p", async () => {
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      mockWs.data.authedPubkeys.add(pubkey);

      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [1059], "#p": [pubkey] },
      ]);

      const eose = sentMessages.find((m) => m[0] === "EOSE");
      assert.ok(eose);
    });

    it("should reject when one of multiple authors is not authenticated", async () => {
      const sk1 = generateSecretKey();
      const pk1 = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk1,
      ).pubkey;
      const sk2 = generateSecretKey();
      const pk2 = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk2,
      ).pubkey;

      // Only authenticate pk1
      mockWs.data.authedPubkeys.add(pk1);

      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [4], authors: [pk1, pk2] },
      ]);

      const closed = sentMessages.find((m) => m[0] === "CLOSED");
      assert.ok(closed);
      assert.ok((closed[2] as string).startsWith("auth-required:"));
    });

    it("should allow non-auth kinds without authentication", async () => {
      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [{ kinds: [1] }]);

      const eose = sentMessages.find((m) => m[0] === "EOSE");
      assert.ok(eose);
    });

    it("should pass through events from catch-all REQ (storage handles auth-kind exclusion)", async () => {
      const sk = generateSecretKey();
      const kind1Event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "public",
        },
        sk,
      );

      // Storage only returns non-auth-kind events for catch-all queries
      // (auth-kind exclusion is handled at the storage/OpenSearch level)
      mockStorage.query = async () => [kind1Event];
      await relay.handleReq(mockWs, "sub1", [{ authors: [kind1Event.pubkey] }]);

      const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 1);
      assert.equal((eventMsgs[0][2] as NostrEvent).kind, 1);
    });

    it("should allow auth-kind events when explicitly requested with auth", async () => {
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      mockWs.data.authedPubkeys.add(pubkey);

      const kind4Event = finalizeEvent(
        {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "dm",
        },
        sk,
      );

      mockStorage.query = async () => [kind4Event];
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [4], authors: [pubkey] },
      ]);

      const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 1);
      assert.equal((eventMsgs[0][2] as NostrEvent).kind, 4);
    });
  });

  describe("COUNT with auth kinds", () => {
    it("should reject COUNT for auth kind without authors or #p (unauthenticated)", async () => {
      mockStorage.count = async () => ({ count: 10 });
      await relay.handleCount(mockWs, "c1", [{ kinds: [4] }]);

      assert.equal(sentMessages.length, 2); // AUTH challenge + CLOSED
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[1][0], "CLOSED");
      assert.ok((sentMessages[1][2] as string).startsWith("auth-required:"));
    });

    it("should reject COUNT for auth kind with unauthenticated authors", async () => {
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      mockStorage.count = async () => ({ count: 10 });
      await relay.handleCount(mockWs, "c1", [
        { kinds: [1059], authors: [pubkey] },
      ]);

      assert.equal(sentMessages.length, 2); // AUTH + CLOSED
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[1][0], "CLOSED");
      assert.ok((sentMessages[1][2] as string).startsWith("auth-required:"));
    });

    it("should allow COUNT for auth kind with authenticated authors", async () => {
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      mockWs.data.authedPubkeys.add(pubkey);
      mockStorage.count = async () => ({ count: 5 });
      await relay.handleCount(mockWs, "c1", [
        { kinds: [4], authors: [pubkey] },
      ]);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "COUNT");
      assert.deepEqual(sentMessages[0][2], { count: 5 });
    });

    it("should pass through catch-all COUNT (storage handles auth-kind exclusion)", async () => {
      mockStorage.count = async () => ({ count: 100 });

      await relay.handleCount(mockWs, "c1", [{ authors: ["abc".repeat(10)] }]);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0][0], "COUNT");
      assert.equal((sentMessages[0][2] as { count: number }).count, 100);
    });
  });

  describe("broadcast with auth kinds", () => {
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
          challengeSent: false,
          authedPubkeys: new Set(),
        },
      } as unknown as ServerWebSocket<WebSocketData>;
      return { ws, messages };
    }

    it("should not broadcast auth-kind events to catch-all subscriptions", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{}]); // catch-all
      sub.messages.length = 0;

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const dmEvent = finalizeEvent(
        {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "secret dm",
        },
        sk,
      );
      await relay.handleEvent(mockWs, dmEvent);
      relay.flushBroadcasts();

      // Subscriber with catch-all should NOT receive kind 4
      const eventMsgs = sub.messages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 0);
    });

    it("should not broadcast auth-kind events to subscriptions that don't include auth kinds", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [1, 7] }]); // no auth kinds
      sub.messages.length = 0;

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const giftWrap = finalizeEvent(
        {
          kind: 1059,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "wrapped",
        },
        sk,
      );
      await relay.handleEvent(mockWs, giftWrap);
      relay.flushBroadcasts();

      const eventMsgs = sub.messages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 0);
    });

    it("should broadcast auth-kind events to subscriptions that explicitly include the kind", async () => {
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      const sub = createMockWs();
      sub.ws.data.authedPubkeys.add(pubkey);
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [
        { kinds: [4], authors: [pubkey] },
      ]);
      sub.messages.length = 0;

      relay.handleOpen(mockWs);
      const dmEvent = finalizeEvent(
        {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "dm for subscriber",
        },
        sk,
      );
      await relay.handleEvent(mockWs, dmEvent);
      relay.flushBroadcasts();

      const eventMsgs = sub.messages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 1);
      assert.equal((eventMsgs[0][2] as NostrEvent).kind, 4);
    });

    it("should broadcast non-auth kinds normally", async () => {
      const sub = createMockWs();
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      await relay.handleReq(sub.ws, "sub1", [{ kinds: [1] }]);
      sub.messages.length = 0;

      relay.handleOpen(mockWs);
      const sk = generateSecretKey();
      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "hello",
        },
        sk,
      );
      await relay.handleEvent(mockWs, event);
      relay.flushBroadcasts();

      const eventMsgs = sub.messages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 1);
    });
  });

  describe("REQ by ID for auth kinds", () => {
    it("should withhold auth-kind event and send AUTH challenge when unauthenticated", async () => {
      const sk = generateSecretKey();
      const dmEvent = finalizeEvent(
        {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", "recipient".padStart(64, "0")]],
          content: "secret dm",
        },
        sk,
      );

      mockStorage.query = async () => [dmEvent];
      await relay.handleReq(mockWs, "sub1", [{ ids: [dmEvent.id] }]);

      // Event should be withheld, AUTH challenge sent, then CLOSED (not EOSE)
      const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 0);

      const authMsg = sentMessages.find((m) => m[0] === "AUTH");
      assert.ok(authMsg, "AUTH challenge should be sent");

      const closed = sentMessages.find((m) => m[0] === "CLOSED");
      assert.ok(closed, "CLOSED should be sent");
      assert.equal(closed[1], "sub1");
      assert.ok((closed[2] as string).startsWith("auth-required:"));

      // No EOSE — subscription was closed
      const eose = sentMessages.find((m) => m[0] === "EOSE");
      assert.equal(eose, undefined);
    });

    it("should return auth-kind event when authenticated as author", async () => {
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      const dmEvent = finalizeEvent(
        {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", "recipient".padStart(64, "0")]],
          content: "secret dm",
        },
        sk,
      );

      mockWs.data.authedPubkeys.add(pubkey);
      mockStorage.query = async () => [dmEvent];
      await relay.handleReq(mockWs, "sub1", [{ ids: [dmEvent.id] }]);

      const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 1);
      assert.equal((eventMsgs[0][2] as NostrEvent).id, dmEvent.id);
    });

    it("should return auth-kind event when authenticated as p-tag recipient", async () => {
      const authorSk = generateSecretKey();
      const recipientSk = generateSecretKey();
      const recipientPk = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        recipientSk,
      ).pubkey;

      const dmEvent = finalizeEvent(
        {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", recipientPk]],
          content: "dm to recipient",
        },
        authorSk,
      );

      mockWs.data.authedPubkeys.add(recipientPk);
      mockStorage.query = async () => [dmEvent];
      await relay.handleReq(mockWs, "sub1", [{ ids: [dmEvent.id] }]);

      const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 1);
      assert.equal((eventMsgs[0][2] as NostrEvent).id, dmEvent.id);
    });

    it("should withhold auth-kind event when authenticated as unrelated pubkey", async () => {
      const authorSk = generateSecretKey();
      const unrelatedSk = generateSecretKey();
      const unrelatedPk = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        unrelatedSk,
      ).pubkey;

      const dmEvent = finalizeEvent(
        {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", "recipient".padStart(64, "0")]],
          content: "secret dm",
        },
        authorSk,
      );

      mockWs.data.authedPubkeys.add(unrelatedPk);
      mockStorage.query = async () => [dmEvent];
      await relay.handleReq(mockWs, "sub1", [{ ids: [dmEvent.id] }]);

      const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 0);

      // Gets CLOSED with auth-required, not EOSE
      const closed = sentMessages.find((m) => m[0] === "CLOSED");
      assert.ok(closed);
      assert.ok((closed[2] as string).startsWith("auth-required:"));
    });

    it("should return non-auth-kind event by ID without authentication", async () => {
      const sk = generateSecretKey();
      const noteEvent = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "public note",
        },
        sk,
      );

      mockStorage.query = async () => [noteEvent];
      await relay.handleReq(mockWs, "sub1", [{ ids: [noteEvent.id] }]);

      const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 1);
      assert.equal((eventMsgs[0][2] as NostrEvent).id, noteEvent.id);

      // No AUTH challenge
      const authMsg = sentMessages.find((m) => m[0] === "AUTH");
      assert.equal(authMsg, undefined);
    });

    it("should return kind 1059 gift wrap by ID when authenticated as p-tag recipient", async () => {
      const authorSk = generateSecretKey();
      const recipientSk = generateSecretKey();
      const recipientPk = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        recipientSk,
      ).pubkey;

      const giftWrap = finalizeEvent(
        {
          kind: 1059,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", recipientPk]],
          content: "wrapped content",
        },
        authorSk,
      );

      mockWs.data.authedPubkeys.add(recipientPk);
      mockStorage.query = async () => [giftWrap];
      await relay.handleReq(mockWs, "sub1", [{ ids: [giftWrap.id] }]);

      const eventMsgs = sentMessages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 1);
      assert.equal((eventMsgs[0][2] as NostrEvent).kind, 1059);
    });
  });

  describe("broadcast auth-kind event to authorized subscriber only", () => {
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
          challengeSent: false,
          authedPubkeys: new Set(),
        },
      } as unknown as ServerWebSocket<WebSocketData>;
      return { ws, messages };
    }

    it("should not broadcast auth-kind event to subscriber who is not a party", async () => {
      const authorSk = generateSecretKey();
      const authorPk = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        authorSk,
      ).pubkey;

      // Subscriber is authenticated as a different pubkey
      const subscriberSk = generateSecretKey();
      const subscriberPk = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        subscriberSk,
      ).pubkey;

      const sub = createMockWs();
      sub.ws.data.authedPubkeys.add(subscriberPk);
      relay.handleOpen(sub.ws);
      mockStorage.query = async () => [];
      // Subscribe to kind 4 for subscriber's own pubkey
      await relay.handleReq(sub.ws, "sub1", [
        { kinds: [4], authors: [subscriberPk] },
      ]);
      sub.messages.length = 0;

      // Author sends a DM to someone else (not the subscriber)
      relay.handleOpen(mockWs);
      const dmEvent = finalizeEvent(
        {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", "someone_else".padStart(64, "0")]],
          content: "not for you",
        },
        authorSk,
      );
      await relay.handleEvent(mockWs, dmEvent);
      relay.flushBroadcasts();

      const eventMsgs = sub.messages.filter((m) => m[0] === "EVENT");
      assert.equal(eventMsgs.length, 0);
    });
  });

  describe("mixed filters", () => {
    it("should reject when any filter in the array contains auth kind without auth", async () => {
      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [1] }, // fine
        { kinds: [4] }, // needs auth
      ]);

      assert.equal(sentMessages.length, 2); // AUTH challenge + CLOSED
      assert.equal(sentMessages[0][0], "AUTH");
      assert.equal(sentMessages[1][0], "CLOSED");
      assert.ok((sentMessages[1][2] as string).startsWith("auth-required:"));
    });

    it("should allow mixed kinds in a single filter when auth kind has valid authors", async () => {
      const sk = generateSecretKey();
      const pubkey = finalizeEvent(
        { kind: 1, created_at: 0, tags: [], content: "" },
        sk,
      ).pubkey;

      mockWs.data.authedPubkeys.add(pubkey);
      mockStorage.query = async () => [];
      await relay.handleReq(mockWs, "sub1", [
        { kinds: [1, 4], authors: [pubkey] },
      ]);

      const eose = sentMessages.find((m) => m[0] === "EOSE");
      assert.ok(eose);
    });
  });
});
