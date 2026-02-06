import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Client } from "@opensearch-project/opensearch";
import { Config } from "./config.ts";
import { createOpenSearchClient } from "./opensearch.ts";

describe("createOpenSearchClient", () => {
  it("should create client with default node", () => {
    const mockEnv = new Map();
    const config = new Config(mockEnv);

    const client = createOpenSearchClient(config);

    assert.ok(client instanceof Client);
  });

  it("should create client with custom node", () => {
    const mockEnv = new Map([["OPENSEARCH_NODE", "http://example.com:9200"]]);
    const config = new Config(mockEnv);

    const client = createOpenSearchClient(config);

    assert.ok(client instanceof Client);
  });

  it("should create client with auth when credentials provided", () => {
    const mockEnv = new Map([
      ["OPENSEARCH_USERNAME", "admin"],
      ["OPENSEARCH_PASSWORD", "password123"],
    ]);
    const config = new Config(mockEnv);

    const client = createOpenSearchClient(config);

    assert.ok(client instanceof Client);
  });
});
