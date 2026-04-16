import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { NostrEvent } from "nostr-tools";
import { detectMedia } from "./media.ts";

/** Build a minimal NostrEvent for testing. */
function mkEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "0".repeat(64),
    pubkey: "1".repeat(64),
    created_at: 0,
    kind: 1,
    tags: [],
    content: "",
    sig: "2".repeat(128),
    ...overrides,
  };
}

describe("detectMedia", () => {
  describe("imeta tags (primary)", () => {
    it("detects image from imeta", () => {
      const event = mkEvent({
        tags: [["imeta", "url https://example.com/cat.jpg", "m image/jpeg"]],
      });
      assert.deepEqual(detectMedia(event), { media: true });
    });

    it("flags video when all imeta are video/*", () => {
      const event = mkEvent({
        tags: [
          ["imeta", "url https://example.com/a.mp4", "m video/mp4"],
          ["imeta", "url https://example.com/b.webm", "m video/webm"],
        ],
      });
      assert.deepEqual(detectMedia(event), { media: true, video: true });
    });

    it("does not flag video when mixed", () => {
      const event = mkEvent({
        tags: [
          ["imeta", "url https://example.com/a.mp4", "m video/mp4"],
          ["imeta", "url https://example.com/b.jpg", "m image/jpeg"],
        ],
      });
      assert.deepEqual(detectMedia(event), { media: true });
    });

    it("returns empty when no imeta has a url", () => {
      const event = mkEvent({
        tags: [["imeta", "m image/jpeg"]],
      });
      assert.deepEqual(detectMedia(event), {});
    });
  });

  describe("content fallback (kind 1 only)", () => {
    it("detects image URL in content", () => {
      const event = mkEvent({
        content: "hey check this https://example.com/pic.jpg out",
      });
      assert.deepEqual(detectMedia(event), { media: true });
    });

    it("detects video URL in content", () => {
      const event = mkEvent({
        content: "https://example.com/clip.mp4",
      });
      assert.deepEqual(detectMedia(event), { media: true, video: true });
    });

    it("ignores non-media URLs", () => {
      const event = mkEvent({
        content: "https://example.com/page.html",
      });
      assert.deepEqual(detectMedia(event), {});
    });

    it("ignores plain text with no URLs", () => {
      const event = mkEvent({
        content: "just a regular note, no media here",
      });
      assert.deepEqual(detectMedia(event), {});
    });

    it("handles URL with query string", () => {
      const event = mkEvent({
        content: "https://example.com/pic.jpg?v=2",
      });
      assert.deepEqual(detectMedia(event), { media: true });
    });

    it("handles URL with fragment", () => {
      const event = mkEvent({
        content: "https://example.com/pic.png#section",
      });
      assert.deepEqual(detectMedia(event), { media: true });
    });

    it("does not use fallback for non-kind-1 events", () => {
      const event = mkEvent({
        kind: 30023,
        content: "https://example.com/pic.jpg",
      });
      assert.deepEqual(detectMedia(event), {});
    });

    it("does not use fallback when imeta tags are present", () => {
      const event = mkEvent({
        tags: [["imeta", "url https://x.com/a.mp4", "m video/mp4"]],
        content: "https://example.com/pic.jpg",
      });
      // imeta wins; video flag comes from the imeta tag, not content
      assert.deepEqual(detectMedia(event), { media: true, video: true });
    });

    it("detects multiple URLs in one note", () => {
      const event = mkEvent({
        content:
          "two clips https://example.com/a.mp4 and https://example.com/b.webm here",
      });
      assert.deepEqual(detectMedia(event), { media: true, video: true });
    });
  });

  describe("DoS defenses", () => {
    it("completes quickly on pathological input (ReDoS regression)", () => {
      // Adversarial input that tortured the previous unanchored global regex.
      // Must complete well under 50ms on any reasonable machine.
      const event = mkEvent({
        content: `http://${"a".repeat(100_000)}`,
      });
      const start = performance.now();
      detectMedia(event);
      const elapsed = performance.now() - start;
      assert.ok(
        elapsed < 50,
        `detectMedia took ${elapsed.toFixed(2)}ms on adversarial input (budget: 50ms)`,
      );
    });

    it("completes quickly when content is many dots (tokenized path)", () => {
      const event = mkEvent({
        content: `http://${"a.".repeat(20_000)}b`,
      });
      const start = performance.now();
      detectMedia(event);
      const elapsed = performance.now() - start;
      assert.ok(
        elapsed < 50,
        `detectMedia took ${elapsed.toFixed(2)}ms on dotted input (budget: 50ms)`,
      );
    });

    it("ignores URLs past the 32 KB scan cap", () => {
      // URL sits past the cap — should be invisible.
      const filler = "x ".repeat(20_000); // ~40 KB of harmless tokens
      const event = mkEvent({
        content: `${filler}https://example.com/pic.jpg`,
      });
      assert.deepEqual(detectMedia(event), {});
    });

    it("still detects URLs near the start when content is huge", () => {
      const event = mkEvent({
        content: `https://example.com/pic.jpg ${"x ".repeat(20_000)}`,
      });
      assert.deepEqual(detectMedia(event), { media: true });
    });
  });
});
