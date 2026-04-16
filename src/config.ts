import type { NostrSigner } from "@nostrify/nostrify";
import { NSecSigner } from "@nostrify/nostrify";
import { nip19 } from "nostr-tools";

export class Config {
  readonly port: number;
  readonly relayUrl: string;
  readonly publicUrl: string;
  readonly relayPubkey: string | undefined;
  readonly relayContact: string | undefined;
  readonly opensearchNode: string;
  readonly opensearchIndex: string;
  readonly opensearchUsername: string | undefined;
  readonly opensearchPassword: string | undefined;
  /** Comma-separated list of ISO 639-1 language codes for per-language trends. */
  readonly preferredLanguages: string[];
  /** Interval in ms between trend computations. 0 to disable. Default: 15 minutes. */
  readonly trendsIntervalMs: number;
  /** Whether to preserve historical versions of replaceable/addressable events. Default: true. */
  readonly historyEnabled: boolean;
  /**
   * Set of kind numbers to preserve history for.
   * When set, ONLY these kinds will have history preserved (whitelist mode).
   * Takes precedence over `historyKindsExcluded`.
   */
  readonly historyKindsWhitelist: Set<number> | undefined;
  /**
   * Set of kind numbers to exclude from history preservation.
   * Ignored when `historyKindsWhitelist` is set.
   * Default: 30382,30383,30384,30385 (NIP-85 record events).
   */
  readonly historyKindsExcluded: Set<number>;
  /**
   * Set of kind numbers that require AUTH for REQ/COUNT queries.
   * Filters including these kinds must have `authors` or `#p` arrays where ALL
   * entries are authenticated pubkeys on the connection.
   * These kinds are also excluded from queries that don't explicitly include them.
   * Default: 4,1059 (NIP-04 DMs and NIP-59 Gift Wraps).
   */
  readonly authKinds: Set<number>;
  /** Whether to enable background stats recomputation and NIP-85 publishing. Default: true. */
  readonly statsEnabled: boolean;
  /**
   * Maximum size (in bytes) of a single inbound WebSocket message.
   * Used both as Bun's `maxPayloadLength` (enforcement) and as NIP-11
   * `limitation.max_message_length` (advertisement) — single source of truth.
   * Default: 4_000_000 (4 MB).
   */
  readonly maxMessageLength: number;
  /**
   * Maximum number of entries in any single filter array (`ids`, `authors`,
   * `kinds`, or any `#<tag>`). Caps the fan-out of per-filter OpenSearch
   * `terms` clauses. Default: 5000.
   */
  readonly maxFilterValues: number;
  /**
   * Maximum number of values stored per tag name in the indexed `tags_map`
   * projection. Bounds the per-document inverted-index growth from events
   * with very high tag counts. Also surfaced to clients as NIP-11
   * `limitation.max_event_tags`: events with more tags of the same name
   * are still accepted and stored verbatim, but values beyond this count
   * are dropped from the searchable projection. Default: 5000.
   */
  readonly tagValueMaxCountPerName: number;
  readonly nostrSigner: NostrSigner;

  constructor(env: { get(key: string): string | undefined }) {
    // port
    const portValue = env.get("PORT");
    if (!portValue) {
      this.port = 13131;
    } else {
      const port = parseInt(portValue, 10);
      if (Number.isNaN(port) || port < 1 || port > 65535) {
        throw new Error("PORT must be a valid port number (1-65535).");
      }
      this.port = port;
    }

    // relayUrl
    const relayUrlValue = env.get("RELAY_URL");
    if (!relayUrlValue) {
      throw new Error("RELAY_URL is required.");
    }
    this.relayUrl = relayUrlValue;

    // publicUrl
    const publicUrlValue = env.get("PUBLIC_URL");
    this.publicUrl = publicUrlValue ?? this.relayUrl.replace(/^ws/, "http");

    // relayPubkey
    this.relayPubkey = env.get("RELAY_PUBKEY");

    // relayContact
    this.relayContact = env.get("RELAY_CONTACT");

    // opensearch
    this.opensearchNode = env.get("OPENSEARCH_NODE") || "http://localhost:9200";
    this.opensearchIndex = env.get("OPENSEARCH_INDEX") || "nostr-events";
    this.opensearchUsername = env.get("OPENSEARCH_USERNAME");
    this.opensearchPassword = env.get("OPENSEARCH_PASSWORD");

    // preferredLanguages
    const langValue = env.get("DITTO_LANGUAGES");
    if (!langValue) {
      this.preferredLanguages = [];
    } else {
      this.preferredLanguages = langValue
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^[a-z]{2}$/.test(s));
    }

    // trendsIntervalMs
    const trendsValue = env.get("TRENDS_INTERVAL_MS");
    if (!trendsValue) {
      this.trendsIntervalMs = 900_000;
    } else {
      const ms = parseInt(trendsValue, 10);
      if (Number.isNaN(ms) || ms < 0) {
        throw new Error("TRENDS_INTERVAL_MS must be a non-negative integer.");
      }
      this.trendsIntervalMs = ms;
    }

    // historyEnabled
    const historyValue = env.get("HISTORY_ENABLED");
    if (!historyValue) {
      this.historyEnabled = true;
    } else {
      this.historyEnabled =
        historyValue.toLowerCase() === "true" || historyValue === "1";
    }

    // historyKindsWhitelist
    const whitelistValue = env.get("HISTORY_KINDS_WHITELIST");
    if (!whitelistValue) {
      this.historyKindsWhitelist = undefined;
    } else {
      const kinds = whitelistValue
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n));
      this.historyKindsWhitelist =
        kinds.length > 0 ? new Set(kinds) : undefined;
    }

    // historyKindsExcluded
    const excludedValue = env.get("HISTORY_KINDS_EXCLUDED");
    if (excludedValue === undefined) {
      this.historyKindsExcluded = new Set([30382, 30383, 30384, 30385]);
    } else {
      const kinds = excludedValue
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n));
      this.historyKindsExcluded = new Set(kinds);
    }

    // authKinds
    const authValue = env.get("AUTH_KINDS");
    if (authValue === undefined) {
      this.authKinds = new Set([4, 1059]);
    } else {
      const kinds = authValue
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n));
      this.authKinds = new Set(kinds);
    }

    // statsEnabled
    const statsValue = env.get("STATS_ENABLED");
    if (!statsValue) {
      this.statsEnabled = true;
    } else {
      this.statsEnabled =
        statsValue.toLowerCase() === "true" || statsValue === "1";
    }

    // maxMessageLength
    const maxMsgValue = env.get("RELAY_MAX_MESSAGE_LENGTH");
    if (!maxMsgValue) {
      this.maxMessageLength = 4_000_000;
    } else {
      const bytes = parseInt(maxMsgValue, 10);
      if (Number.isNaN(bytes) || bytes <= 0) {
        throw new Error(
          "RELAY_MAX_MESSAGE_LENGTH must be a positive integer (bytes).",
        );
      }
      this.maxMessageLength = bytes;
    }

    // maxFilterValues
    const maxFilterValuesValue = env.get("RELAY_MAX_FILTER_VALUES");
    if (!maxFilterValuesValue) {
      this.maxFilterValues = 5000;
    } else {
      const n = parseInt(maxFilterValuesValue, 10);
      if (Number.isNaN(n) || n <= 0) {
        throw new Error("RELAY_MAX_FILTER_VALUES must be a positive integer.");
      }
      this.maxFilterValues = n;
    }

    // tagValueMaxCountPerName
    const tagValueMaxCountPerNameValue = env.get(
      "RELAY_TAG_VALUE_MAX_COUNT_PER_NAME",
    );
    if (!tagValueMaxCountPerNameValue) {
      this.tagValueMaxCountPerName = 5000;
    } else {
      const n = parseInt(tagValueMaxCountPerNameValue, 10);
      if (Number.isNaN(n) || n <= 0) {
        throw new Error(
          "RELAY_TAG_VALUE_MAX_COUNT_PER_NAME must be a positive integer.",
        );
      }
      this.tagValueMaxCountPerName = n;
    }

    // nostrSigner
    const nsecValue = env.get("NOSTR_NSEC");
    if (!nsecValue) {
      throw new Error("NOSTR_NSEC is required.");
    }
    const decoded = nip19.decode(nsecValue);
    if (decoded.type !== "nsec") {
      throw new Error(
        "NOSTR_NSEC must be a valid nsec (bech32-encoded secret key).",
      );
    }
    this.nostrSigner = new NSecSigner(decoded.data);
  }
}
