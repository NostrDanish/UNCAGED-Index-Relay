import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Config } from "./config.ts";

describe("Config", () => {
  describe("port", () => {
    it("should return default port 13131 when PORT is not set", () => {
      const mockEnv = new Map();
      const config = new Config(mockEnv);
      assert.equal(config.port, 13131);
    });

    it("should return the port from environment when valid", () => {
      const mockEnv = new Map([["PORT", "8080"]]);
      const config = new Config(mockEnv);
      assert.equal(config.port, 8080);
    });

    it("should throw error when PORT is not a number", () => {
      const mockEnv = new Map([["PORT", "invalid"]]);
      const config = new Config(mockEnv);
      assert.throws(() => config.port, {
        message: "PORT must be a valid port number (1-65535).",
      });
    });

    it("should throw error when PORT is below 1", () => {
      const mockEnv = new Map([["PORT", "0"]]);
      const config = new Config(mockEnv);
      assert.throws(() => config.port, {
        message: "PORT must be a valid port number (1-65535).",
      });
    });

    it("should throw error when PORT is above 65535", () => {
      const mockEnv = new Map([["PORT", "65536"]]);
      const config = new Config(mockEnv);
      assert.throws(() => config.port, {
        message: "PORT must be a valid port number (1-65535).",
      });
    });

    it("should accept PORT at boundary values", () => {
      const mockEnvMin = new Map([["PORT", "1"]]);
      const configMin = new Config(mockEnvMin);
      assert.equal(configMin.port, 1);

      const mockEnvMax = new Map([["PORT", "65535"]]);
      const configMax = new Config(mockEnvMax);
      assert.equal(configMax.port, 65535);
    });
  });

  describe("relayUrl", () => {
    it("should throw an error when RELAY_URL is not set", () => {
      const mockEnv = new Map();
      const config = new Config(mockEnv);
      assert.throws(() => config.relayUrl, /RELAY_URL is required/);
    });

    it("should return the RELAY_URL from environment when set", () => {
      const mockEnv = new Map([["RELAY_URL", "wss://relay.example.com/"]]);
      const config = new Config(mockEnv);
      assert.equal(config.relayUrl, "wss://relay.example.com/");
    });
  });

  describe("nostrSigner", () => {
    it("should throw an error when NOSTR_NSEC is not set", () => {
      const mockEnv = new Map();
      const config = new Config(mockEnv);
      assert.throws(() => config.nostrSigner, /NOSTR_NSEC is required/);
    });

    it("should return a NostrSigner when a valid nsec is provided", async () => {
      const mockEnv = new Map([
        [
          "NOSTR_NSEC",
          "nsec1l2xejwnzu9sjl9ve3eryktge5u05esdez9ll3wt9gly9n7yraq4sph4kgh",
        ],
      ]);
      const config = new Config(mockEnv);
      const signer = config.nostrSigner;
      const pubkey = await signer.getPublicKey();
      assert.equal(typeof pubkey, "string");
      assert.equal(pubkey.length, 64);
    });

    it("should throw an error when the value is not an nsec", () => {
      const mockEnv = new Map([
        [
          "NOSTR_NSEC",
          "npub1dpyfqvgf6cup9cx3tdnqrh0h33alsey5rtu34976sgxrag3286aqgnlshp",
        ],
      ]);
      const config = new Config(mockEnv);
      assert.throws(() => config.nostrSigner, /must be a valid nsec/);
    });
  });

  describe("trendsIntervalMs", () => {
    it("should default to 900000 (15 minutes)", () => {
      const config = new Config(new Map());
      assert.equal(config.trendsIntervalMs, 900_000);
    });

    it("should parse from environment", () => {
      const config = new Config(new Map([["TRENDS_INTERVAL_MS", "60000"]]));
      assert.equal(config.trendsIntervalMs, 60_000);
    });

    it("should allow 0 to disable", () => {
      const config = new Config(new Map([["TRENDS_INTERVAL_MS", "0"]]));
      assert.equal(config.trendsIntervalMs, 0);
    });
  });

  describe("preferredLanguages", () => {
    it("should return empty array when not set", () => {
      const config = new Config(new Map());
      assert.deepEqual(config.preferredLanguages, []);
    });

    it("should parse comma-separated language codes", () => {
      const config = new Config(new Map([["DITTO_LANGUAGES", "en,pt,es"]]));
      assert.deepEqual(config.preferredLanguages, ["en", "pt", "es"]);
    });

    it("should filter out invalid language codes", () => {
      const config = new Config(
        new Map([["DITTO_LANGUAGES", "en,xyz,pt,123"]]),
      );
      assert.deepEqual(config.preferredLanguages, ["en", "pt"]);
    });

    it("should handle whitespace", () => {
      const config = new Config(new Map([["DITTO_LANGUAGES", "en , pt , es"]]));
      assert.deepEqual(config.preferredLanguages, ["en", "pt", "es"]);
    });
  });

  describe("historyEnabled", () => {
    it("should default to true", () => {
      const config = new Config(new Map());
      assert.equal(config.historyEnabled, true);
    });

    it("should be false when set to 'false'", () => {
      const config = new Config(new Map([["HISTORY_ENABLED", "false"]]));
      assert.equal(config.historyEnabled, false);
    });

    it("should be true when set to 'true'", () => {
      const config = new Config(new Map([["HISTORY_ENABLED", "true"]]));
      assert.equal(config.historyEnabled, true);
    });

    it("should accept '1' as true and '0' as false", () => {
      assert.equal(
        new Config(new Map([["HISTORY_ENABLED", "1"]])).historyEnabled,
        true,
      );
      assert.equal(
        new Config(new Map([["HISTORY_ENABLED", "0"]])).historyEnabled,
        false,
      );
    });
  });

  describe("historyKindsWhitelist", () => {
    it("should return undefined when not set", () => {
      const config = new Config(new Map());
      assert.equal(config.historyKindsWhitelist, undefined);
    });

    it("should parse comma-separated kind numbers", () => {
      const config = new Config(
        new Map([["HISTORY_KINDS_WHITELIST", "0,3,30023"]]),
      );
      assert.deepEqual(config.historyKindsWhitelist, new Set([0, 3, 30023]));
    });

    it("should handle whitespace", () => {
      const config = new Config(
        new Map([["HISTORY_KINDS_WHITELIST", " 0 , 3 , 30023 "]]),
      );
      assert.deepEqual(config.historyKindsWhitelist, new Set([0, 3, 30023]));
    });

    it("should filter out non-numbers", () => {
      const config = new Config(
        new Map([["HISTORY_KINDS_WHITELIST", "0,abc,3"]]),
      );
      assert.deepEqual(config.historyKindsWhitelist, new Set([0, 3]));
    });

    it("should return undefined for empty string", () => {
      const config = new Config(new Map([["HISTORY_KINDS_WHITELIST", ""]]));
      assert.equal(config.historyKindsWhitelist, undefined);
    });
  });

  describe("historyKindsExcluded", () => {
    it("should default to NIP-85 kinds (30382-30385)", () => {
      const config = new Config(new Map());
      assert.deepEqual(
        config.historyKindsExcluded,
        new Set([30382, 30383, 30384, 30385]),
      );
    });

    it("should parse comma-separated kind numbers", () => {
      const config = new Config(
        new Map([["HISTORY_KINDS_EXCLUDED", "3,10002"]]),
      );
      assert.deepEqual(config.historyKindsExcluded, new Set([3, 10002]));
    });

    it("should return empty set for empty string", () => {
      const config = new Config(new Map([["HISTORY_KINDS_EXCLUDED", ""]]));
      assert.deepEqual(config.historyKindsExcluded, new Set());
    });
  });
});
