import { Hono } from "hono";
import { cors } from "hono/cors";
import process from "node:process";

import { Config } from "./config.ts";
import { createOpenSearchClient, initializeIndex } from "./opensearch.ts";
import { createRelayRouter } from "./relay.ts";

const config = new Config({
  get(key) {
    return process.env[key];
  },
});

// Initialize OpenSearch client
const opensearchClient = createOpenSearchClient(config);
const indexName = config.opensearchIndex;

// Initialize index on startup
await initializeIndex(opensearchClient, indexName);

const app = new Hono<{ Variables: { config: Config } }>()
  .use(cors())
  .use(async (c, next) => {
    c.set("config", config);
    await next();
  });

// Mount relay routes
const relayRouter = createRelayRouter(opensearchClient, indexName);
app.route("/", relayRouter);

export default app;
