import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildAutocompleteText,
  MAX_AUTOCOMPLETE_TEXT_LENGTH,
} from "./autocomplete-text.ts";

/** Helper to create a minimal event-like object. */
function event(kind: number, content: string, tags: string[][] = []) {
  return { id: "a", pubkey: "b", created_at: 0, kind, tags, content, sig: "c" };
}

describe("buildAutocompleteText", () => {
  describe("kind 0 (user metadata)", () => {
    it("extracts name", () => {
      const content = JSON.stringify({ name: "alice" });
      assert.equal(buildAutocompleteText(event(0, content)), "alice");
    });

    it("extracts display_name", () => {
      const content = JSON.stringify({ display_name: "Alice Wonderland" });
      assert.equal(
        buildAutocompleteText(event(0, content)),
        "Alice Wonderland",
      );
    });

    it("extracts nip05", () => {
      const content = JSON.stringify({ nip05: "alice@example.com" });
      assert.equal(
        buildAutocompleteText(event(0, content)),
        "alice@example.com",
      );
    });

    it("combines name, display_name, nip05", () => {
      const content = JSON.stringify({
        name: "alice",
        display_name: "Alice Wonderland",
        nip05: "alice@example.com",
      });
      assert.equal(
        buildAutocompleteText(event(0, content)),
        "alice Alice Wonderland alice@example.com",
      );
    });

    it("ignores about and other unrelated fields", () => {
      const content = JSON.stringify({
        name: "alice",
        about: "a long biography that should not be autocompleted",
        picture: "https://example.com/a.jpg",
      });
      assert.equal(buildAutocompleteText(event(0, content)), "alice");
    });

    it("returns empty string for invalid JSON", () => {
      assert.equal(buildAutocompleteText(event(0, "not json")), "");
    });

    it("extracts the page title from kind 39697 (SIP-01) content JSON", () => {
      const content = JSON.stringify({
        title: "Example Page",
        description: "Not autocompleted",
      });
      assert.equal(buildAutocompleteText(event(39697, content)), "Example Page");
    });

    it("skips widx: d tags (URL identity hashes, not slugs)", () => {
      const content = JSON.stringify({ title: "Example Page" });
      const tags = [
        ["d", "widx:9f86d081884c7d659a2feaa0c55ad015"],
        ["u", "https://example.com/"],
      ];
      assert.equal(
        buildAutocompleteText(event(39697, content, tags)),
        "Example Page",
      );
    });

    it("keeps ordinary d-tag slugs for other kinds", () => {
      assert.equal(
        buildAutocompleteText(event(30023, "", [["d", "my-article"]])),
        "my-article",
      );
    });

    it("returns empty string when no relevant fields are present", () => {
      const content = JSON.stringify({ picture: "https://example.com/a.jpg" });
      assert.equal(buildAutocompleteText(event(0, content)), "");
    });

    it("ignores non-string field values", () => {
      const content = JSON.stringify({ name: 42, display_name: null });
      assert.equal(buildAutocompleteText(event(0, content)), "");
    });
  });

  describe("channel kinds (NIP-28)", () => {
    it("extracts name from kind 40", () => {
      const content = JSON.stringify({
        name: "general",
        about: "general chat",
      });
      assert.equal(buildAutocompleteText(event(40, content)), "general");
    });

    it("extracts name from kind 41", () => {
      const content = JSON.stringify({ name: "renamed-channel" });
      assert.equal(
        buildAutocompleteText(event(41, content)),
        "renamed-channel",
      );
    });
  });

  describe("marketplace kinds (NIP-15)", () => {
    it("extracts name from kind 30017 (stall)", () => {
      const content = JSON.stringify({
        name: "Cool Shop",
        description: "stuff",
      });
      assert.equal(buildAutocompleteText(event(30017, content)), "Cool Shop");
    });

    it("extracts name from kind 30018 (product)", () => {
      const content = JSON.stringify({ name: "Widget" });
      assert.equal(buildAutocompleteText(event(30018, content)), "Widget");
    });
  });

  describe("tag-derived autocomplete", () => {
    it("includes the title tag", () => {
      const result = buildAutocompleteText(
        event(30023, "long article body", [["title", "My Article"]]),
      );
      assert.equal(result, "My Article");
    });

    it("includes the name tag", () => {
      const result = buildAutocompleteText(
        event(99999, "", [["name", "weather-bot"]]),
      );
      assert.equal(result, "weather-bot");
    });

    it("includes the subject tag", () => {
      const result = buildAutocompleteText(
        event(1, "body", [["subject", "Re: hello"]]),
      );
      assert.equal(result, "Re: hello");
    });

    it("includes the d tag (addressable identifier)", () => {
      const result = buildAutocompleteText(
        event(30000, "", [["d", "my-follow-set"]]),
      );
      assert.equal(result, "my-follow-set");
    });

    it("combines kind 0 JSON fields with tags", () => {
      const content = JSON.stringify({ name: "alice" });
      const result = buildAutocompleteText(
        event(0, content, [["title", "fallback-name"]]),
      );
      assert.equal(result, "alice fallback-name");
    });

    it("ignores tags with no value", () => {
      assert.equal(buildAutocompleteText(event(99999, "", [["title"]])), "");
    });

    it("ignores irrelevant tags", () => {
      const result = buildAutocompleteText(
        event(1, "body", [
          ["e", "abc"],
          ["p", "def"],
        ]),
      );
      assert.equal(result, "");
    });
  });

  describe("kinds without autocomplete surface", () => {
    it("returns empty for kind 1 (no tags)", () => {
      assert.equal(buildAutocompleteText(event(1, "Hello world")), "");
    });

    it("returns empty for kind 7 (reaction)", () => {
      assert.equal(buildAutocompleteText(event(7, "🔥")), "");
    });

    it("returns empty for unknown kind with no relevant tags", () => {
      assert.equal(buildAutocompleteText(event(99999, "anything")), "");
    });
  });

  describe("length cap", () => {
    it("truncates output to MAX_AUTOCOMPLETE_TEXT_LENGTH", () => {
      const longTitle = "a".repeat(MAX_AUTOCOMPLETE_TEXT_LENGTH + 200);
      const result = buildAutocompleteText(
        event(1, "", [["title", longTitle]]),
      );
      assert.equal(result.length, MAX_AUTOCOMPLETE_TEXT_LENGTH);
    });
  });
});
