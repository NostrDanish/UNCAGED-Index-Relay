import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  domainHierarchy,
  extractWebDocumentFields,
  normalizeIndexUrl,
  parseWebDocumentContent,
  searchHostValue,
  validateWebDocument,
  WEB_DOCUMENT_KIND,
  webDocumentContentHash,
  webDocumentDTag,
  webDocumentLanguage,
} from "./web-document.ts";

/** Helper to create a minimal event-like object. */
function event(kind: number, content: string, tags: string[][] = []) {
  return {
    id: "a",
    pubkey: "b",
    created_at: 1_700_000_000,
    kind,
    tags,
    content,
    sig: "c",
  };
}

/**
 * Helper: a minimal VALID SIP-01 web index observation for the given URL.
 * Content JSON carries the title (required) and any description.
 */
function webDoc(
  url: string,
  extraTags: string[][] = [],
  title = "Example Page",
  description?: string,
) {
  const normalized = normalizeIndexUrl(url);
  assert.ok(normalized, `test URL should normalize: ${url}`);
  return event(
    WEB_DOCUMENT_KIND,
    JSON.stringify({
      title,
      ...(description !== undefined && { description }),
    }),
    [
      ["d", webDocumentDTag(normalized)],
      ["u", url],
      ["v", "1"],
      ["alt", `Web index observation: ${title}`],
      ...extraTags,
    ],
  );
}

describe("normalizeIndexUrl (SIP-01 §8)", () => {
  it("lowercases scheme and host", () => {
    assert.equal(
      normalizeIndexUrl("HTTPS://Example.COM/Page"),
      "https://example.com/Page",
    );
  });

  it("strips a leading www.", () => {
    assert.equal(
      normalizeIndexUrl("https://www.example.com/a"),
      "https://example.com/a",
    );
  });

  it("strips default ports but keeps non-default ones", () => {
    assert.equal(
      normalizeIndexUrl("https://example.com:443/a"),
      "https://example.com/a",
    );
    assert.equal(
      normalizeIndexUrl("http://example.com:80/a"),
      "http://example.com/a",
    );
    assert.equal(
      normalizeIndexUrl("http://localhost:8000/a"),
      "http://localhost:8000/a",
    );
  });

  it("removes the fragment", () => {
    assert.equal(
      normalizeIndexUrl("https://example.com/a#section"),
      "https://example.com/a",
    );
  });

  it("removes tracking parameters and preserves the rest", () => {
    assert.equal(
      normalizeIndexUrl("https://example.com/a?utm_source=x&id=42&fbclid=abc"),
      "https://example.com/a?id=42",
    );
  });

  it("sorts query parameters alphabetically by key", () => {
    assert.equal(
      normalizeIndexUrl("https://example.com/a?b=2&a=1&c=3"),
      "https://example.com/a?a=1&b=2&c=3",
    );
  });

  it("removes a trailing slash from the path (but keeps the root)", () => {
    assert.equal(
      normalizeIndexUrl("https://example.com/a/"),
      "https://example.com/a",
    );
    assert.equal(
      normalizeIndexUrl("https://example.com"),
      "https://example.com/",
    );
  });

  it("preserves path case and non-tracking params", () => {
    assert.equal(
      normalizeIndexUrl("https://example.com/Path?q=BitCoin"),
      "https://example.com/Path?q=BitCoin",
    );
  });

  it("rejects non-http(s) schemes and non-URLs", () => {
    assert.equal(normalizeIndexUrl("ftp://example.com/a"), undefined);
    assert.equal(normalizeIndexUrl("javascript:alert(1)"), undefined);
    assert.equal(normalizeIndexUrl("data:text/html,x"), undefined);
    assert.equal(normalizeIndexUrl("not a url"), undefined);
    assert.equal(normalizeIndexUrl("example.com"), undefined);
  });
});

describe("webDocumentDTag (SIP-01 §4)", () => {
  it("is widx: + sha256(url)[0:32]", () => {
    const url = "https://example.com/page";
    const hash = createHash("sha256")
      .update(url, "utf8")
      .digest("hex")
      .slice(0, 32);
    assert.equal(webDocumentDTag(url), `widx:${hash}`);
  });

  it("is identical for URLs that normalize to the same string", () => {
    const n1 = normalizeIndexUrl("https://www.example.com/page#x");
    const n2 = normalizeIndexUrl("https://example.com/page?utm_source=y");
    assert.ok(n1);
    assert.ok(n2);
    assert.equal(webDocumentDTag(n1), webDocumentDTag(n2));
  });
});

describe("webDocumentContentHash (SIP-01 §9)", () => {
  it("is sha256(title + \\n + description)", () => {
    const expected = createHash("sha256")
      .update("Title\nDescription", "utf8")
      .digest("hex");
    assert.equal(webDocumentContentHash("Title", "Description"), expected);
  });

  it("treats a missing description as empty string", () => {
    const expected = createHash("sha256")
      .update("Title\n", "utf8")
      .digest("hex");
    assert.equal(webDocumentContentHash("Title"), expected);
  });
});

describe("domainHierarchy", () => {
  it("returns host plus dotted parents", () => {
    assert.deepEqual(domainHierarchy("docs.github.com"), [
      "docs.github.com",
      "github.com",
    ]);
  });

  it("returns just the host for a registrable domain", () => {
    assert.deepEqual(domainHierarchy("github.com"), ["github.com"]);
  });

  it("excludes the bare TLD", () => {
    assert.deepEqual(domainHierarchy("a.b.co.uk"), [
      "a.b.co.uk",
      "b.co.uk",
      "co.uk",
    ]);
  });

  it("returns just the host for single-label hosts and IPs", () => {
    assert.deepEqual(domainHierarchy("localhost"), ["localhost"]);
    assert.deepEqual(domainHierarchy("127.0.0.1"), ["127.0.0.1"]);
    assert.deepEqual(domainHierarchy("[::1]"), ["[::1]"]);
  });
});

describe("parseWebDocumentContent", () => {
  it("parses title/description/image", () => {
    assert.deepEqual(
      parseWebDocumentContent(
        JSON.stringify({
          title: "T",
          description: "D",
          image: "https://example.com/i.jpg",
        }),
      ),
      { title: "T", description: "D", image: "https://example.com/i.jpg" },
    );
  });

  it("rejects non-JSON, non-object, and title-less content", () => {
    assert.equal(parseWebDocumentContent("not json"), undefined);
    assert.equal(parseWebDocumentContent('["array"]'), undefined);
    assert.equal(parseWebDocumentContent('{"description":"D"}'), undefined);
    assert.equal(parseWebDocumentContent('{"title":42}'), undefined);
  });
});

describe("validateWebDocument (SIP-01)", () => {
  it("ignores other kinds", () => {
    assert.equal(validateWebDocument(event(1, "hi")), undefined);
  });

  it("accepts a minimal valid observation (required fields only)", () => {
    assert.equal(
      validateWebDocument(webDoc("https://example.com/")),
      undefined,
    );
  });

  it("accepts a fully populated observation", () => {
    const title = "Example Page";
    const description = "A page about examples";
    const doc = webDoc(
      "https://example.com/page",
      [
        ["t", "nostr"],
        ["t", "privacy"],
        ["l", "en"],
        ["x", webDocumentContentHash(title, description)],
        ["published", "1786339200"],
        ["source", "crawlstr/1"],
        ["type", "documentation"],
        ["platform", "github"],
        ["category", "technology"],
        ["network", "clearnet"],
        ["country", "DE"],
        ["mime", "text/html; charset=utf-8"],
      ],
      title,
      description,
    );
    assert.equal(validateWebDocument(doc), undefined);
  });

  it("rejects a missing or duplicated required tag", () => {
    const noD = event(WEB_DOCUMENT_KIND, '{"title":"T"}', [
      ["u", "https://example.com/"],
      ["v", "1"],
      ["alt", "x"],
    ]);
    assert.match(validateWebDocument(noD) ?? "", /missing d tag/);

    const twoD = webDoc("https://example.com/", [["d", "widx:whatever"]]);
    assert.match(validateWebDocument(twoD) ?? "", /multiple d tags/);

    const twoU = webDoc("https://example.com/", [
      ["u", "https://example.com/"],
    ]);
    assert.match(validateWebDocument(twoU) ?? "", /multiple u tags/);

    const noV = event(WEB_DOCUMENT_KIND, '{"title":"T"}', [
      ["d", webDocumentDTag("https://example.com/")],
      ["u", "https://example.com/"],
      ["alt", "x"],
    ]);
    assert.match(validateWebDocument(noV) ?? "", /missing v tag/);

    const noAlt = event(WEB_DOCUMENT_KIND, '{"title":"T"}', [
      ["d", webDocumentDTag("https://example.com/")],
      ["u", "https://example.com/"],
      ["v", "1"],
    ]);
    assert.match(validateWebDocument(noAlt) ?? "", /missing alt tag/);
  });

  it("rejects an unknown schema version", () => {
    const doc = webDoc("https://example.com/");
    doc.tags = doc.tags.map((t) => (t[0] === "v" ? ["v", "2"] : t));
    assert.match(
      validateWebDocument(doc) ?? "",
      /unsupported web document schema version/,
    );
  });

  it("rejects a d tag that doesn't match the normalized u tag", () => {
    const doc = webDoc("https://example.com/");
    doc.tags = doc.tags.map((t) =>
      t[0] === "d" ? ["d", webDocumentDTag("https://other.example/")] : t,
    );
    assert.match(validateWebDocument(doc) ?? "", /d tag does not match/);
  });

  it("rejects non-http(s) u tags", () => {
    const doc = webDoc("https://example.com/");
    doc.tags = doc.tags.map((t) =>
      t[0] === "u" ? ["u", "ftp://example.com/"] : t,
    );
    assert.match(validateWebDocument(doc) ?? "", /not a valid http\(s\) URL/);
  });

  it("rejects invalid content JSON and bad titles", () => {
    const badJson = webDoc("https://example.com/");
    badJson.content = "not json";
    assert.match(validateWebDocument(badJson) ?? "", /not valid JSON/);

    const noTitle = webDoc("https://example.com/");
    noTitle.content = '{"description":"D"}';
    assert.match(
      validateWebDocument(noTitle) ?? "",
      /not valid JSON with a title/,
    );

    const emptyTitle = webDoc("https://example.com/", [], "   ");
    assert.match(
      validateWebDocument(emptyTitle) ?? "",
      /title must be 1-300 characters/,
    );

    const longTitle = webDoc("https://example.com/", [], "x".repeat(301));
    assert.match(
      validateWebDocument(longTitle) ?? "",
      /title must be 1-300 characters/,
    );
  });

  it("rejects an overlong description", () => {
    const doc = webDoc("https://example.com/", [], "T", "x".repeat(1001));
    assert.match(
      validateWebDocument(doc) ?? "",
      /description exceeds 1000 characters/,
    );
  });

  it("rejects a non-https image", () => {
    const doc = webDoc("https://example.com/");
    doc.content = JSON.stringify({
      title: "T",
      image: "http://example.com/i.jpg",
    });
    assert.match(validateWebDocument(doc) ?? "", /image must be an https URL/);
  });

  it("rejects more than 8 topic tags and non-lowercase topics", () => {
    const many = webDoc(
      "https://example.com/",
      Array.from({ length: 9 }, (_, i) => ["t", `topic${i}`]),
    );
    assert.match(validateWebDocument(many) ?? "", /more than 8 topic tags/);

    const upper = webDoc("https://example.com/", [["t", "Bitcoin"]]);
    assert.match(
      validateWebDocument(upper) ?? "",
      /topic \(t\) tags must be lowercase/,
    );
  });

  it("verifies the x content hash when present (SIP-01 §9)", () => {
    const title = "Example Page";
    const ok = webDoc(
      "https://example.com/",
      [["x", webDocumentContentHash(title)]],
      title,
    );
    assert.equal(validateWebDocument(ok), undefined);

    const bad = webDoc("https://example.com/", [["x", "a".repeat(64)]], title);
    assert.match(validateWebDocument(bad) ?? "", /x tag does not match/);

    const malformed = webDoc("https://example.com/", [["x", "xyz"]], title);
    assert.match(
      validateWebDocument(malformed) ?? "",
      /x tag must be a lowercase hex/,
    );
  });

  it("rejects malformed optional tags", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["l", "english", /l tag is not a valid ISO 639-1/],
      ["published", "yesterday", /published tag must be a unix timestamp/],
      ["type", "not a type!", /type tag is not a valid keyword/],
      ["country", "DEN", /country tag must be an ISO 3166-1 alpha-2/],
      ["mime", "not a mime", /mime tag is not a valid MIME type/],
    ];
    for (const [name, value, pattern] of cases) {
      const doc = webDoc("https://example.com/", [[name, value]]);
      assert.match(
        validateWebDocument(doc) ?? "",
        pattern,
        `${name}: ${value} should be rejected`,
      );
    }
  });
});

describe("extractWebDocumentFields", () => {
  it("returns undefined for other kinds", () => {
    assert.equal(extractWebDocumentFields(event(1, "hi")), undefined);
  });

  it("returns undefined when the u tag or content is unusable", () => {
    const badUrl = event(WEB_DOCUMENT_KIND, '{"title":"T"}', [
      ["d", "widx:x"],
      ["u", "not a url"],
      ["v", "1"],
      ["alt", "x"],
    ]);
    assert.equal(extractWebDocumentFields(badUrl), undefined);

    const badContent = event(WEB_DOCUMENT_KIND, "not json", [
      ["d", webDocumentDTag("https://example.com/")],
      ["u", "https://example.com/"],
      ["v", "1"],
      ["alt", "x"],
    ]);
    assert.equal(extractWebDocumentFields(badContent), undefined);
  });

  it("extracts url, host, hierarchy, title and default scores", () => {
    const fields = extractWebDocumentFields(
      webDoc("https://WWW.GitHub.com/about/", [], "About GitHub", "About page"),
    );
    assert.ok(fields);
    assert.equal(fields.url, "https://github.com/about");
    assert.equal(fields.url_host, "github.com");
    assert.deepEqual(fields.url_domain_hierarchy, ["github.com"]);
    assert.equal(fields.title, "About GitHub");
    assert.equal(fields.description, "About page");
    assert.equal(fields.observed_at, 1_700_000_000);
    assert.equal(fields.crawl_score, 0);
    assert.equal(fields.authority_score, 0);
    assert.equal(fields.quality_score, 0);
    assert.equal(fields.spam_score, 0);
  });

  it("extracts and normalizes optional fields", () => {
    const title = "A Paper";
    const description = "About things";
    const fields = extractWebDocumentFields(
      webDoc(
        "https://example.com/papers/paper.PDF",
        [
          ["x", webDocumentContentHash(title, description)],
          ["published", "1786000000"],
          ["source", "crawlstr/1"],
          ["type", "PDF"],
          ["platform", "GitHub"],
          ["category", "Technology"],
          ["network", "Tor"],
          ["country", "de"],
          ["mime", "Application/PDF"],
        ],
        title,
        description,
      ),
    );
    assert.ok(fields);
    assert.equal(fields.file_ext, "pdf");
    assert.equal(
      fields.content_hash,
      webDocumentContentHash(title, description),
    );
    assert.equal(fields.published_at, 1786000000);
    assert.equal(fields.source, "crawlstr/1");
    assert.equal(fields.doc_type, "pdf");
    assert.equal(fields.platform, "github");
    assert.equal(fields.category, "technology");
    assert.equal(fields.network, "tor");
    assert.equal(fields.country, "DE");
    assert.equal(fields.content_type, "application/pdf");
  });

  it("omits file_ext for dotfiles and extensionless paths", () => {
    for (const path of ["/.well-known/", "/.gitignore", "/page", "/"]) {
      const fields = extractWebDocumentFields(
        webDoc(`https://example.com${path}`),
      );
      assert.ok(fields);
      assert.equal(fields.file_ext, undefined, `path: ${path}`);
    }
  });

  it("ignores invalid optional tag values instead of failing", () => {
    const fields = extractWebDocumentFields(
      webDoc("https://example.com/", [
        ["published", "soon"],
        ["type", "not a type!"],
        ["x", "nothex"],
      ]),
    );
    assert.ok(fields);
    assert.equal(fields.published_at, undefined);
    assert.equal(fields.doc_type, undefined);
    assert.equal(fields.content_hash, undefined);
  });
});

describe("webDocumentLanguage", () => {
  it("returns the l tag (ISO 639-1)", () => {
    assert.equal(
      webDocumentLanguage(webDoc("https://example.com/", [["l", "de"]])),
      "de",
    );
  });

  it("returns undefined without an l tag, other kinds, invalid values", () => {
    assert.equal(
      webDocumentLanguage(webDoc("https://example.com/")),
      undefined,
    );
    assert.equal(webDocumentLanguage(event(1, "hi", [["l", "en"]])), undefined);
    assert.equal(
      webDocumentLanguage(webDoc("https://example.com/", [["l", "english"]])),
      undefined,
    );
  });
});

describe("searchHostValue", () => {
  it("accepts bare hosts", () => {
    assert.equal(searchHostValue("github.com"), "github.com");
    assert.equal(searchHostValue("docs.github.com"), "docs.github.com");
  });

  it("forgives URLs, www prefixes, paths and trailing dots", () => {
    assert.equal(searchHostValue("https://github.com/nostr"), "github.com");
    assert.equal(searchHostValue("www.github.com"), "github.com");
    assert.equal(searchHostValue("GitHub.com."), "github.com");
    assert.equal(searchHostValue("github.com/torvalds"), "github.com");
  });

  it("returns undefined for unusable values", () => {
    assert.equal(searchHostValue(""), undefined);
    assert.equal(searchHostValue("not a host!"), undefined);
  });
});
