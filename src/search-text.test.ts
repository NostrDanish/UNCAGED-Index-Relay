import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildSearchText } from "./search-text.ts";

/** Helper to create a minimal event-like object. */
function event(kind: number, content: string, tags: string[][] = []) {
  return { id: "a", pubkey: "b", created_at: 0, kind, tags, content, sig: "c" };
}

describe("buildSearchText", () => {
  describe("plaintext content kinds", () => {
    it("should return content for kind 1 (short text note)", () => {
      assert.equal(buildSearchText(event(1, "Hello world")), "Hello world");
    });

    it("should return content for kind 30023 (long-form content)", () => {
      const markdown = "# Article\n\nThis is a long article.";
      assert.equal(buildSearchText(event(30023, markdown)), markdown);
    });

    it("should return content for various text kinds", () => {
      for (const kind of [1, 9, 11, 42, 1111, 1311, 20, 21, 22, 1068, 9802]) {
        assert.ok(
          buildSearchText(event(kind, "some text")).includes("some text"),
          `kind ${kind} should include content`,
        );
      }
    });

    it("should return empty string when content is empty", () => {
      assert.equal(buildSearchText(event(1, "")), "");
    });
  });

  describe("skipped content kinds", () => {
    it("should ignore content for kind 3 (follow list)", () => {
      assert.equal(buildSearchText(event(3, "some leftover content")), "");
    });

    it("should index content for kind 5 (deletion reason)", () => {
      assert.equal(
        buildSearchText(event(5, "these posts were published by accident")),
        "these posts were published by accident",
      );
    });

    it("should ignore content for kind 6 (repost)", () => {
      const stringifiedEvent = JSON.stringify({
        id: "abc",
        content: "original post text",
      });
      assert.equal(buildSearchText(event(6, stringifiedEvent)), "");
    });

    it("should index content for kind 7 (reaction emoji)", () => {
      assert.equal(buildSearchText(event(7, "🔥")), "🔥");
    });

    it("should ignore content for kind 16 (generic repost)", () => {
      const stringifiedEvent = JSON.stringify({
        id: "abc",
        content: "original post text",
      });
      assert.equal(buildSearchText(event(16, stringifiedEvent)), "");
    });

    it("should ignore content for kind 4 (encrypted DM)", () => {
      assert.equal(
        buildSearchText(
          event(4, "HGm567PuoNQ08syARjPY==?iv=AD78LxC/6KBYsFL5qPurow=="),
        ),
        "",
      );
    });

    it("should ignore content for kind 13 (seal)", () => {
      assert.equal(buildSearchText(event(13, "AqBCdwoS7/tPK+QGk...")), "");
    });

    it("should ignore content for kind 1059 (gift wrap)", () => {
      assert.equal(buildSearchText(event(1059, "nblI0zRc7HfFOTRJ...")), "");
    });

    it("should ignore content for NIP-37 kinds", () => {
      assert.equal(buildSearchText(event(10013, "encrypted-relay-list")), "");
      assert.equal(buildSearchText(event(31234, "encrypted-draft-event")), "");
    });

    it("should ignore content for NIP-51 standard lists", () => {
      const nip51StandardKinds = [
        10000, 10001, 10002, 10003, 10004, 10005, 10006, 10007, 10009, 10012,
        10015, 10020, 10030, 10050, 10101, 10102,
      ];
      for (const kind of nip51StandardKinds) {
        assert.equal(
          buildSearchText(event(kind, "encrypted-or-empty-content")),
          "",
          `kind ${kind} content should be skipped`,
        );
      }
    });

    it("should ignore content for NIP-51 sets", () => {
      const nip51SetKinds = [
        30000, 30002, 30003, 30004, 30005, 30006, 30007, 30015, 30030, 31924,
        39089, 39092,
      ];
      for (const kind of nip51SetKinds) {
        assert.equal(
          buildSearchText(event(kind, "encrypted-or-empty-content")),
          "",
          `kind ${kind} content should be skipped`,
        );
      }
    });

    it("should ignore content for kind 9735 (zap receipt)", () => {
      assert.equal(buildSearchText(event(9735, "")), "");
    });

    it("should still extract searchable tags for skipped content kinds", () => {
      const result = buildSearchText(
        event(6, '{"id":"abc","content":"hello"}', [["subject", "Cool post"]]),
      );
      assert.equal(result, "Cool post");
    });

    it("should extract searchable tags from NIP-51 sets", () => {
      const result = buildSearchText(
        event(30004, "", [
          ["d", "jvdy9i4"],
          ["title", "Yaks"],
          ["description", "The domestic yak"],
        ]),
      );
      assert.equal(result, "Yaks\nThe domestic yak");
    });
  });

  describe("JSON content kinds", () => {
    it("should extract name and about from kind 0 (user metadata)", () => {
      const content = JSON.stringify({
        name: "alice",
        about: "Nostr enthusiast",
        picture: "https://example.com/pic.jpg",
      });
      assert.equal(
        buildSearchText(event(0, content)),
        "alice\nNostr enthusiast",
      );
    });

    it("should extract display_name from kind 0", () => {
      const content = JSON.stringify({
        name: "alice",
        display_name: "Alice Wonderland",
      });
      assert.equal(
        buildSearchText(event(0, content)),
        "alice\nAlice Wonderland",
      );
    });

    it("should not extract nip05 from kind 0", () => {
      const content = JSON.stringify({
        name: "alice",
        nip05: "alice@example.com",
      });
      assert.equal(buildSearchText(event(0, content)), "alice");
    });

    it("should extract title and description from kind 39697 (SIP-01 web index observation)", () => {
      const content = JSON.stringify({
        title: "Example Page",
        description: "A page about examples",
        image: "https://example.com/og.jpg",
      });
      assert.equal(
        buildSearchText(event(39697, content)),
        "Example Page\nA page about examples",
      );
    });

    it("should extract name and about from kind 40 (channel creation)", () => {
      const content = JSON.stringify({
        name: "Bitcoin Chat",
        about: "Discuss Bitcoin",
        picture: "https://example.com/btc.jpg",
      });
      assert.equal(
        buildSearchText(event(40, content)),
        "Bitcoin Chat\nDiscuss Bitcoin",
      );
    });

    it("should extract name and about from kind 41 (channel metadata)", () => {
      const content = JSON.stringify({
        name: "Updated Channel",
        about: "New description",
      });
      assert.equal(
        buildSearchText(event(41, content)),
        "Updated Channel\nNew description",
      );
    });

    it("should extract name and description from kind 30017 (stall)", () => {
      const content = JSON.stringify({
        name: "Alice's Shop",
        description: "Handmade goods",
        currency: "sat",
      });
      assert.equal(
        buildSearchText(event(30017, content)),
        "Alice's Shop\nHandmade goods",
      );
    });

    it("should extract name and description from kind 30018 (product)", () => {
      const content = JSON.stringify({
        name: "Lightning Cable",
        description: "USB-C charging cable",
        price: 2100,
      });
      assert.equal(
        buildSearchText(event(30018, content)),
        "Lightning Cable\nUSB-C charging cable",
      );
    });

    it("should handle malformed JSON gracefully", () => {
      assert.equal(buildSearchText(event(0, "not json")), "");
    });

    it("should handle JSON with no searchable fields", () => {
      const content = JSON.stringify({
        picture: "https://example.com/pic.jpg",
      });
      assert.equal(buildSearchText(event(0, content)), "");
    });

    it("should skip non-string fields in JSON", () => {
      const content = JSON.stringify({ name: 123, about: true });
      assert.equal(buildSearchText(event(0, content)), "");
    });
  });

  describe("tag extraction (kind-agnostic)", () => {
    it("should extract title tag", () => {
      const result = buildSearchText(
        event(30023, "Article body", [["title", "My Article"]]),
      );
      assert.equal(result, "Article body\nMy Article");
    });

    it("should extract name tag", () => {
      const result = buildSearchText(
        event(34550, "", [
          ["d", "bitcoin"],
          ["name", "Bitcoin Community"],
        ]),
      );
      assert.equal(result, "Bitcoin Community");
    });

    it("should extract description tag", () => {
      const result = buildSearchText(
        event(34550, "", [
          ["description", "A community for Bitcoin discussion"],
        ]),
      );
      assert.equal(result, "A community for Bitcoin discussion");
    });

    it("should extract summary tag", () => {
      const result = buildSearchText(
        event(30311, "", [
          ["title", "Live Stream"],
          ["summary", "Weekly Bitcoin meetup"],
        ]),
      );
      assert.equal(result, "Live Stream\nWeekly Bitcoin meetup");
    });

    it("should extract location tag", () => {
      const result = buildSearchText(
        event(31922, "Event details", [
          ["title", "Conference"],
          ["location", "Prague"],
        ]),
      );
      assert.equal(result, "Event details\nConference\nPrague");
    });

    it("should extract subject tag", () => {
      const result = buildSearchText(
        event(1621, "Bug description", [["subject", "Fix login issue"]]),
      );
      assert.equal(result, "Bug description\nFix login issue");
    });

    it("should extract about tag", () => {
      const result = buildSearchText(
        event(39000, "", [
          ["name", "Dev Group"],
          ["about", "Developer community"],
        ]),
      );
      assert.equal(result, "Dev Group\nDeveloper community");
    });

    it("should extract multiple searchable tags", () => {
      const result = buildSearchText(
        event(30402, "Selling my car", [
          ["title", "2020 Tesla Model 3"],
          ["summary", "Low mileage, great condition"],
          ["location", "Austin, TX"],
        ]),
      );
      assert.equal(
        result,
        "Selling my car\n2020 Tesla Model 3\nLow mileage, great condition\nAustin, TX",
      );
    });

    it("should skip non-searchable tags", () => {
      const result = buildSearchText(
        event(1, "Hello", [
          ["e", "abc123"],
          ["p", "def456"],
          ["t", "bitcoin"],
          ["relay", "wss://relay.example.com"],
        ]),
      );
      assert.equal(result, "Hello");
    });

    it("should skip tags with empty values", () => {
      const result = buildSearchText(
        event(1, "Hello", [
          ["title", ""],
          ["name", ""],
        ]),
      );
      assert.equal(result, "Hello");
    });

    it("should skip tags with fewer than 2 elements", () => {
      const result = buildSearchText(event(1, "Hello", [["title"]]));
      assert.equal(result, "Hello");
    });

    it("should combine JSON content fields with tags for JSON kinds", () => {
      const content = JSON.stringify({ name: "Alice's Shop" });
      const result = buildSearchText(
        event(30017, content, [["title", "Featured Stall"]]),
      );
      assert.equal(result, "Alice's Shop\nFeatured Stall");
    });
  });

  describe("NIP-72 community (kind 34550) via generic tag extraction", () => {
    it("should extract name and description from tags", () => {
      const result = buildSearchText(
        event(34550, "", [
          ["d", "bitcoin"],
          ["name", "Bitcoin Enthusiasts"],
          ["description", "A community for Bitcoin discussion"],
          ["image", "https://example.com/logo.png"],
          ["p", "aaa", "", "moderator"],
        ]),
      );
      assert.equal(
        result,
        "Bitcoin Enthusiasts\nA community for Bitcoin discussion",
      );
    });

    it("should handle community with only a name tag", () => {
      const result = buildSearchText(
        event(34550, "", [
          ["d", "nostr"],
          ["name", "Nostr Community"],
        ]),
      );
      assert.equal(result, "Nostr Community");
    });

    it("should return empty for community with no searchable tags", () => {
      const result = buildSearchText(event(34550, "", [["d", "empty"]]));
      assert.equal(result, "");
    });
  });

  describe("unknown kind auto-detection", () => {
    it("should treat plaintext content as text for unknown kinds", () => {
      assert.equal(
        buildSearchText(event(99999, "Hello from the future")),
        "Hello from the future",
      );
    });

    it("should extract JSON fields from unknown kinds with JSON content", () => {
      const content = JSON.stringify({
        name: "New Thing",
        description: "A cool thing",
        unrelated: "ignored",
      });
      assert.equal(
        buildSearchText(event(99999, content)),
        "New Thing\nA cool thing",
      );
    });

    it("should skip JSON content with no searchable fields for unknown kinds", () => {
      const content = JSON.stringify({ id: "abc", type: "something" });
      assert.equal(buildSearchText(event(99999, content)), "");
    });

    it("should skip base64 content for unknown kinds", () => {
      const base64 =
        "TJob1dQrf2ndsmdbeGU+05HT5GMnBSx3fx8QdDY/g3NvCa7klfzgaQCmRZuo1d3WQjHDOjzSY1+MgTK5WjewFFumCcOZniWtOMSga9tJk1ky00tLoUUzyLnb1v9x95h/iT/KpkICJyAwUZ+LoJBUzLrK52wNTMt8M5jSLvCkRx8C0BmEwA/00pjOp4eRndy19H4WUUehhjfV2/VV/k4hMAjJ7Bb5Hp9xdmzmCLX9+64+MyeIQQjQAHPj8dkSsRahP7KS3MgMpjaF8nL48Bg5suZMxJayXGVp3BLtgRZx5z5nOk9xyrYk+71e2tnP9IDvSMkiSe76BcMct+m7kGVrRcavDI4n62goNNh25IpghT+a1OjjkpXt9me5wmaL7fxffV1pchdm+A7KJKIUU3kLC7QbUifF22EucRA9xiEyxETusNludBXN24O3llTbOy4vYFsq35BeZl4v1Cse7n2htZicVkItMz3wjzj1q1I1VqbnorNXFgllkRZn4/YXfTG/RMnoK/bDogRapOV+XToZ+IvsN0BqwKSUDx+ydKpci6htDRF2WDRkU+VQMqwM0CoLzy2H6A2cqyMMMD9SLRRzBg==";
      assert.equal(buildSearchText(event(99999, base64)), "");
    });

    it("should skip NIP-04 style base64 with iv parameter", () => {
      const nip04 =
        "HGm567PuoNQ08syARjPYKCKLfT0C6xGNFcjAKKYc+RXhIKl3AnxPFrFBxXQykkhzpMcfG6qJxqv9SDEReaZIQw==?iv=AD78LxC/6KBYsFL5qPurow==";
      assert.equal(buildSearchText(event(99999, nip04)), "");
    });

    it("should not treat short base64-like strings as base64", () => {
      // "Hello World" is valid base64 chars but too short to trigger detection
      assert.equal(buildSearchText(event(99999, "HelloWorld")), "HelloWorld");
    });

    it("should still extract tags for unknown kinds with base64 content", () => {
      const base64 = "A".repeat(64);
      const result = buildSearchText(
        event(99999, base64, [["title", "Some Title"]]),
      );
      assert.equal(result, "Some Title");
    });

    it("should treat content with spaces as plaintext even if chars are base64-valid", () => {
      assert.equal(
        buildSearchText(event(99999, "This is normal text with spaces")),
        "This is normal text with spaces",
      );
    });
  });

  describe("truncation", () => {
    it("should truncate search text to 8000 characters", () => {
      const longContent = "x".repeat(10000);
      const result = buildSearchText(event(1, longContent));
      assert.equal(result.length, 8000);
    });

    it("should not truncate text under the limit", () => {
      const content = "x".repeat(7999);
      const result = buildSearchText(event(1, content));
      assert.equal(result.length, 7999);
    });

    it("should truncate combined content + tags", () => {
      const content = "x".repeat(7990);
      const result = buildSearchText(
        event(1, content, [["title", "y".repeat(100)]]),
      );
      // 7990 + \n + 100 = 8091, truncated to 8000
      assert.equal(result.length, 8000);
    });
  });
});
