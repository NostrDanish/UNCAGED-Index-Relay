/**
 * Shared module for building the indexed `search_text` field from a Nostr event.
 *
 * Used by both the analyze worker (runtime) and OpenSearch relay (fallback for
 * direct calls / tests).
 */

import type { NostrEvent } from "nostr-tools";

/** Kinds whose content is not meaningful text and should be skipped entirely. */
const SKIP_CONTENT_KINDS = new Set([
  // Reposts — content is stringified JSON of another event (NIP-18)
  6,
  16,
  // Encrypted content — base64 ciphertext (NIP-04, NIP-44, NIP-59)
  4, // Encrypted Direct Message (deprecated)
  13, // Seal
  1059, // Gift Wrap
  // NIP-37 — encrypted drafts and private relay list
  10013, // Relay List for Private Content
  31234, // Draft Wraps
  // NIP-51 standard lists — content is empty or NIP-44 encrypted private items
  3, // Follow List (NIP-02)
  10000, // Mute List
  10001, // Pinned Notes
  10002, // Relay List Metadata (NIP-65)
  10003, // Bookmarks
  10004, // Communities
  10005, // Public Chats
  10006, // Blocked Relays
  10007, // Search Relays
  10009, // Simple Groups
  10012, // Relay Feeds
  10015, // Interests
  10020, // Media Follows
  10030, // Emojis
  10050, // DM Relays (NIP-17)
  10101, // Good Wiki Authors
  10102, // Good Wiki Relays
  // NIP-51 sets — content is empty or NIP-44 encrypted private items
  30000, // Follow Sets
  30002, // Relay Sets
  30003, // Bookmark Sets
  30004, // Curation Sets (articles)
  30005, // Curation Sets (videos)
  30006, // Curation Sets (pictures)
  30007, // Kind Mute Sets
  30015, // Interest Sets
  30030, // Emoji Sets
  31924, // Calendar
  39089, // Starter Packs
  39092, // Media Starter Packs
  // Other non-searchable content
  62, // Request to Vanish (NIP-62) — content is a reason/legal notice, not searchable
  9735, // Zap Receipt (NIP-57) — content is empty
]);

/** Kinds whose content is JSON with searchable fields. */
const JSON_KINDS = new Set([
  0, // User Metadata (NIP-01)
  40, // Channel Creation (NIP-28)
  41, // Channel Metadata (NIP-28)
  30017, // Stall (NIP-15)
  30018, // Product (NIP-15)
  30019, // Marketplace UI/UX (NIP-15)
  30020, // Auction Product (NIP-15)
]);

/** Kinds whose content is known to be plaintext. */
const TEXT_KINDS = new Set([
  1, // Short Text Note (NIP-01)
  5, // Event Deletion Request (NIP-09)
  7, // Reaction (NIP-25)
  9, // Chat Message (NIP-C7)
  11, // Thread (NIP-7D)
  20, // Picture (NIP-68)
  21, // Video (NIP-71)
  22, // Short-form Portrait Video (NIP-71)
  42, // Channel Message (NIP-28)
  1063, // File Metadata (NIP-94)
  1068, // Poll (NIP-88)
  1111, // Comment (NIP-22)
  1311, // Live Chat Message (NIP-53)
  9802, // Highlights (NIP-84)
  30023, // Long-form Content (NIP-23)
  30024, // Draft Long-form Content (NIP-23)
  31922, // Date-Based Calendar Event (NIP-52)
  31923, // Time-Based Calendar Event (NIP-52)
]);

/** Field names to extract from JSON content for search. */
const SEARCH_JSON_FIELDS = ["name", "about", "description", "display_name"];

/** Tag names to extract for search (kind-agnostic). */
const SEARCH_TAGS = new Set([
  "title",
  "name",
  "description",
  "summary",
  "location",
  "subject",
  "about",
]);

/** Maximum character length for search_text. */
const MAX_SEARCH_TEXT_LENGTH = 8000;

/** Minimum length for base64 detection (shorter strings are likely normal text). */
const MIN_BASE64_LENGTH = 32;

/**
 * Matches strings that consist entirely of base64 characters with optional
 * `=` padding, and optionally a `?iv=<base64>` suffix (NIP-04 format).
 */
const BASE64_RE = /^[A-Za-z0-9+/]{32,}={0,2}(\?iv=[A-Za-z0-9+/]+=*)?$/;

/**
 * Try to extract searchable fields from JSON content.
 * Returns extracted text parts, or an empty array if the content isn't
 * valid JSON or contains no searchable fields.
 */
function extractJsonFields(content: string): string[] {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      const parts: string[] = [];
      for (const field of SEARCH_JSON_FIELDS) {
        const value = parsed[field];
        if (typeof value === "string" && value) {
          parts.push(value);
        }
      }
      return parts;
    }
  } catch {
    // Not valid JSON
  }
  return [];
}

/**
 * Check whether a string looks like base64-encoded data (e.g. NIP-04/NIP-44
 * ciphertext). Only triggers for strings at least {@link MIN_BASE64_LENGTH}
 * characters long to avoid false positives on short text.
 */
function looksLikeBase64(content: string): boolean {
  return content.length >= MIN_BASE64_LENGTH && BASE64_RE.test(content);
}

/**
 * Build the indexed search text for a Nostr event.
 *
 * 1. **Skipped kinds** (reposts, encrypted, NIP-51 lists/sets, zap receipts):
 *    content is not meaningful text, so it is ignored entirely.
 * 2. **JSON kinds** (0, 40, 41, 30017-30020): parse JSON content and extract
 *    `name`, `about`, `description`, `display_name`.
 * 3. **Text kinds** (1, 5, 7, 9, 11, 20, 21, 22, 42, 1063, 1068, 1111, 1311,
 *    9802, 30023, 30024, 31922, 31923): use `content` as plaintext.
 * 4. **Unknown kinds**: auto-detect — try JSON extraction, skip base64, else
 *    treat as plaintext.
 * - **All kinds**: append values from searchable tags (`title`, `name`,
 *   `description`, `summary`, `location`, `subject`, `about`).
 * - Truncate the result to {@link MAX_SEARCH_TEXT_LENGTH} characters.
 */
export function buildSearchText(event: NostrEvent): string {
  const parts: string[] = [];

  // 1. Extract text from content
  if (SKIP_CONTENT_KINDS.has(event.kind)) {
    // Content is not useful text — skip it entirely
  } else if (JSON_KINDS.has(event.kind)) {
    parts.push(...extractJsonFields(event.content));
  } else if (TEXT_KINDS.has(event.kind)) {
    if (event.content) {
      parts.push(event.content);
    }
  } else if (event.content) {
    // Unknown kind — auto-detect content type
    if (event.content.startsWith("{")) {
      // Looks like JSON — try to extract searchable fields
      const jsonParts = extractJsonFields(event.content);
      if (jsonParts.length > 0) {
        parts.push(...jsonParts);
      }
      // If no searchable JSON fields found, skip (don't index raw JSON)
    } else if (!looksLikeBase64(event.content)) {
      // Not base64 — treat as plaintext
      parts.push(event.content);
    }
    // If it looks like base64, skip it
  }

  // 2. Extract text from searchable tags (kind-agnostic)
  for (const tag of event.tags) {
    if (tag.length >= 2 && SEARCH_TAGS.has(tag[0]) && tag[1]) {
      parts.push(tag[1]);
    }
  }

  const text = parts.join("\n");

  if (text.length > MAX_SEARCH_TEXT_LENGTH) {
    return text.slice(0, MAX_SEARCH_TEXT_LENGTH);
  }

  return text;
}
