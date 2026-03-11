import type { NostrSigner } from "@nostrify/nostrify";
import { NSecSigner } from "@nostrify/nostrify";
import { nip19 } from "nostr-tools";

export class Config {
  private env: { get(key: string): string | undefined };

  constructor(env: { get(key: string): string | undefined }) {
    this.env = env;
  }

  get port(): number {
    const value = this.env.get("PORT");
    if (!value) {
      return 13131; // Default port
    }
    const port = parseInt(value, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      throw new Error("PORT must be a valid port number (1-65535).");
    }
    return port;
  }

  get relayUrl(): string {
    const value = this.env.get("RELAY_URL");
    if (!value) {
      throw new Error("RELAY_URL is required.");
    }
    return value;
  }

  get publicUrl(): string {
    const value = this.env.get("PUBLIC_URL");
    if (!value) {
      return this.relayUrl.replace(/^ws/, "http"); // Default to relay URL with http scheme
    }
    return value;
  }

  get relayPubkey(): string | undefined {
    return this.env.get("RELAY_PUBKEY");
  }

  get relayContact(): string | undefined {
    return this.env.get("RELAY_CONTACT");
  }

  get opensearchNode(): string {
    return this.env.get("OPENSEARCH_NODE") || "http://localhost:9200";
  }

  get opensearchIndex(): string {
    return this.env.get("OPENSEARCH_INDEX") || "nostr-events";
  }

  get opensearchUsername(): string | undefined {
    return this.env.get("OPENSEARCH_USERNAME");
  }

  get opensearchPassword(): string | undefined {
    return this.env.get("OPENSEARCH_PASSWORD");
  }

  /** Comma-separated list of ISO 639-1 language codes for per-language trends. */
  get preferredLanguages(): string[] {
    const value = this.env.get("DITTO_LANGUAGES");
    if (!value) return [];
    return value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[a-z]{2}$/.test(s));
  }

  /** Interval in ms between trend computations. 0 to disable. Default: 15 minutes. */
  get trendsIntervalMs(): number {
    const value = this.env.get("TRENDS_INTERVAL_MS");
    if (!value) return 900_000; // 15 minutes
    const ms = parseInt(value, 10);
    if (Number.isNaN(ms) || ms < 0) {
      throw new Error("TRENDS_INTERVAL_MS must be a non-negative integer.");
    }
    return ms;
  }

  get nostrSigner(): NostrSigner {
    const value = this.env.get("NOSTR_NSEC");
    if (!value) {
      throw new Error("NOSTR_NSEC is required.");
    }
    const decoded = nip19.decode(value);
    if (decoded.type !== "nsec") {
      throw new Error(
        "NOSTR_NSEC must be a valid nsec (bech32-encoded secret key).",
      );
    }
    return new NSecSigner(decoded.data);
  }
}
