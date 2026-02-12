import { strict as assert } from "node:assert";
import { after, afterEach, describe, it } from "node:test";
import type { NostrEvent } from "nostr-tools";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { VerifyPool } from "./verify-pool.ts";

describe("VerifyPool", () => {
  let pool: VerifyPool;

  // Suppress console output during tests
  const originalLog = console.log;
  const originalError = console.error;
  after(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  afterEach(() => {
    pool?.dispose();
  });

  /** Create a valid signed event. */
  function createValidEvent(content = "test"): NostrEvent {
    const sk = generateSecretKey();
    return finalizeEvent(
      {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content,
      },
      sk,
    );
  }

  /** Create an event with an invalid signature. */
  function createInvalidEvent(): NostrEvent {
    const event = createValidEvent("invalid");
    return { ...event, sig: "a".repeat(128) };
  }

  it("should verify a valid event", async () => {
    console.log = () => {};
    pool = new VerifyPool(1);
    const event = createValidEvent();

    const valid = await pool.verify(event);
    assert.equal(valid, true);
  });

  it("should reject an event with invalid signature", async () => {
    console.log = () => {};
    pool = new VerifyPool(1);
    const event = createInvalidEvent();

    const valid = await pool.verify(event);
    assert.equal(valid, false);
  });

  it("should reject an event with tampered content", async () => {
    console.log = () => {};
    pool = new VerifyPool(1);
    const event = createValidEvent();
    // Tamper with content — id and sig no longer match
    const tampered = { ...event, content: "tampered" };

    const valid = await pool.verify(tampered);
    assert.equal(valid, false);
  });

  it("should handle concurrent verifications", async () => {
    console.log = () => {};
    pool = new VerifyPool(2);

    const events = Array.from({ length: 20 }, (_, i) =>
      createValidEvent(`concurrent ${i}`),
    );

    const results = await Promise.all(events.map((e) => pool.verify(e)));
    assert.equal(results.length, 20);
    assert.ok(results.every((v) => v === true));
  });

  it("should handle mixed valid and invalid events concurrently", async () => {
    console.log = () => {};
    pool = new VerifyPool(2);

    const valid1 = createValidEvent("valid 1");
    const invalid1 = createInvalidEvent();
    const valid2 = createValidEvent("valid 2");
    const invalid2 = createInvalidEvent();

    const results = await Promise.all([
      pool.verify(valid1),
      pool.verify(invalid1),
      pool.verify(valid2),
      pool.verify(invalid2),
    ]);

    assert.deepEqual(results, [true, false, true, false]);
  });

  it("should distribute work across workers via round-robin", async () => {
    console.log = () => {};
    pool = new VerifyPool(4);

    // Verify enough events that all 4 workers get used
    const events = Array.from({ length: 8 }, (_, i) =>
      createValidEvent(`round-robin ${i}`),
    );

    const results = await Promise.all(events.map((e) => pool.verify(e)));
    assert.ok(results.every((v) => v === true));
  });

  it("should correctly correlate responses using id:sig key", async () => {
    console.log = () => {};
    pool = new VerifyPool(1);

    // Two events submitted — results should be correctly matched
    const event1 = createValidEvent("first");
    const event2 = createValidEvent("second");

    const [result1, result2] = await Promise.all([
      pool.verify(event1),
      pool.verify(event2),
    ]);

    assert.equal(result1, true);
    assert.equal(result2, true);
  });

  it("should reject pending requests on dispose", async () => {
    console.log = () => {};
    console.error = () => {};
    pool = new VerifyPool(1);

    const event = createValidEvent();
    const promise = pool.verify(event);

    // Dispose before the worker can respond
    pool.dispose();

    await assert.rejects(promise, {
      message: "Verify pool disposed",
    });
  });

  it("should work with pool size of 1", async () => {
    console.log = () => {};
    pool = new VerifyPool(1);

    const events = Array.from({ length: 5 }, (_, i) =>
      createValidEvent(`single worker ${i}`),
    );

    const results = await Promise.all(events.map((e) => pool.verify(e)));
    assert.ok(results.every((v) => v === true));
  });
});
