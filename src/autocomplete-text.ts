/**
 * Shared module for building the indexed `autocomplete_text` field from a
 * Nostr event.
 *
 * Unlike `search_text` (which feeds full-text token matching over the entire
 * event content), `autocomplete_text` is a short string of name-like surfaces
 * intended for edge-ngram prefix matching. It powers NIP-50 searches with
 * the `autocomplete:true` extension token — e.g. account autocomplete
 * dropdowns matching "jac" against profile `name: "jackson"`.
 *
 * Used by both the analyze worker (runtime) and OpenSearchRelay (fallback
 * for direct calls / tests).
 */

import type { NostrEvent } from "nostr-tools";

import { WEB_DOCUMENT_D_PREFIX, WEB_DOCUMENT_KIND } from "./web-document.ts";

/**
 * Kinds whose JSON content carries a profile/channel `name` (and friends).
 * For each kind, the listed fields are extracted from `JSON.parse(content)`.
 */
const JSON_KIND_FIELDS: Record<number, readonly string[]> = {
  0: ["name", "display_name", "nip05"], // NIP-01 User Metadata
  40: ["name"], // NIP-28 Channel Creation
  41: ["name"], // NIP-28 Channel Metadata
  30017: ["name"], // NIP-15 Stall
  30018: ["name"], // NIP-15 Product
  30019: ["name"], // NIP-15 Marketplace UI/UX
  30020: ["name"], // NIP-15 Auction Product
  [WEB_DOCUMENT_KIND]: ["title"], // SIP-01 Web Index Observation — page title
};

/**
 * Tag names whose value is treated as an autocomplete surface for any kind.
 * These are conventionally short, human-readable titles or slugs.
 */
const AUTOCOMPLETE_TAGS = new Set(["title", "name", "subject", "d"]);

/**
 * Maximum character length for autocomplete_text.
 *
 * Edge-ngrams generate up to 19 tokens per word (min_gram 2, max_gram 20),
 * so this field is much smaller than `search_text` to keep index size sane.
 */
export const MAX_AUTOCOMPLETE_TEXT_LENGTH = 512;

/**
 * Try to extract autocomplete fields from JSON content.
 * Returns extracted text parts, or an empty array if the content isn't
 * valid JSON or contains no relevant fields.
 */
function extractJsonFields(
  content: string,
  fields: readonly string[],
): string[] {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      const parts: string[] = [];
      for (const field of fields) {
        const value = (parsed as Record<string, unknown>)[field];
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
 * Build the indexed autocomplete text for a Nostr event.
 *
 * 1. **JSON kinds** with known name-bearing fields (0, 40, 41, 30017-30020):
 *    parse JSON content and extract the listed fields (see
 *    {@link JSON_KIND_FIELDS}).
 * 2. **All kinds**: append values from autocomplete tags (`title`, `name`,
 *    `subject`, `d`). This lets unknown / titled kinds (long-form articles,
 *    calendar events, addressable lists, etc.) participate in autocomplete
 *    via their canonical name tag.
 * 3. Deduplicate empty parts, join with spaces, truncate to
 *    {@link MAX_AUTOCOMPLETE_TEXT_LENGTH} characters.
 *
 * Returns an empty string for events with no autocomplete surface; callers
 * should treat that as "do not index the field" to avoid polluting the
 * index with empty documents.
 */
export function buildAutocompleteText(event: NostrEvent): string {
  const parts: string[] = [];

  // 1. Extract from JSON content for kinds with known name fields.
  const jsonFields = JSON_KIND_FIELDS[event.kind];
  if (jsonFields && event.content) {
    parts.push(...extractJsonFields(event.content, jsonFields));
  }

  // 2. Extract from autocomplete tags (kind-agnostic).
  for (const tag of event.tags) {
    if (tag.length >= 2 && AUTOCOMPLETE_TAGS.has(tag[0]) && tag[1]) {
      // SIP-01 web index observations use `widx:` d tags — URL identity
      // hashes, not human-readable slugs. Never an autocomplete surface;
      // their title arrives via JSON_KIND_FIELDS instead.
      if (tag[0] === "d" && tag[1].startsWith(WEB_DOCUMENT_D_PREFIX)) {
        continue;
      }
      parts.push(tag[1]);
    }
  }

  const text = parts.join(" ");

  if (text.length > MAX_AUTOCOMPLETE_TEXT_LENGTH) {
    return text.slice(0, MAX_AUTOCOMPLETE_TEXT_LENGTH);
  }

  return text;
}
