/**
 * Painless script builders for OpenSearch reindex and update-by-query
 * operations. These mirror the tag filtering logic in OpenSearchRelay
 * (MULTI_LETTER_TAG_WHITELIST, TAG_VALUE_MAX_LENGTH,
 * TAG_VALUE_MAX_COUNT_PER_NAME) so the rules stay in sync between
 * TypeScript and server-side Painless execution.
 */

import { OpenSearchRelay } from "../src/opensearch.ts";

/**
 * Generate the Painless snippet that rebuilds `autocomplete_text` from
 * `ctx._source`, mirroring the {@link buildAutocompleteText} logic in
 * src/autocomplete-text.ts. Sets `ctx._source.autocomplete_text` when a
 * non-empty result is produced; removes any stale field otherwise.
 */
export function buildAutocompleteTextPainlessScript(): string {
  return `
    // --- Build autocomplete_text ---
    int AC_MAX_LEN = 512;

    Map autocompleteJsonKindFields = new HashMap();
    autocompleteJsonKindFields.put(0, new String[] {'name', 'display_name', 'nip05'});
    autocompleteJsonKindFields.put(40, new String[] {'name'});
    autocompleteJsonKindFields.put(41, new String[] {'name'});
    autocompleteJsonKindFields.put(30017, new String[] {'name'});
    autocompleteJsonKindFields.put(30018, new String[] {'name'});
    autocompleteJsonKindFields.put(30019, new String[] {'name'});
    autocompleteJsonKindFields.put(30020, new String[] {'name'});

    Set autocompleteTags = new HashSet();
    autocompleteTags.add('title');
    autocompleteTags.add('name');
    autocompleteTags.add('subject');
    autocompleteTags.add('d');

    StringBuilder acSb = new StringBuilder();

    // JSON content extraction for kinds with known name fields.
    String[] acJsonFields = (String[]) autocompleteJsonKindFields.get(ctx._source.kind);
    if (acJsonFields != null) {
      String c = ctx._source.content;
      if (c != null && c.startsWith('{')) {
        for (String field : acJsonFields) {
          String key = '"' + field + '"';
          int keyIdx = c.indexOf(key);
          if (keyIdx >= 0) {
            int colonIdx = c.indexOf(':', keyIdx + key.length());
            if (colonIdx >= 0) {
              int startQuote = c.indexOf('"', colonIdx + 1);
              if (startQuote >= 0) {
                int endQuote = startQuote + 1;
                while (endQuote < c.length()) {
                  if (c.charAt(endQuote) == (char)'"' && c.charAt(endQuote - 1) != (char)'\\\\') {
                    break;
                  }
                  endQuote++;
                }
                if (endQuote < c.length()) {
                  String val = c.substring(startQuote + 1, endQuote);
                  if (val.length() > 0) {
                    if (acSb.length() > 0) acSb.append(' ');
                    acSb.append(val);
                  }
                }
              }
            }
          }
        }
      }
    }

    // Tag scan (kind-agnostic).
    if (ctx._source.tags != null) {
      for (def tag : ctx._source.tags) {
        if (tag.length >= 2 && autocompleteTags.contains(tag[0]) && tag[1].length() > 0) {
          if (acSb.length() > 0) acSb.append(' ');
          acSb.append(tag[1]);
        }
      }
    }

    String acResult = acSb.toString();
    if (acResult.length() > AC_MAX_LEN) {
      acResult = acResult.substring(0, AC_MAX_LEN);
    }
    if (acResult.length() > 0) {
      ctx._source.autocomplete_text = acResult;
    } else {
      ctx._source.remove('autocomplete_text');
    }`;
}

/**
 * Generate the Painless script snippet that rebuilds `tags_map` from
 * `ctx._source.tags`, mirroring the `buildTagsMap` / `isIndexableTagName`
 * logic. Used by reindex and update-by-query scripts so the filtering
 * rules stay in sync with the TypeScript implementation.
 *
 * @param maxCount per-tag-name value cap. Pass the runtime-configured cap
 *   (e.g. `config.tagValueMaxCountPerName`) when reindexing so the script
 *   and runtime produce identical `tags_map` projections. Defaults to
 *   {@link OpenSearchRelay.TAG_VALUE_MAX_COUNT_PER_NAME}.
 */
export function buildTagsMapPainlessScript(
  maxCount: number = OpenSearchRelay.TAG_VALUE_MAX_COUNT_PER_NAME,
): string {
  const adds = [...OpenSearchRelay.MULTI_LETTER_TAG_WHITELIST]
    .map((t) => `whitelist.add('${t}');`)
    .join(" ");

  return `
    Set whitelist = new HashSet();
    ${adds}
    Map tagsMap = new HashMap();
    if (ctx._source.tags != null) {
      for (def tag : ctx._source.tags) {
        if (tag != null && tag.size() >= 2) {
          String tagName = tag[0].toString();
          if (tagName.length() != 1 && !whitelist.contains(tagName)) {
            continue;
          }
          String value = tag[1].toString();
          if (!tagsMap.containsKey(tagName)) {
            tagsMap.put(tagName, new ArrayList());
          }
          if (value.length() <= ${OpenSearchRelay.TAG_VALUE_MAX_LENGTH}
              && tagsMap.get(tagName).size() < ${maxCount}) {
            tagsMap.get(tagName).add(value);
          }
        }
      }
    }
    ctx._source.tags_map = tagsMap;
    // NIP-25: For kind 7 reactions, only keep the last e tag value.
    // Iterate the original tags array (not the clipped tagsMap) so we pick
    // up the true last e tag even when earlier e tags have been dropped by
    // the per-tag-name count cap above.
    if (ctx._source.kind == 7 && ctx._source.tags != null) {
      for (int i = ctx._source.tags.size() - 1; i >= 0; i--) {
        def t = ctx._source.tags[i];
        if (t != null && t.size() >= 2 && t[0].toString() == 'e'
            && t[1].toString().length() <= ${OpenSearchRelay.TAG_VALUE_MAX_LENGTH}) {
          tagsMap.put('e', [t[1].toString()]);
          break;
        }
      }
    }`;
}

/**
 * Build a comprehensive Painless script for reindexing that:
 * 1. Rebuilds `tags_map` using the current whitelist
 * 2. Renames legacy fields: `top_score` → `followers`/`engagers`,
 *    `reply_count` → `comment_cnt`, `reaction_count` → `reaction_cnt`,
 *    `repost_count` → `repost_cnt`
 * 3. Builds `search_text` from event content and tags
 * 4. Builds `autocomplete_text` from event content and tags
 *
 * @param maxCount propagated to {@link buildTagsMapPainlessScript}.
 *
 * Returns the Painless script source string.
 */
export function buildReindexPainlessScript(
  maxCount: number = OpenSearchRelay.TAG_VALUE_MAX_COUNT_PER_NAME,
): string {
  const tagsMapScript = buildTagsMapPainlessScript(maxCount);
  const autocompleteScript = buildAutocompleteTextPainlessScript();

  return `
    ${tagsMapScript}

    // --- Re-key document ID to hex event ID ---
    // Old replaceable/addressable events were stored under naddr-encoded _id
    // values. The relay now uses the raw hex event ID as _id for all events.
    ctx._id = ctx._source.id;

    // --- Default replaced field ---
    // Existing documents won't have this field; default to false (current).
    if (!ctx._source.containsKey('replaced')) {
      ctx._source.replaced = false;
    }

    // --- Field renames ---
    // Split top_score into followers (kind 0) and engagers (non-kind-0).
    if (ctx._source.containsKey('top_score')) {
      def ts = ctx._source.remove('top_score');
      if (ctx._source.kind == 0) {
        ctx._source.followers = ts != null ? ts : 0;
        ctx._source.engagers = 0;
      } else {
        ctx._source.engagers = ts != null ? ts : 0;
        ctx._source.followers = 0;
      }
    }
    if (!ctx._source.containsKey('followers')) { ctx._source.followers = 0; }
    if (!ctx._source.containsKey('engagers')) { ctx._source.engagers = 0; }

    // Rename reply_count → comment_cnt
    if (ctx._source.containsKey('reply_count')) {
      ctx._source.comment_cnt = ctx._source.remove('reply_count');
    }
    if (!ctx._source.containsKey('comment_cnt')) { ctx._source.comment_cnt = 0; }

    // Rename reaction_count → reaction_cnt
    if (ctx._source.containsKey('reaction_count')) {
      ctx._source.reaction_cnt = ctx._source.remove('reaction_count');
    }
    if (!ctx._source.containsKey('reaction_cnt')) { ctx._source.reaction_cnt = 0; }

    // Rename repost_count → repost_cnt
    if (ctx._source.containsKey('repost_count')) {
      ctx._source.repost_cnt = ctx._source.remove('repost_count');
    }
    if (!ctx._source.containsKey('repost_cnt')) { ctx._source.repost_cnt = 0; }

    // Ensure quote_cnt exists
    if (!ctx._source.containsKey('quote_cnt')) { ctx._source.quote_cnt = 0; }

    // Ensure zap_cnt exists
    if (!ctx._source.containsKey('zap_cnt')) { ctx._source.zap_cnt = 0; }

    // --- Remove legacy fields not in new mapping ---
    ctx._source.remove('scores_dirty');
    ctx._source.remove('nip05_domain');
    ctx._source.remove('nip05_hostname');

    // --- Build search_text ---
    int MAX_LEN = 8000;

    Set jsonKinds = new HashSet();
    jsonKinds.add(0); jsonKinds.add(40); jsonKinds.add(41);
    jsonKinds.add(30017); jsonKinds.add(30018); jsonKinds.add(30019); jsonKinds.add(30020);

    Set skipKinds = new HashSet();
    for (int k : new int[]{6, 16, 4, 13, 1059, 10013, 31234, 3,
      10000, 10001, 10002, 10003, 10004, 10005, 10006, 10007,
      10009, 10012, 10015, 10020, 10030, 10050, 10101, 10102,
      30000, 30002, 30003, 30004, 30005, 30006, 30007, 30015,
      30030, 31924, 39089, 39092, 9735}) {
      skipKinds.add(k);
    }

    Set searchTags = new HashSet();
    searchTags.add('title'); searchTags.add('name'); searchTags.add('description');
    searchTags.add('summary'); searchTags.add('location'); searchTags.add('subject');
    searchTags.add('about');

    String[] jsonFields = new String[] {'name', 'about', 'description', 'display_name'};

    StringBuilder sb = new StringBuilder();

    if (!skipKinds.contains(ctx._source.kind)) {
      if (jsonKinds.contains(ctx._source.kind)) {
        String c = ctx._source.content;
        if (c != null && c.startsWith('{')) {
          for (String field : jsonFields) {
            String key = '"' + field + '"';
            int keyIdx = c.indexOf(key);
            if (keyIdx >= 0) {
              int colonIdx = c.indexOf(':', keyIdx + key.length());
              if (colonIdx >= 0) {
                int startQuote = c.indexOf('"', colonIdx + 1);
                if (startQuote >= 0) {
                  int endQuote = startQuote + 1;
                  while (endQuote < c.length()) {
                    if (c.charAt(endQuote) == (char)'"' && c.charAt(endQuote - 1) != (char)'\\\\') {
                      break;
                    }
                    endQuote++;
                  }
                  if (endQuote < c.length()) {
                    String val = c.substring(startQuote + 1, endQuote);
                    if (val.length() > 0) {
                      if (sb.length() > 0) sb.append(' ');
                      sb.append(val);
                    }
                  }
                }
              }
            }
          }
        }
      } else {
        if (ctx._source.content != null && ctx._source.content.length() > 0) {
          sb.append(ctx._source.content);
        }
      }
    }

    if (ctx._source.tags != null) {
      for (def tag : ctx._source.tags) {
        if (tag.length >= 2 && searchTags.contains(tag[0]) && tag[1].length() > 0) {
          if (sb.length() > 0) sb.append(' ');
          sb.append(tag[1]);
        }
      }
    }

    String result = sb.toString();
    if (result.length() > MAX_LEN) {
      result = result.substring(0, MAX_LEN);
    }
    ctx._source.search_text = result;

    ${autocompleteScript}
    `;
}
