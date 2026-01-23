import { Hono } from "hono";
import { cors } from "hono/cors";
import process from "node:process";

import { Config } from "./config.ts";

const config = new Config({
  get(key) {
    return process.env[key];
  },
});

const app = new Hono<{ Variables: { config: Config } }>()
  .use(cors())
  .use(async (c, next) => {
    c.set("config", config);
    await next();
  });

// FIXME: Replace with actual routes
app.get("/", (c) => {
  return c.json({
    message: "Hello from Gleestack!",
  });
});

export default app;
