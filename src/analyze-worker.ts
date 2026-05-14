/// Worker thread that performs Nostr event analysis off the main thread.
/// Handles signature verification (via nostr-wasm), search text extraction,
/// language detection (tinyld), sentiment analysis, and media detection.
/// Short-circuits if verification fails.
///
/// Receives batches of events (NostrEvent[]) and responds with batches of
/// results to amortize postMessage structured-clone overhead.

declare var self: Worker;

import type { NostrEvent } from "nostr-tools";
import { initNostrWasm } from "nostr-wasm";
import Sentiment from "sentiment";
import { detect as detectLanguage } from "tinyld";

import type { AnalyzeRequest, AnalyzeResult } from "./analyze-pool.ts";
import { detectMedia } from "./media.ts";
import { buildSearchText } from "./search-text.ts";

const nw = await initNostrWasm();
const sentimentAnalyzer = new Sentiment();

/** Minimum text length (in characters) required to attempt language detection. */
const MIN_LANGUAGE_DETECT_LENGTH = 10;

/** Minimum absolute `comparative` score to classify as positive or negative. */
const SENTIMENT_THRESHOLD = 0.1;

/**
 * Maximum characters of search text passed to tinyld / sentiment.
 *
 * Both libraries scale with input length but neither needs the full 8 KB of
 * indexed search_text to make a confident call — a few hundred characters is
 * usually plenty for language ID and sentiment scoring. Capping the input
 * keeps long-form content (kind 30023) from dominating worker CPU.
 */
const MAX_DETECT_INPUT_LENGTH = 1024;

/** NIP-30 custom emoji shortcodes like `:soapbox:`. */
const CUSTOM_EMOJI_RE = /^:[\w-]+:$/;

/**
 * Kinds whose content is not useful natural-language text: encrypted payloads,
 * NIP-51 lists/sets, reposts, zap receipts, etc. For these we skip language
 * and sentiment detection entirely — the only "text" we'd have to feed in is
 * a handful of tag values (titles, summaries) which don't reliably carry
 * either signal and waste CPU on tinyld / sentiment dictionary lookups.
 *
 * Kind 7 (reactions) is intentionally NOT in this set — it gets its own
 * NIP-25 fast path below.
 */
const SKIP_LANG_SENT_KINDS = new Set([
  // Reposts (NIP-18)
  6, 16,
  // Encrypted content (NIP-04 / NIP-44 / NIP-59 / NIP-37)
  4, 13, 1059, 10013, 31234,
  // NIP-51 standard lists
  3, 10000, 10001, 10002, 10003, 10004, 10005, 10006, 10007, 10009, 10012,
  10015, 10020, 10030, 10050, 10101, 10102,
  // NIP-51 sets
  30000, 30002, 30003, 30004, 30005, 30006, 30007, 30015, 30030, 31924, 39089,
  39092,
  // Zap receipt
  9735,
]);

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

  const input =
    searchText.length > MAX_DETECT_INPUT_LENGTH
      ? searchText.slice(0, MAX_DETECT_INPUT_LENGTH)
      : searchText;

  const detected = detectLanguage(input);
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

  const input =
    searchText.length > MAX_DETECT_INPUT_LENGTH
      ? searchText.slice(0, MAX_DETECT_INPUT_LENGTH)
      : searchText;

  const result = sentimentAnalyzer.analyze(input);
  if (result.comparative > SENTIMENT_THRESHOLD) return "positive";
  if (result.comparative < -SENTIMENT_THRESHOLD) return "negative";
  return "neutral";
}

/** Analyze a single request and return the result with its correlation id. */
function analyzeOne(
  request: AnalyzeRequest,
): { reqId: number } & AnalyzeResult {
  const { reqId, event: nostrEvent, verifyOnly } = request;

  // Step 1: Verify signature
  let verified: boolean;
  try {
    nw.verifyEvent(nostrEvent);
    verified = true;
  } catch {
    verified = false;
  }

  // Build the result imperatively to avoid the per-event allocation churn of
  // conditional spreads (`...(x && { x })`), which create 3–4 throwaway
  // objects per event under firehose load.
  const out: { reqId: number } & AnalyzeResult = { reqId, verified };

  // Short-circuit if verification failed — don't waste time on analysis.
  // Also short-circuit if the caller only wants the verified bit.
  if (!verified || verifyOnly) {
    return out;
  }

  // Step 2: Build search text (used by language/sentiment detection below)
  const searchText = buildSearchText(nostrEvent);
  if (searchText) out.search_text = searchText;

  // Step 3: Detect language and sentiment, but only for kinds whose content
  // is natural-language text. Encrypted payloads, NIP-51 lists, reposts,
  // and zap receipts get media detection only.
  const kind = nostrEvent.kind;
  if (!SKIP_LANG_SENT_KINDS.has(kind)) {
    const language = detectEventLanguage(searchText);
    if (language) out.language = language;
    const sentiment = detectEventSentiment(nostrEvent, searchText);
    if (sentiment) out.sentiment = sentiment;
  }

  // Step 4: Detect media (cheap, no kind restriction beyond what detectMedia does)
  const { media, video } = detectMedia(nostrEvent);
  if (media !== undefined) out.media = media;
  if (video !== undefined) out.video = video;

  return out;
}

self.onmessage = (event: MessageEvent<AnalyzeRequest[]>) => {
  const batch = event.data;
  const results = batch.map(analyzeOne);
  postMessage(results);
};
