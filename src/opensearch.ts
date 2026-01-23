import { Client, type ClientOptions } from "@opensearch-project/opensearch";
import type { Config } from "./config.ts";

export function createOpenSearchClient(config: Config): Client {
  const clientOptions: ClientOptions = {
    node: config.opensearchNode,
  };

  if (config.opensearchUsername && config.opensearchPassword) {
    clientOptions.auth = {
      username: config.opensearchUsername,
      password: config.opensearchPassword,
    };
  }

  return new Client(clientOptions);
}

export async function initializeIndex(
  client: Client,
  indexName: string,
): Promise<void> {
  const indexExists = await client.indices.exists({ index: indexName });

  if (!indexExists.body) {
    await client.indices.create({
      index: indexName,
      body: {
        settings: {
          number_of_shards: 3,
          number_of_replicas: 1,
          "index.max_result_window": 100000,
        },
        mappings: {
          properties: {
            id: { type: "keyword" },
            pubkey: { type: "keyword" },
            created_at: { type: "long" },
            kind: { type: "integer" },
            tags: {
              type: "nested",
              properties: {
                0: { type: "keyword" },
                1: { type: "text" },
                2: { type: "text" },
                3: { type: "text" },
              },
            },
            tags_map: {
              type: "object",
              enabled: false,
            },
            content: {
              type: "text",
              analyzer: "standard",
            },
            sig: { type: "keyword" },
            d_tag: { type: "keyword" },
            deleted: { type: "boolean" },
          },
        },
      },
    });
  }
}
