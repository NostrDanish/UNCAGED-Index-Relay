import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Config } from "./config.ts";

describe("Config", () => {
  describe("port", () => {
    it("should return default port 13131 when PORT is not set", () => {
      const mockEnv = {
        get: (_key: string) => undefined,
      };
      const config = new Config(mockEnv);
      assert.equal(config.port, 13131);
    });

    it("should return the port from environment when valid", () => {
      const mockEnv = {
        get: (key: string) => key === "PORT" ? "8080" : undefined,
      };
      const config = new Config(mockEnv);
      assert.equal(config.port, 8080);
    });

    it("should throw error when PORT is not a number", () => {
      const mockEnv = {
        get: (key: string) => key === "PORT" ? "invalid" : undefined,
      };
      const config = new Config(mockEnv);
      assert.throws(
        () => config.port,
        {
          message: "PORT must be a valid port number (1-65535).",
        },
      );
    });

    it("should throw error when PORT is below 1", () => {
      const mockEnv = {
        get: (key: string) => key === "PORT" ? "0" : undefined,
      };
      const config = new Config(mockEnv);
      assert.throws(
        () => config.port,
        {
          message: "PORT must be a valid port number (1-65535).",
        },
      );
    });

    it("should throw error when PORT is above 65535", () => {
      const mockEnv = {
        get: (key: string) => key === "PORT" ? "65536" : undefined,
      };
      const config = new Config(mockEnv);
      assert.throws(
        () => config.port,
        {
          message: "PORT must be a valid port number (1-65535).",
        },
      );
    });

    it("should accept PORT at boundary values", () => {
      const mockEnvMin = {
        get: (key: string) => key === "PORT" ? "1" : undefined,
      };
      const configMin = new Config(mockEnvMin);
      assert.equal(configMin.port, 1);

      const mockEnvMax = {
        get: (key: string) => key === "PORT" ? "65535" : undefined,
      };
      const configMax = new Config(mockEnvMax);
      assert.equal(configMax.port, 65535);
    });
  });

  describe("publicUrl", () => {
    it("should return undefined when PUBLIC_URL is not set", () => {
      const mockEnv = {
        get: (_key: string) => undefined,
      };
      const config = new Config(mockEnv);
      assert.equal(config.publicUrl, undefined);
    });

    it("should return the PUBLIC_URL from environment when set", () => {
      const mockEnv = {
        get: (key: string) =>
          key === "PUBLIC_URL" ? "https://example.com" : undefined,
      };
      const config = new Config(mockEnv);
      assert.equal(config.publicUrl, "https://example.com");
    });
  });
});
