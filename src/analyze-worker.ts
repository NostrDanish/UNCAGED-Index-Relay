/// Worker thread that performs Nostr event analysis off the main thread.
/// Handles signature verification (via nostr-wasm), language detection (tinyld),
/// and sentiment analysis. Short-circuits if verification fails.

declare var self: Worker;

import { NSchema as n } from "@nostrify/nostrify";
import type { NostrEvent } from "nostr-tools";
import { initNostrWasm } from "nostr-wasm";
import Sentiment from "sentiment";
import { detect as detectLanguage } from "tinyld";

import type { AnalyzeResult } from "./analyze-pool.ts";

const nw = await initNostrWasm();
const sentimentAnalyzer = new Sentiment();

/** Minimum content length (in characters) required to attempt language detection. */
const MIN_LANGUAGE_DETECT_LENGTH = 10;

/** Event kinds with plaintext content suitable for language/sentiment detection. */
const TEXT_KINDS = new Set([
  1, // Short Text Note (NIP-10)
  11, // Thread (NIP-7D)
  30023, // Long-form Content (NIP-23)
  1111, // Comment (NIP-22)
  9, // Chat Message (NIP-C7)
  42, // Channel Message (NIP-28)
  1311, // Live Chat Message (NIP-53)
]);

/** Minimum absolute `comparative` score to classify as positive or negative. */
const SENTIMENT_THRESHOLD = 0.1;

/** NIP-30 custom emoji shortcodes like `:soapbox:`. */
const CUSTOM_EMOJI_RE = /^:[\w-]+:$/;

import { detectMedia } from "./media.ts";

/**
 * Detect the language of a Nostr event's content using `tinyld`.
 *
 * Only runs for kinds with meaningful text content. Kind 0 (metadata)
 * is handled specially by parsing the JSON and joining the `name`,
 * `display_name`, and `about` fields.
 *
 * Returns an ISO 639-1 two-letter code, or `undefined` when the language
 * cannot be determined.
 */
function detectEventLanguage(event: NostrEvent): string | undefined {
  let text: string;

  if (event.kind === 0) {
    // Parse JSON metadata and join relevant text fields.
    const result = n.json().pipe(n.metadata()).safeParse(event.content);
    if (!result.success) return undefined;
    text = [result.data.name, result.data.display_name, result.data.about]
      .filter(Boolean)
      .join(" ");
  } else if (TEXT_KINDS.has(event.kind)) {
    text = event.content;
  } else {
    return undefined;
  }

  if (text.length < MIN_LANGUAGE_DETECT_LENGTH) {
    return undefined;
  }

  const detected = detectLanguage(text);
  return detected || undefined; // tinyld returns "" when unsure
}

/**
 * Detect the sentiment of a Nostr event's content.
 *
 * Runs for kinds with meaningful text content (same as language detection,
 * but excluding kind 0). Kind 7 (reactions) is handled specially per NIP-25:
 * `"+"` or `""` maps to `"positive"`, `"-"` maps to `"negative"`, and emoji
 * reactions are passed through the sentiment analyzer.
 *
 * Returns `"positive"`, `"negative"`, `"neutral"`, or `undefined` when
 * sentiment cannot be determined.
 */
function detectEventSentiment(event: NostrEvent): string | undefined {
  // Kind 7 reactions get special handling (NIP-25).
  if (event.kind === 7) {
    const content = event.content;
    // "+" or empty string = like / upvote
    if (content === "+" || content === "") return "positive";
    // "-" = dislike / downvote
    if (content === "-") return "negative";
    // Custom emoji shortcodes have no intrinsic sentiment.
    if (CUSTOM_EMOJI_RE.test(content)) return undefined;
    // Emoji reactions — let the sentiment library score them.
    const result = sentimentAnalyzer.analyze(content);
    if (result.comparative > SENTIMENT_THRESHOLD) return "positive";
    if (result.comparative < -SENTIMENT_THRESHOLD) return "negative";
    return "neutral";
  }

  // For text kinds, analyze full content.
  if (!TEXT_KINDS.has(event.kind)) return undefined;

  if (event.content.length < MIN_LANGUAGE_DETECT_LENGTH) {
    return undefined;
  }

  const result = sentimentAnalyzer.analyze(event.content);
  if (result.comparative > SENTIMENT_THRESHOLD) return "positive";
  if (result.comparative < -SENTIMENT_THRESHOLD) return "negative";
  return "neutral";
}

self.onmessage = (event: MessageEvent<NostrEvent>) => {
  const nostrEvent = event.data;
  const id = `${nostrEvent.id}:${nostrEvent.sig}`;

  // Step 1: Verify signature
  let verified: boolean;
  try {
    nw.verifyEvent(nostrEvent);
    verified = true;
  } catch {
    verified = false;
  }

  // Short-circuit if verification failed — don't waste time on analysis
  if (!verified) {
    postMessage({ id, verified } satisfies { id: string } & AnalyzeResult);
    return;
  }

  // Step 2: Detect language, sentiment, and media (only for verified events)
  const language = detectEventLanguage(nostrEvent);
  const sentiment = detectEventSentiment(nostrEvent);
  const { media, video } = detectMedia(nostrEvent);

  postMessage({
    id,
    verified,
    ...(language && { language }),
    ...(sentiment && { sentiment }),
    ...(media !== undefined && { media }),
    ...(video !== undefined && { video }),
  } satisfies { id: string } & AnalyzeResult);
};
