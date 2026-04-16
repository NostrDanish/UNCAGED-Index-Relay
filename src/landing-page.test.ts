import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { NostrRelayInfo } from "@nostrify/nostrify";
import { renderLandingPage } from "./landing-page.ts";

/**
 * Silence `console.warn` during a test. Returns a `restore()` fn.
 * Most tests validate the rendered HTML; the warning noise is not relevant.
 */
function muteWarn(): () => void {
  const original = console.warn;
  console.warn = () => {};
  return () => {
    console.warn = original;
  };
}

describe("renderLandingPage", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = muteWarn();
  });
  afterEach(() => {
    restore();
  });

  describe("clean inputs", () => {
    it("renders well-formed URLs unchanged", () => {
      const html = renderLandingPage(
        {
          name: "My Relay",
          description: "A nice relay",
          banner: "https://example.com/banner.jpg",
          icon: "https://example.com/icon.png",
          software: "https://github.com/example/relay",
          contact: "mailto:admin@example.com",
        } as NostrRelayInfo,
        "wss://relay.example.com/",
      );

      assert.ok(html.includes('src="https://example.com/banner.jpg"'));
      assert.ok(html.includes('src="https://example.com/icon.png"'));
      assert.ok(html.includes('href="https://github.com/example/relay"'));
      assert.ok(html.includes('href="mailto:admin@example.com"'));
      assert.ok(html.includes('value="wss://relay.example.com/"'));
    });

    it("accepts http:// (not just https://) for URL fields", () => {
      const html = renderLandingPage(
        {
          name: "R",
          banner: "http://example.com/b.jpg",
        } as NostrRelayInfo,
        "ws://relay.example.com/",
      );
      assert.ok(html.includes('src="http://example.com/b.jpg"'));
      assert.ok(html.includes('value="ws://relay.example.com/"'));
    });
  });

  describe("XSS regressions", () => {
    it("drops javascript: banner", () => {
      const html = renderLandingPage(
        { name: "R", banner: "javascript:alert(1)" } as NostrRelayInfo,
        "wss://r.example.com/",
      );
      assert.ok(!html.includes("javascript:"));
      assert.ok(!html.includes("alert(1)"));
      // The <img> element should not be rendered at all (the .banner-img
      // CSS class still appears in the <style> block).
      assert.ok(!html.includes('<img class="banner-img"'));
    });

    it("drops javascript: icon", () => {
      const html = renderLandingPage(
        { name: "R", icon: "javascript:alert(2)" } as NostrRelayInfo,
        "wss://r.example.com/",
      );
      assert.ok(!html.includes("javascript:"));
      assert.ok(!html.includes("alert(2)"));
    });

    it("drops javascript: software", () => {
      const html = renderLandingPage(
        { name: "R", software: "javascript:alert(3)" } as NostrRelayInfo,
        "wss://r.example.com/",
      );
      assert.ok(!html.includes("javascript:"));
      assert.ok(!html.includes("alert(3)"));
      // Footer should still render the plain "Ditto Relay" text.
      assert.ok(html.includes("Ditto Relay"));
    });

    it("drops javascript: contact in mailto branch", () => {
      // Starts with "mailto:" but second URL form is malicious — URL parse
      // must reject or accept it strictly as a mailto which cannot XSS.
      const html = renderLandingPage(
        { name: "R", contact: "javascript:alert(4)" } as NostrRelayInfo,
        "wss://r.example.com/",
      );
      assert.ok(!html.includes("javascript:"));
      assert.ok(!html.includes("alert(4)"));
    });

    it("drops data: URL in banner", () => {
      const html = renderLandingPage(
        {
          name: "R",
          banner: "data:text/html,<script>alert(1)</script>",
        } as NostrRelayInfo,
        "wss://r.example.com/",
      );
      assert.ok(!html.includes("data:text/html"));
      assert.ok(!html.includes("<script>alert"));
    });

    it("drops javascript: relayUrl", () => {
      const html = renderLandingPage(
        { name: "R" } as NostrRelayInfo,
        "javascript:alert(5)",
      );
      assert.ok(!html.includes("javascript:"));
      assert.ok(!html.includes("alert(5)"));
      // The input's value attr should be empty, not carrying the bad URL.
      assert.ok(html.includes('value=""'));
    });

    it("drops file: URLs", () => {
      const html = renderLandingPage(
        { name: "R", banner: "file:///etc/passwd" } as NostrRelayInfo,
        "wss://r.example.com/",
      );
      assert.ok(!html.includes("file://"));
    });

    it("drops URLs containing embedded quotes", () => {
      // URL constructor either rejects or percent-encodes; in either case,
      // an unescaped `"` must never appear inside an href/src attribute.
      const html = renderLandingPage(
        {
          name: "R",
          banner: 'https://example.com/"><script>alert(1)</script>',
        } as NostrRelayInfo,
        "wss://r.example.com/",
      );
      assert.ok(!html.includes("<script>alert"));
    });
  });

  describe("contact formats", () => {
    it("accepts bare email via EMAIL_RE branch", () => {
      const html = renderLandingPage(
        { name: "R", contact: "admin@example.com" } as NostrRelayInfo,
        "wss://r.example.com/",
      );
      assert.ok(html.includes('href="mailto:admin@example.com"'));
    });

    it("accepts http:// contact URL", () => {
      const html = renderLandingPage(
        {
          name: "R",
          contact: "https://example.com/contact",
        } as NostrRelayInfo,
        "wss://r.example.com/",
      );
      assert.ok(html.includes('href="https://example.com/contact"'));
    });

    it("rejects fake-email with javascript: scheme", () => {
      const html = renderLandingPage(
        {
          name: "R",
          contact: "javascript:alert(1)//@example.com",
        } as NostrRelayInfo,
        "wss://r.example.com/",
      );
      // Must NOT land in a mailto: href.
      assert.ok(!html.includes("javascript:"));
      assert.ok(!html.includes("alert(1)"));
    });

    it("rejects garbage contact format", () => {
      const html = renderLandingPage(
        { name: "R", contact: "not a url or email" } as NostrRelayInfo,
        "wss://r.example.com/",
      );
      assert.ok(!html.includes("not a url or email"));
    });
  });

  describe("relay URL field", () => {
    it("accepts ws://", () => {
      const html = renderLandingPage(
        { name: "R" } as NostrRelayInfo,
        "ws://relay.example.com/",
      );
      assert.ok(html.includes('value="ws://relay.example.com/"'));
    });

    it("accepts wss://", () => {
      const html = renderLandingPage(
        { name: "R" } as NostrRelayInfo,
        "wss://relay.example.com/",
      );
      assert.ok(html.includes('value="wss://relay.example.com/"'));
    });

    it("rejects http:// for relay URL (must be ws/wss)", () => {
      const html = renderLandingPage(
        { name: "R" } as NostrRelayInfo,
        "http://relay.example.com/",
      );
      assert.ok(!html.includes("http://relay.example.com/"));
      assert.ok(html.includes('value=""'));
    });
  });

  describe("HTML escaping", () => {
    it("escapes the name field", () => {
      const html = renderLandingPage(
        { name: "<script>alert(1)</script>" } as NostrRelayInfo,
        "wss://r.example.com/",
      );
      assert.ok(!html.includes("<script>alert"));
      assert.ok(html.includes("&lt;script&gt;"));
    });

    it("escapes the description field", () => {
      const html = renderLandingPage(
        {
          name: "R",
          description: "<img src=x onerror=alert(1)>",
        } as NostrRelayInfo,
        "wss://r.example.com/",
      );
      assert.ok(!html.includes("<img src=x onerror"));
      assert.ok(html.includes("&lt;img"));
    });
  });
});
