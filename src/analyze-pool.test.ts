import { strict as assert } from "node:assert";
import { after, afterEach, describe, it } from "node:test";
import type { NostrEvent } from "nostr-tools";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { AnalyzePool } from "./analyze-pool.ts";

describe("AnalyzePool", () => {
  let pool: AnalyzePool;

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
  function createValidEvent(content = "test", kind = 1): NostrEvent {
    const sk = generateSecretKey();
    return finalizeEvent(
      {
        kind,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content,
      },
      sk,
    );
  }

  /** Create a valid signed event with tags. */
  function createValidEventWithTags(
    content: string,
    tags: string[][],
    kind = 1,
  ): NostrEvent {
    const sk = generateSecretKey();
    return finalizeEvent(
      {
        kind,
        created_at: Math.floor(Date.now() / 1000),
        tags,
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
    pool = new AnalyzePool(1);
    const event = createValidEvent();

    const result = await pool.analyze(event);
    assert.equal(result.verified, true);
  });

  it("should reject an event with invalid signature", async () => {
    console.log = () => {};
    pool = new AnalyzePool(1);
    const event = createInvalidEvent();

    const result = await pool.analyze(event);
    assert.equal(result.verified, false);
  });

  it("should not detect language or sentiment for invalid events", async () => {
    console.log = () => {};
    pool = new AnalyzePool(1);
    const event = createInvalidEvent();

    const result = await pool.analyze(event);
    assert.equal(result.verified, false);
    assert.equal(result.language, undefined);
    assert.equal(result.sentiment, undefined);
  });

  it("should reject an event with tampered content", async () => {
    console.log = () => {};
    pool = new AnalyzePool(1);
    const event = createValidEvent();
    // Tamper with content — id and sig no longer match
    const tampered = { ...event, content: "tampered" };

    const result = await pool.analyze(tampered);
    assert.equal(result.verified, false);
  });

  it("should detect language for valid text events", async () => {
    console.log = () => {};
    pool = new AnalyzePool(1);
    const event = createValidEvent(
      "This is a long enough English sentence for language detection to work properly",
    );

    const result = await pool.analyze(event);
    assert.equal(result.verified, true);
    assert.equal(result.language, "en");
  });

  it("should detect sentiment for valid text events", async () => {
    console.log = () => {};
    pool = new AnalyzePool(1);
    const event = createValidEvent(
      "I absolutely love this! It is wonderful and amazing and fantastic!",
    );

    const result = await pool.analyze(event);
    assert.equal(result.verified, true);
    assert.equal(result.sentiment, "positive");
  });

  it("should detect negative sentiment", async () => {
    console.log = () => {};
    pool = new AnalyzePool(1);
    const event = createValidEvent(
      "This is absolutely terrible and horrible and awful and disgusting",
    );

    const result = await pool.analyze(event);
    assert.equal(result.verified, true);
    assert.equal(result.sentiment, "negative");
  });

  it("should detect sentiment for kind 7 reactions", async () => {
    console.log = () => {};
    pool = new AnalyzePool(1);
    const event = createValidEvent("+", 7);

    const result = await pool.analyze(event);
    assert.equal(result.verified, true);
    assert.equal(result.sentiment, "positive");
  });

  it("should not detect language when search text is too short", async () => {
    console.log = () => {};
    pool = new AnalyzePool(1);
    // Kind 0 with no searchable JSON fields produces empty search text
    const event = createValidEvent(
      JSON.stringify({ picture: "https://example.com/pic.jpg" }),
      0,
    );

    const result = await pool.analyze(event);
    assert.equal(result.verified, true);
    assert.equal(result.language, undefined);
  });

  it("should handle concurrent analyses", async () => {
    console.log = () => {};
    pool = new AnalyzePool(2);

    const events = Array.from({ length: 20 }, (_, i) =>
      createValidEvent(`concurrent ${i}`),
    );

    const results = await Promise.all(events.map((e) => pool.analyze(e)));
    assert.equal(results.length, 20);
    assert.ok(results.every((r) => r.verified === true));
  });

  it("should handle mixed valid and invalid events concurrently", async () => {
    console.log = () => {};
    pool = new AnalyzePool(2);

    const valid1 = createValidEvent("valid 1");
    const invalid1 = createInvalidEvent();
    const valid2 = createValidEvent("valid 2");
    const invalid2 = createInvalidEvent();

    const results = await Promise.all([
      pool.analyze(valid1),
      pool.analyze(invalid1),
      pool.analyze(valid2),
      pool.analyze(invalid2),
    ]);

    assert.equal(results[0].verified, true);
    assert.equal(results[1].verified, false);
    assert.equal(results[2].verified, true);
    assert.equal(results[3].verified, false);
  });

  it("should distribute work across workers via round-robin", async () => {
    console.log = () => {};
    pool = new AnalyzePool(4);

    // Analyze enough events that all 4 workers get used
    const events = Array.from({ length: 8 }, (_, i) =>
      createValidEvent(`round-robin ${i}`),
    );

    const results = await Promise.all(events.map((e) => pool.analyze(e)));
    assert.ok(results.every((r) => r.verified === true));
  });

  it("should correctly correlate responses using id:sig key", async () => {
    console.log = () => {};
    pool = new AnalyzePool(1);

    // Two events submitted — results should be correctly matched
    const event1 = createValidEvent("first");
    const event2 = createValidEvent("second");

    const [result1, result2] = await Promise.all([
      pool.analyze(event1),
      pool.analyze(event2),
    ]);

    assert.equal(result1.verified, true);
    assert.equal(result2.verified, true);
  });

  it("should reject pending requests on dispose", async () => {
    console.log = () => {};
    console.error = () => {};
    pool = new AnalyzePool(1);

    const event = createValidEvent();
    const promise = pool.analyze(event);

    // Dispose before the worker can respond
    pool.dispose();

    await assert.rejects(promise, {
      message: "Analyze pool disposed",
    });
  });

  it("should work with pool size of 1", async () => {
    console.log = () => {};
    pool = new AnalyzePool(1);

    const events = Array.from({ length: 5 }, (_, i) =>
      createValidEvent(`single worker ${i}`),
    );

    const results = await Promise.all(events.map((e) => pool.analyze(e)));
    assert.ok(results.every((r) => r.verified === true));
  });

  it("should detect media and video from events", async () => {
    console.log = () => {};
    pool = new AnalyzePool(1);

    // imeta with image -> media:true, no video
    const imageEvent = createValidEventWithTags(
      "Check this out https://example.com/photo.jpg",
      [["imeta", "url https://example.com/photo.jpg", "m image/jpeg"]],
    );
    const imageResult = await pool.analyze(imageEvent);
    assert.equal(imageResult.verified, true);
    assert.equal(imageResult.media, true);
    assert.equal(imageResult.video, undefined);

    // imeta with video -> media:true, video:true
    const videoEvent = createValidEventWithTags(
      "Watch this https://example.com/clip.mp4",
      [["imeta", "url https://example.com/clip.mp4", "m video/mp4"]],
    );
    const videoResult = await pool.analyze(videoEvent);
    assert.equal(videoResult.verified, true);
    assert.equal(videoResult.media, true);
    assert.equal(videoResult.video, true);

    // No media at all
    const textEvent = createValidEvent("Just a text post, no media here");
    const textResult = await pool.analyze(textEvent);
    assert.equal(textResult.verified, true);
    assert.equal(textResult.media, undefined);
    assert.equal(textResult.video, undefined);

    // URL fallback detection for kind 1 without imeta
    const urlEvent = createValidEvent(
      "Look at this https://example.com/photo.png",
    );
    const urlResult = await pool.analyze(urlEvent);
    assert.equal(urlResult.verified, true);
    assert.equal(urlResult.media, true);
  });
});
