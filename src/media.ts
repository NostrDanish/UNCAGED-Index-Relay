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
 * Parse imeta tags from an event into structured metadata entries.
 * Each imeta tag has the format: ["imeta", "key value", "key value", ...]
 */
function parseImeta(event: NostrEvent): Array<Map<string, string>> {
  return event.tags
    .filter(([name]) => name === "imeta")
    .map(([, ...entries]) => {
      const map = new Map<string, string>();
      for (const entry of entries) {
        const spaceIdx = entry.indexOf(" ");
        if (spaceIdx > 0) {
          map.set(entry.slice(0, spaceIdx), entry.slice(spaceIdx + 1));
        }
      }
      return map;
    })
    .filter((map) => map.has("url"));
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
  if (imeta.length === 0 && event.kind === 1) {
    const scanBuf =
      event.content.length > MAX_CONTENT_SCAN
        ? event.content.slice(0, MAX_CONTENT_SCAN)
        : event.content;

    for (const token of scanBuf.split(/\s+/)) {
      if (token.length === 0) continue;
      const match = MEDIA_URL_TOKEN_RE.exec(token);
      if (!match) continue;
      const ext = match[1].toLowerCase();
      const baseType = MEDIA_EXTENSIONS[ext];
      if (baseType) {
        const map = new Map<string, string>();
        map.set("url", token);
        map.set("m", `${baseType}/${ext}`);
        imeta.push(map);
      }
    }
  }

  if (imeta.length === 0) {
    return {};
  }

  const result: { media?: boolean; video?: boolean } = { media: true };

  if (
    imeta.every((tags) => {
      const m = tags.get("m");
      return m?.startsWith("video/");
    })
  ) {
    result.video = true;
  }

  return result;
}
