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

  describe("publicUrl", () => {
    it("should return undefined when PUBLIC_URL is not set", () => {
      const mockEnv = new Map();
      const config = new Config(mockEnv);
      assert.equal(config.publicUrl, undefined);
    });

    it("should return the PUBLIC_URL from environment when set", () => {
      const mockEnv = new Map([["PUBLIC_URL", "https://example.com"]]);
      const config = new Config(mockEnv);
      assert.equal(config.publicUrl, "https://example.com");
    });
  });
});
