import type { NostrEvent } from "nostr-tools";

/** Known media file extensions mapped to their base MIME type. */
const MEDIA_EXTENSIONS: Record<string, string> = {
  // Images
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  avif: "image",
  bmp: "image",
  ico: "image",
  tiff: "image",
  // Video
  mp4: "video",
  webm: "video",
  mov: "video",
  avi: "video",
  mkv: "video",
  ogv: "video",
  m4v: "video",
  // Audio
  mp3: "audio",
  ogg: "audio",
  wav: "audio",
  flac: "audio",
  aac: "audio",
  m4a: "audio",
  opus: "audio",
};

/**
 * Maximum number of bytes of `event.content` scanned for media URLs.
 *
 * This is a hard DoS defense, independent of NIP-11 `max_content_length`,
 * because this function runs on the main event-handling path. URLs that
 * straddle the boundary are silently dropped.
 */
const MAX_CONTENT_SCAN = 32_768;

/**
 * Anchored per-token media URL regex. Matched against whitespace-delimited
 * tokens rather than against raw content with the `g` flag, which eliminates
 * catastrophic backtracking on adversarial input. Capture group 1 is the
 * file extension.
 */
const MEDIA_URL_TOKEN_RE = /^https?:\/\/[^\s?#]+\.(\w+)(?:[?#][^\s]*)?$/i;

/**
 * Whitespace test on a character code — covers the ASCII whitespace set
 * (space, tab, LF, VT, FF, CR). Faster than running a regex `.test()` per
 * character, which is what the previous `split(/\s+/)` implicitly did.
 *
 * ASCII-only is a deliberate trade-off: Nostr clients overwhelmingly delimit
 * URLs with normal space/newline, and treating non-breaking space (U+00A0)
 * et al. as part of a token only means we miss media detection for the
 * pathological "URL wrapped in NBSP" case. Server-side defense, not parser.
 */
function isWhitespace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

/** Parsed imeta entry — only the fields we use are extracted. */
interface ImetaEntry {
  url: string;
  /** MIME type from the `m` key, e.g. `image/jpeg`. */
  m?: string;
}

/**
 * Parse imeta tags from an event into structured metadata entries.
 * Each imeta tag has the format: ["imeta", "key value", "key value", ...]
 *
 * Single-pass: avoids the chained filter/map/filter and per-entry Map
 * allocations the previous implementation produced for every event.
 */
function parseImeta(event: NostrEvent): ImetaEntry[] {
  const out: ImetaEntry[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "imeta") continue;
    let url: string | undefined;
    let m: string | undefined;
    for (let i = 1; i < tag.length; i++) {
      const entry = tag[i];
      const spaceIdx = entry.indexOf(" ");
      if (spaceIdx <= 0) continue;
      const key = entry.slice(0, spaceIdx);
      if (key === "url") {
        url = entry.slice(spaceIdx + 1);
      } else if (key === "m") {
        m = entry.slice(spaceIdx + 1);
      }
      // Other imeta keys (alt, dim, blurhash, x, fallback, …) are not used
      // by media detection and are skipped to avoid wasted parsing work.
    }
    if (url) {
      out.push(m !== undefined ? { url, m } : { url });
    }
  }
  return out;
}

/**
 * Detect media attachments for an event.
 *
 * Returns `{ media: true }` if the event has any media attachments, and
 * additionally `{ video: true }` if **all** media attachments are video.
 *
 * Detection uses two strategies:
 * 1. **Primary** — NIP-92 `imeta` tags with MIME type (`m`) metadata.
 * 2. **Fallback** — For kind 1 events without `imeta` tags, scan content
 *    for URLs with known media file extensions.
 */
export function detectMedia(event: NostrEvent): {
  media?: boolean;
  video?: boolean;
} {
  const imeta = parseImeta(event);

  // Fallback: for kind 1 events without imeta tags, detect media URLs in content.
  // Scanning is capped at MAX_CONTENT_SCAN bytes, then tokenized on whitespace
  // and each token is tested against an anchored regex — this avoids the
  // quadratic backtracking the previous unanchored/global regex exhibited on
  // adversarial input.
  //
  // Manual whitespace tokenization (instead of `split(/\s+/)`) avoids
  // allocating a full array of every word in the post; we walk the buffer
  // once and only materialize substrings for tokens that start with "http".
  if (imeta.length === 0 && event.kind === 1) {
    const content = event.content;
    const end =
      content.length > MAX_CONTENT_SCAN ? MAX_CONTENT_SCAN : content.length;

    let i = 0;
    while (i < end) {
      // Skip whitespace using char-code comparisons rather than a regex per
      // character. Covers ASCII space, tab, LF, CR, VT, FF.
      while (i < end && isWhitespace(content.charCodeAt(i))) i++;
      const start = i;
      // Walk to the next whitespace character.
      while (i < end && !isWhitespace(content.charCodeAt(i))) i++;
      if (i === start) continue;
      // Cheap prefix gate — vast majority of tokens in a note aren't URLs.
      // `startsWith` with `start` avoids slicing until we're sure it's a URL.
      if (
        !content.startsWith("http://", start) &&
        !content.startsWith("https://", start)
      ) {
        continue;
      }
      const token = content.slice(start, i);
      const match = MEDIA_URL_TOKEN_RE.exec(token);
      if (!match) continue;
      const ext = match[1].toLowerCase();
      const baseType = MEDIA_EXTENSIONS[ext];
      if (baseType) {
        imeta.push({ url: token, m: `${baseType}/${ext}` });
      }
    }
  }

  if (imeta.length === 0) {
    return {};
  }

  const result: { media?: boolean; video?: boolean } = { media: true };

  if (imeta.every((entry) => entry.m?.startsWith("video/"))) {
    result.video = true;
  }

  return result;
}
