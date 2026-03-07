/// Worker thread that performs Nostr event analysis off the main thread.
/// Handles signature verification (via nostr-wasm), search text extraction,
/// language detection (tinyld), sentiment analysis, and media detection.
/// Short-circuits if verification fails.

declare var self: Worker;

import type { NostrEvent } from "nostr-tools";
import { initNostrWasm } from "nostr-wasm";
import Sentiment from "sentiment";
import { detect as detectLanguage } from "tinyld";

import type { AnalyzeResult } from "./analyze-pool.ts";
import { detectMedia } from "./media.ts";
import { buildSearchText } from "./search-text.ts";

const nw = await initNostrWasm();
const sentimentAnalyzer = new Sentiment();

/** Minimum text length (in characters) required to attempt language detection. */
const MIN_LANGUAGE_DETECT_LENGTH = 10;

/** Minimum absolute `comparative` score to classify as positive or negative. */
const SENTIMENT_THRESHOLD = 0.1;

/** NIP-30 custom emoji shortcodes like `:soapbox:`. */
const CUSTOM_EMOJI_RE = /^:[\w-]+:$/;

/**
 * Detect the language of a Nostr event using its pre-computed search text.
 *
 * Returns an ISO 639-1 two-letter code, or `undefined` when the language
 * cannot be determined.
 */
function detectEventLanguage(searchText: string): string | undefined {
  if (searchText.length < MIN_LANGUAGE_DETECT_LENGTH) {
    return undefined;
  }

  const detected = detectLanguage(searchText);
  return detected || undefined; // tinyld returns "" when unsure
}

/**
 * Detect the sentiment of a Nostr event.
 *
 * Uses the pre-computed search text for most kinds. Kind 7 (reactions)
 * is handled specially per NIP-25: `"+"` or `""` maps to `"positive"`,
 * `"-"` maps to `"negative"`, and emoji reactions are passed through
 * the sentiment analyzer.
 *
 * Returns `"positive"`, `"negative"`, `"neutral"`, or `undefined` when
 * sentiment cannot be determined.
 */
function detectEventSentiment(
  event: NostrEvent,
  searchText: string,
): string | undefined {
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

  // For all other kinds, analyze the search text.
  if (searchText.length < MIN_LANGUAGE_DETECT_LENGTH) {
    return undefined;
  }

  const result = sentimentAnalyzer.analyze(searchText);
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

  // Step 2: Build search text (used by language/sentiment detection below)
  const searchText = buildSearchText(nostrEvent);

  // Step 3: Detect language, sentiment, and media (only for verified events)
  const language = detectEventLanguage(searchText);
  const sentiment = detectEventSentiment(nostrEvent, searchText);
  const { media, video } = detectMedia(nostrEvent);

  postMessage({
    id,
    verified,
    ...(searchText && { search_text: searchText }),
    ...(language && { language }),
    ...(sentiment && { sentiment }),
    ...(media !== undefined && { media }),
    ...(video !== undefined && { video }),
  } satisfies { id: string } & AnalyzeResult);
};
