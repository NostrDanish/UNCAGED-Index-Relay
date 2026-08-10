/**
 * SIP-01 Web Index Observation events (kind 39697) — the decentralized
 * index record.
 *
 * SIP-01 (Search Index Protocol) is the shared contract between the
 * ecosystem's crawlers and search engines: Crawlstr (and any other crawler)
 * publishes signed observations of web pages; this relay stores, validates,
 * and indexes them; search engines (0xSearchstr, 0xPresearchstr, UNCAGED
 * Engine, …) consume and rank them however they choose.
 *
 * Canonical specification: https://github.com/NostrDanish/SIP-01
 * (`public/spec/SIP-01.md`). The §13 test vectors are covered by
 * web-document.test.ts — keep them green; a single character of drift in
 * normalization or hashing breaks deduplication against every other
 * implementation.
 *
 * One shared decentralized index. Many independent indexers. No single owner.
 *
 * ## Event shape (SIP-01 v1)
 *
 * ```json
 * {
 *   "kind": 39697,
 *   "content": "{\"title\":\"Example Page\",\"description\":\"A page about...\"}",
 *   "tags": [
 *     ["d", "widx:9f86d081884c7d659a2feaa0c55ad015"],
 *     ["u", "https://example.com/page"],
 *     ["t", "nostr"],
 *     ["l", "en"],
 *     ["x", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
 *     ["v", "1"],
 *     ["published", "1754600000"],
 *     ["source", "crawlstr/1"],
 *     ["alt", "Web index observation: Example Page"]
 *   ]
 * }
 * ```
 *
 * ## Identities (SIP-01 §3)
 *
 * - **URL identity** — the `d` tag: `"widx:" + sha256(normalized_url)[0:32]`.
 *   All indexers observing the same normalized URL produce the same `d`, so
 *   "N independent indexers saw this page" is a group-by-`d`/count-`pubkey`
 *   query away. Per-indexer recrawls replace the indexer's previous
 *   observation (one addressable slot per `(pubkey, d)`), and relays with
 *   history preservation keep superseded versions for change tracking.
 * - **Canonical URL** — the `u` tag, normalized per SIP-01 §7.
 * - **Content identity** — the `x` tag: `sha256(title + "\n" + description)`.
 *   Same `d` + same `x` = indexers agree; same `d` + different `x` = the page
 *   changed or they disagree. Both are ranking signals.
 *
 * ## What the relay does with these events
 *
 * - **Validation** ({@link validateWebDocument}): malformed observations are
 *   rejected at ingestion with an `invalid:` OK message — schema version,
 *   URL allowlist, `d` ↔ normalized `u` consistency, `x` ↔ content
 *   consistency, and the spec's hard length caps are all enforced. Garbage in
 *   = garbage index — SIP-01 §12.4 is reader guidance applied at the door:
 *   the relay simply refuses invalid observations.
 * - **Structured indexing** ({@link extractWebDocumentFields}): the event
 *   becomes dedicated keyword/text fields (`url`, `url_host`,
 *   `url_domain_hierarchy`, `title`, `description`, `language`,
 *   `content_hash`, `published_at`, `observed_at`, `source`, plus the
 *   optional `type`/`platform`/`category`/`network`/`country`/`mime`
 *   extension tags) instead of being lumped into generic search text.
 * - **Search operators**: NIP-50 extensions (`site:`, `domain:`, `url:`,
 *   `inurl:`, `title:`, `topic:`, `before:`, `after:`, `lang:`,
 *   `distinct:domain`, …) map onto those fields — see buildQuery in
 *   opensearch.ts. Plain Nostr filters (`kinds`, `#d`, `#t`, …) work
 *   everywhere, as SIP-01 requires.
 *
 * Crawlers never talk to OpenSearch directly; they publish signed events.
 * Anyone can run a crawler, anyone can run an index relay.
 */

import { createHash } from "node:crypto";
import type { NostrEvent } from "nostr-tools";

/** Event kind for SIP-01 Web Index Observations (addressable range). */
export const WEB_DOCUMENT_KIND = 39697;

/** Current SIP-01 schema version (the `v` tag). */
export const WEB_DOCUMENT_SCHEMA_VERSION = "1";

/** Prefix of the URL-identity `d` tag (SIP-01 §3). */
export const WEB_DOCUMENT_D_PREFIX = "widx:";

/** Maximum length of the `u` tag value. */
export const WEB_DOC_URL_MAX_LENGTH = 2048;

/** Title length cap (SIP-01 §5): 1–300 chars after trim. */
export const WEB_DOC_TITLE_MAX_LENGTH = 300;

/** Description length cap (SIP-01 §6). */
export const WEB_DOC_DESCRIPTION_MAX_LENGTH = 1000;

/** Maximum number of topic (`t`) tags (SIP-01 §6). */
export const WEB_DOC_MAX_TOPICS = 8;

/** Generous cap for the NIP-31 `alt` description. */
const ALT_MAX_LENGTH = 1000;

/** Cap for the informational `source` tag. */
const SOURCE_MAX_LENGTH = 100;

/**
 * Tracking parameters stripped during SIP-01 §7 URL normalization. All other
 * query parameters are preserved (many are semantically required).
 */
const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "dclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref_src",
  "spm",
  "si",
] as const;

/** Lookup set for {@link TRACKING_PARAMS} (matched case-insensitively). */
const TRACKING_SET: ReadonlySet<string> = new Set(TRACKING_PARAMS);

/** ISO 639-1 two-letter language code (the `l` tag). */
const LANG_RE = /^[a-z]{2}$/;

/** Lowercase topic tag value (SIP-01 §6: `t` tags are lowercase topics). */
const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** Extension tag values: `page`, `repository`, `github`, `onion`, `DE`, ... */
const EXTENSION_VALUE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}$/;

/** MIME type with optional parameters: `text/html; charset=utf-8`. */
const MIME_RE = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}(;\s*[^\s;=]+=[^\s;]+)*$/;

/** Dotted-quad IPv4 address (domain hierarchy makes no sense for IPs). */
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Parsed content JSON of a web index observation. */
export interface WebDocumentContent {
  title: string;
  description?: string;
  image?: string;
}

/**
 * Normalize a URL per SIP-01 §7. Implementations MUST produce byte-identical
 * results across the ecosystem or `d`-tag deduplication breaks:
 *
 * 1. Parse; reject anything not `http://` or `https://`.
 * 2. Lowercase scheme and host; strip a leading `www.` from the host.
 * 3. Remove default ports (`:80` http, `:443` https) — done by the WHATWG
 *    URL parser.
 * 4. Remove the fragment entirely.
 * 5. Remove known tracking parameters (see {@link TRACKING_PARAMS}); all
 *    other query parameters are preserved.
 * 6. Sort remaining query parameters alphabetically by key (stable for
 *    duplicate keys).
 * 7. Remove a trailing `/` from the path (except the bare root `/`).
 * 8. Re-encode via `URL.toString()`.
 *
 * Returns `undefined` when the input is not a valid http(s) URL.
 */
export function normalizeIndexUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

  // 2. Strip a leading www. (scheme/host are lowercased by the parser).
  if (url.hostname.startsWith("www.")) {
    url.hostname = url.hostname.slice(4);
  }

  // 4. Fragment.
  url.hash = "";

  // 5–6. Drop tracking parameters (case-insensitively — `UTM_SOURCE` is as
  // much a tracker as `utm_source`), then sort the rest by key. Assigning
  // `url.search` unconditionally also normalizes away a bare trailing `?`.
  const entries = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_SET.has(key.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sorted = new URLSearchParams();
  for (const [key, value] of entries) sorted.append(key, value);
  url.search = sorted.toString();

  // 7. Trailing slash (keep the bare root "/").
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

/**
 * The SIP-01 §3 `d` tag value for a normalized URL:
 * `"widx:" + sha256(url)[0:32]` (lowercase hex). Deterministic across all
 * indexers — that is what makes independent-observation counting work.
 */
export function webDocumentDTag(normalizedUrl: string): string {
  const hash = createHash("sha256").update(normalizedUrl, "utf8").digest("hex");
  return `${WEB_DOCUMENT_D_PREFIX}${hash.slice(0, 32)}`;
}

/**
 * The SIP-01 §8 content identity: lowercase hex SHA-256 of
 * `title + "\n" + description` (empty string when description is absent).
 */
export function webDocumentContentHash(
  title: string,
  description?: string,
): string {
  return createHash("sha256")
    .update(`${title}\n${description ?? ""}`, "utf8")
    .digest("hex");
}

/** All values of the tags with the given name that carry a value. */
function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags.filter((t) => t[0] === name && t[1]).map((t) => t[1]);
}

/** The single value of a tag expected at most once, or undefined. */
function tagValue(event: NostrEvent, name: string): string | undefined {
  return tagValues(event, name)[0];
}

/**
 * Parse the content JSON of a web document event. Returns undefined when the
 * content is not a JSON object or the required `title` is not a string.
 */
export function parseWebDocumentContent(
  content: string,
): WebDocumentContent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const { title, description, image } = parsed as Record<string, unknown>;
  if (typeof title !== "string") return undefined;
  return {
    title,
    ...(typeof description === "string" && { description }),
    ...(typeof image === "string" && { image }),
  };
}

/**
 * Validate a kind 39697 web index observation for ingestion.
 *
 * Returns a human-readable reason string (without the `invalid:` prefix) when
 * the event is malformed, or `undefined` when it is acceptable. Called by the
 * relay after signature verification; invalid observations are rejected and
 * never reach the index (SIP-01 §12.4 relay-side validation).
 */
export function validateWebDocument(event: NostrEvent): string | undefined {
  if (event.kind !== WEB_DOCUMENT_KIND) return undefined;

  // --- Required tags: exactly one d, u, v, alt each.

  const dTags = event.tags.filter((t) => t[0] === "d");
  if (dTags.length === 0 || !dTags[0][1]) return "web document missing d tag";
  if (dTags.length > 1) return "web document has multiple d tags";
  const dTag = dTags[0][1];

  const uTags = event.tags.filter((t) => t[0] === "u");
  if (uTags.length === 0 || !uTags[0][1]) return "web document missing u tag";
  if (uTags.length > 1) return "web document has multiple u tags";
  const uTag = uTags[0][1];

  const vTags = event.tags.filter((t) => t[0] === "v");
  if (vTags.length === 0 || !vTags[0][1]) return "web document missing v tag";
  if (vTags.length > 1) return "web document has multiple v tags";
  if (vTags[0][1] !== WEB_DOCUMENT_SCHEMA_VERSION) {
    return `unsupported web document schema version "${vTags[0][1]}"`;
  }

  const altTags = event.tags.filter((t) => t[0] === "alt");
  if (altTags.length === 0 || !altTags[0][1]?.trim()) {
    return "web document missing alt tag";
  }
  if (altTags.length > 1) return "web document has multiple alt tags";
  if (altTags[0][1].length > ALT_MAX_LENGTH) {
    return `alt tag exceeds ${ALT_MAX_LENGTH} characters`;
  }

  // --- URL allowlist + d ↔ normalized u consistency (SIP-01 §7, §11).

  if (uTag.length > WEB_DOC_URL_MAX_LENGTH) {
    return `u tag exceeds ${WEB_DOC_URL_MAX_LENGTH} characters`;
  }
  const normalized = normalizeIndexUrl(uTag);
  if (!normalized) return "u tag is not a valid http(s) URL";
  if (dTag !== webDocumentDTag(normalized)) {
    return "d tag does not match the normalized u tag (widx: + sha256(u)[0:32])";
  }

  // --- Content JSON: title is required (1–300 trimmed), description and
  // --- image optional with caps.

  const content = parseWebDocumentContent(event.content);
  if (!content) return "web document content is not valid JSON with a title";

  const trimmedTitle = content.title.trim();
  if (
    trimmedTitle.length === 0 ||
    trimmedTitle.length > WEB_DOC_TITLE_MAX_LENGTH
  ) {
    return `title must be 1-${WEB_DOC_TITLE_MAX_LENGTH} characters`;
  }
  if (
    content.description !== undefined &&
    content.description.length > WEB_DOC_DESCRIPTION_MAX_LENGTH
  ) {
    return `description exceeds ${WEB_DOC_DESCRIPTION_MAX_LENGTH} characters`;
  }
  if (content.image !== undefined) {
    let imageUrl: URL | undefined;
    try {
      imageUrl = new URL(content.image);
    } catch {
      imageUrl = undefined;
    }
    if (imageUrl?.protocol !== "https:") {
      return "image must be an https URL";
    }
  }

  // --- Optional tags, validated when present.

  const topics = event.tags.filter((t) => t[0] === "t");
  if (topics.length > WEB_DOC_MAX_TOPICS) {
    return `web document has more than ${WEB_DOC_MAX_TOPICS} topic tags`;
  }
  for (const topic of topics) {
    if (!topic[1] || !TOPIC_RE.test(topic[1])) {
      return "topic (t) tags must be lowercase alphanumeric words";
    }
  }

  const lang = tagValue(event, "l");
  if (lang !== undefined && !LANG_RE.test(lang)) {
    return "l tag is not a valid ISO 639-1 language code";
  }

  // The x tag is the content-agreement signal; an incorrect hash is worse
  // than none, so it is verified against the observed metadata (SIP-01 §8).
  const x = tagValue(event, "x");
  if (x !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(x)) {
      return "x tag must be a lowercase hex sha256 digest";
    }
    if (x !== webDocumentContentHash(content.title, content.description)) {
      return "x tag does not match sha256(title + \\n + description)";
    }
  }

  const published = tagValue(event, "published");
  if (published !== undefined && !/^\d{1,16}$/.test(published)) {
    return "published tag must be a unix timestamp in seconds";
  }

  const source = tagValue(event, "source");
  if (source !== undefined && source.length > SOURCE_MAX_LENGTH) {
    return `source tag exceeds ${SOURCE_MAX_LENGTH} characters`;
  }

  // Optional extension tags (SIP-01 §9): free-form but keyword-shaped.
  for (const name of ["type", "platform", "category", "network"]) {
    const value = tagValue(event, name);
    if (value !== undefined && !EXTENSION_VALUE_RE.test(value)) {
      return `${name} tag is not a valid keyword`;
    }
  }

  const country = tagValue(event, "country");
  if (country !== undefined && !/^[a-zA-Z]{2}$/.test(country)) {
    return "country tag must be an ISO 3166-1 alpha-2 code";
  }

  const mime = tagValue(event, "mime");
  if (mime !== undefined && !MIME_RE.test(mime)) {
    return "mime tag is not a valid MIME type";
  }

  return undefined;
}

/**
 * Structured fields indexed for a web document event. Fields sourced from
 * optional tags are set only when present and valid, so the OpenSearch
 * mapping stays sparse. `observed_at` (the event's own `created_at`) is
 * always set, so freshness ranges/sorts work uniformly.
 */
export interface WebDocumentFields {
  /** Normalized canonical URL (SIP-01 §7). */
  url: string;
  /** Full hostname, lowercased, e.g. `docs.github.com`. */
  url_host: string;
  /**
   * The host plus every dotted parent suffix, e.g. `docs.github.com` →
   * `["docs.github.com", "github.com"]`. Powers the `site:` operator
   * (host-or-subdomain match). Bare TLDs are excluded. IP hosts yield only
   * the host itself.
   */
  url_domain_hierarchy: string[];
  /** Lowercased file extension from the URL path, e.g. `pdf`. */
  file_ext?: string;
  /** Document title (content JSON). */
  title: string;
  /** Document description (content JSON), when present. */
  description?: string;
  /** Representative image URL (content JSON), when present. */
  image?: string;
  /** Content identity (the `x` tag): sha256(title + \n + description). */
  content_hash?: string;
  /** The page's claimed publication time (the `published` tag). */
  published_at?: number;
  /** Observation time: the event's `created_at`. */
  observed_at: number;
  /** Indexer software identifier (the `source` tag), e.g. `crawlstr/1`. */
  source?: string;
  /** Logical document type (the `type` extension tag), lowercased. */
  doc_type?: string;
  /** Source platform (the `platform` extension tag), e.g. `github`. */
  platform?: string;
  /** Content category (the `category` extension tag). */
  category?: string;
  /** Network the document lives on (the `network` extension tag), e.g. `clearnet`, `tor`. */
  network?: string;
  /** ISO 3166-1 alpha-2 country code (the `country` extension tag), uppercased. */
  country?: string;
  /** MIME type (the `mime` extension tag), lowercased. */
  content_type?: string;
  /**
   * Relay-computed ranking signals (NIP-SR4), seeded at zero on indexing.
   * Crawler-supplied scores are NOT trusted — the background worker computes
   * these from observation agreement, link graphs, and spam analysis so
   * search queries can stay cheap (indexed fields, no per-query script
   * scoring). The relay provides signals; search engines decide ranking.
   */
  crawl_score: number;
  authority_score: number;
  quality_score: number;
  spam_score: number;
}

/**
 * Extract the structured index fields from a web document event.
 *
 * Returns `undefined` when the event is not a usable web document (wrong
 * kind, unusable `u` tag, or unparseable content JSON) — callers index the
 * event as a plain event in that case. On the ingest path, invalid documents
 * are rejected by {@link validateWebDocument} before extraction ever runs.
 */
export function extractWebDocumentFields(
  event: NostrEvent,
): WebDocumentFields | undefined {
  if (event.kind !== WEB_DOCUMENT_KIND) return undefined;

  const rawUrl = tagValue(event, "u");
  if (!rawUrl) return undefined;
  const url = normalizeIndexUrl(rawUrl);
  if (!url) return undefined;

  const content = parseWebDocumentContent(event.content);
  if (!content) return undefined;

  const host = new URL(url).hostname.toLowerCase();

  const fields: WebDocumentFields = {
    url,
    url_host: host,
    url_domain_hierarchy: domainHierarchy(host),
    title: content.title,
    observed_at: event.created_at,
    crawl_score: 0,
    authority_score: 0,
    quality_score: 0,
    spam_score: 0,
  };

  if (content.description) fields.description = content.description;
  if (content.image) fields.image = content.image;

  const ext = fileExtension(new URL(url).pathname);
  if (ext) fields.file_ext = ext;

  const x = tagValue(event, "x");
  if (x && /^[0-9a-f]{64}$/.test(x)) fields.content_hash = x;

  const published = tagValue(event, "published");
  if (published && /^\d{1,16}$/.test(published)) {
    fields.published_at = Number.parseInt(published, 10);
  }

  const source = tagValue(event, "source");
  if (source) fields.source = source;

  const docType = tagValue(event, "type");
  if (docType && EXTENSION_VALUE_RE.test(docType)) {
    fields.doc_type = docType.toLowerCase();
  }

  const platform = tagValue(event, "platform");
  if (platform && EXTENSION_VALUE_RE.test(platform)) {
    fields.platform = platform.toLowerCase();
  }

  const category = tagValue(event, "category");
  if (category && EXTENSION_VALUE_RE.test(category)) {
    fields.category = category.toLowerCase();
  }

  const network = tagValue(event, "network");
  if (network && EXTENSION_VALUE_RE.test(network)) {
    fields.network = network.toLowerCase();
  }

  const country = tagValue(event, "country");
  if (country && /^[a-zA-Z]{2}$/.test(country)) {
    fields.country = country.toUpperCase();
  }

  const mime = tagValue(event, "mime");
  if (mime && MIME_RE.test(mime)) {
    fields.content_type = mime.toLowerCase();
  }

  return fields;
}

/**
 * The language declared by a web document's `l` tag (ISO 639-1). Takes
 * precedence over the analyzer's detected language — the indexer saw the
 * actual HTTP/DOM metadata.
 */
export function webDocumentLanguage(event: NostrEvent): string | undefined {
  if (event.kind !== WEB_DOCUMENT_KIND) return undefined;
  const lang = tagValue(event, "l");
  if (!lang || !LANG_RE.test(lang)) return undefined;
  return lang;
}

/**
 * Build the domain hierarchy for a host: the host itself plus every dotted
 * parent suffix. `docs.github.com` → `["docs.github.com", "github.com"]`;
 * `github.com` → `["github.com"]`. Bare TLDs (`com`) and IP address
 * "suffixes" are excluded; single-label hosts (`localhost`, `[::1]`) yield
 * just the host.
 */
export function domainHierarchy(host: string): string[] {
  if (!host || IPV4_RE.test(host) || host.includes(":")) return [host];
  const parts = host.split(".");
  const out: string[] = [host];
  for (let i = 1; i < parts.length - 1; i++) {
    out.push(parts.slice(i).join("."));
  }
  return out;
}

/**
 * Lowercased file extension of a URL path's last segment, when it looks like
 * a real extension (`/a/page.html` → `html`, `/a/file.tar.gz` → `gz`).
 * Returns undefined for dotfiles, trailing dots, and over-long "extensions".
 */
function fileExtension(pathname: string): string | undefined {
  const lastSegment = pathname.split("/").pop() ?? "";
  const dot = lastSegment.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = lastSegment.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : undefined;
}

/**
 * Normalize a `site:`/`domain:` operator value to a bare host, forgiving
 * common input forms (`https://github.com/x` → `github.com`,
 * `GitHub.com.` → `github.com`, `www.github.com` → `github.com` — matching
 * SIP-01 §7 host normalization). Returns undefined when unusable; an
 * unusable operator value adds no clause.
 */
export function searchHostValue(value: string): string | undefined {
  let v = value.trim().toLowerCase();
  if (!v) return undefined;
  if (v.includes("://")) {
    const normalized = normalizeIndexUrl(v);
    if (!normalized) return undefined;
    v = new URL(normalized).hostname;
  }
  if (v.startsWith("www.")) v = v.slice(4);
  if (v.endsWith(".")) v = v.slice(0, -1);
  if (v.includes("/")) v = v.split("/")[0]; // e.g. "github.com/torvalds"
  if (v.length > 253 || !/^[a-z0-9.\-:[\]]+$/.test(v)) return undefined;
  return v;
}
