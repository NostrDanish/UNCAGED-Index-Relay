import { strict as assert } from "node:assert";
import { after, afterEach, describe, it } from "node:test";
import type { NostrEvent } from "nostr-tools";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { AnalyzePool } from "./analyze-pool.ts";
import { AnalyzePoolOverloaded } from "./errors.ts";

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

  it("should detect sentiment for common emoji reactions via lookup table", async () => {
    console.log = () => {};
    pool = new AnalyzePool(1);

    // Hearts → positive (with and without VS16 presentation selector).
    const heart = createValidEvent("\u2764\uFE0F", 7);
    const heartResult = await pool.analyze(heart);
    assert.equal(heartResult.sentiment, "positive");

    const heartNoVs = createValidEvent("\u2764", 7);
    const heartNoVsResult = await pool.analyze(heartNoVs);
    assert.equal(heartNoVsResult.sentiment, "positive");

    // Thumbs up → positive.
    const thumbsUp = createValidEvent("\u{1F44D}", 7);
    const thumbsUpResult = await pool.analyze(thumbsUp);
    assert.equal(thumbsUpResult.sentiment, "positive");

    // Thumbs down → negative.
    const thumbsDown = createValidEvent("\u{1F44E}", 7);
    const thumbsDownResult = await pool.analyze(thumbsDown);
    assert.equal(thumbsDownResult.sentiment, "negative");

    // Crying face → negative.
    const cry = createValidEvent("\u{1F62D}", 7);
    const cryResult = await pool.analyze(cry);
    assert.equal(cryResult.sentiment, "negative");

    // Thinking → known-neutral (skip the sentiment library entirely).
    const thinking = createValidEvent("\u{1F914}", 7);
    const thinkingResult = await pool.analyze(thinking);
    assert.equal(thinkingResult.sentiment, "neutral");
  });

  it("should still handle custom emoji shortcodes as undefined sentiment", async () => {
    console.log = () => {};
    pool = new AnalyzePool(1);
    const event = createValidEvent(":soapbox:", 7);

    const result = await pool.analyze(event);
    assert.equal(result.verified, true);
    assert.equal(result.sentiment, undefined);
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

  it("should distribute work across workers", async () => {
    console.log = () => {};
    pool = new AnalyzePool(4);

    // Analyze enough events that all 4 workers get used
    const events = Array.from({ length: 8 }, (_, i) =>
      createValidEvent(`distribute ${i}`),
    );

    const results = await Promise.all(events.map((e) => pool.analyze(e)));
    assert.ok(results.every((r) => r.verified === true));
  });

  it("should correctly correlate responses across distinct events", async () => {
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

  it("should resolve both promises when the same event is submitted concurrently", async () => {
    console.log = () => {};
    pool = new AnalyzePool(1);

    // Submit the identical event object twice in parallel. Before the
    // reqId-based correlation fix, the second call overwrote the first
    // in the pending map (keyed by `${id}:${sig}`), causing one promise
    // to hang forever. Both must now resolve independently.
    const event = createValidEvent("duplicate submission");

    const [result1, result2] = await Promise.all([
      pool.analyze(event),
      pool.analyze(event),
    ]);

    assert.equal(result1.verified, true);
    assert.equal(result2.verified, true);
  });

  it("should resolve all promises when the same event is submitted many times concurrently", async () => {
    console.log = () => {};
    pool = new AnalyzePool(2);

    const event = createValidEvent("highly duplicated submission");
    const promises = Array.from({ length: 10 }, () => pool.analyze(event));

    const results = await Promise.all(promises);
    assert.equal(results.length, 10);
    assert.ok(results.every((r) => r.verified === true));
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

  it("should throw AnalyzePoolOverloaded when pending exceeds maxPending", async () => {
    console.log = () => {};
    // 1 worker so we can stall it predictably; tiny cap of 2.
    pool = new AnalyzePool(1, { maxPending: 2 });

    // Fire two requests; both go into the queue, then become inflight after
    // setImmediate-scheduled flush. Don't await — we want them pending so the
    // third call sees pendingCount === maxPending and throws.
    const p1 = pool.analyze(createValidEvent("first"));
    const p2 = pool.analyze(createValidEvent("second"));

    // pendingCount is 2 right now (both still in pending Map until worker
    // responds). The third call must throw synchronously.
    assert.equal(pool.pendingCount, 2);
    assert.throws(
      () => pool.analyze(createValidEvent("third")),
      AnalyzePoolOverloaded,
    );

    // First two still resolve normally — backpressure doesn't poison them.
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.verified, true);
    assert.equal(r2.verified, true);

    // After they resolve, the pool accepts new work again.
    const r3 = await pool.analyze(createValidEvent("third again"));
    assert.equal(r3.verified, true);
  });

  it("should batch multiple analyze() calls in one tick into one postMessage", async () => {
    // Spy on a worker's postMessage to count batches.  We use a pool size
    // of 1 so all requests land on the same worker; with setImmediate-based
    // flushing, sync-back-to-back enqueues should fan out as one batch.
    console.log = () => {};
    pool = new AnalyzePool(1);

    // biome-ignore lint/suspicious/noExplicitAny: test-only access to private worker
    const worker = (pool as any).workers[0] as Worker;
    const originalPost = worker.postMessage.bind(worker);
    let postCount = 0;
    let lastBatchSize = 0;
    worker.postMessage = (msg: unknown) => {
      postCount++;
      if (Array.isArray(msg)) lastBatchSize = msg.length;
      return originalPost(msg);
    };

    const events = Array.from({ length: 5 }, (_, i) =>
      createValidEvent(`batch ${i}`),
    );
    // Fire all 5 synchronously in the same tick — no await between them.
    const promises = events.map((e) => pool.analyze(e));

    const results = await Promise.all(promises);
    assert.ok(results.every((r) => r.verified === true));

    // All 5 should have gone in a single postMessage call.
    assert.equal(postCount, 1, "expected single batched postMessage");
    assert.equal(lastBatchSize, 5);
  });

  it("should use least-loaded dispatch when one worker is busier", async () => {
    // Two workers; we manually skew the queue/inflight to make worker 1 the
    // less-loaded choice, then verify the next analyze() lands on worker 1.
    console.log = () => {};
    pool = new AnalyzePool(2);

    // biome-ignore lint/suspicious/noExplicitAny: test-only access
    const p = pool as any;

    // Simulate worker 0 having 3 inflight; worker 1 idle.
    p.inflight[0] = 3;
    p.inflight[1] = 0;

    const ev = createValidEvent("least-loaded");
    const promise = pool.analyze(ev);

    // queues[1] should now hold the request; queues[0] empty.
    assert.equal(p.queues[0].length, 0);
    assert.equal(p.queues[1].length, 1);

    // Reset inflight so the worker-response handler doesn't underflow.
    p.inflight[0] = 0;

    // Await the dispatched analysis so the promise isn't left dangling
    // (afterEach disposes the pool, which rejects any leftover pending).
    const result = await promise;
    assert.equal(result.verified, true);
  });
});
