import { Hono } from "hono";
import type { Filter, NostrEvent } from "nostr-tools";
import { verifyEvent } from "nostr-tools";
import type { Client } from "@opensearch-project/opensearch";
import { EventStorage } from "./storage.ts";
import { EventQuery } from "./query.ts";

export function createRelayRouter(
  client: Client,
  indexName: string,
): Hono {
  const app = new Hono();
  const storage = new EventStorage(client, indexName);
  const query = new EventQuery(client, indexName);

  // Handle EVENT messages
  app.post("/event", async (c) => {
    try {
      const event: NostrEvent = await c.req.json();

      // Verify event signature
      const isValid = verifyEvent(event);
      if (!isValid) {
        return c.json({
          ok: false,
          message: "invalid: signature verification failed",
        });
      }

      // Handle deletion events (kind 5)
      if (event.kind === 5) {
        const deletedCount = await storage.deleteEvents(event);
        return c.json({
          ok: true,
          message: `deleted: ${deletedCount} events deleted`,
        });
      }

      // Store the event
      const stored = await storage.storeEvent(event);

      if (stored) {
        return c.json({
          ok: true,
          message: "",
        });
      } else {
        return c.json({
          ok: false,
          message: "duplicate: event rejected (older or duplicate)",
        });
      }
    } catch (error) {
      console.error("Error handling EVENT:", error);
      const message = error instanceof Error ? error.message : String(error);
      return c.json({
        ok: false,
        message: `error: ${message}`,
      });
    }
  });

  // Handle REQ messages
  app.post("/req", async (c) => {
    try {
      const body = await c.req.json();
      const subscriptionId = body.subscription_id;
      const filters: Filter[] = body.filters || [];

      // Query events
      const events = await query.query(filters);

      return c.json({
        subscription_id: subscriptionId,
        events,
      });
    } catch (error) {
      console.error("Error handling REQ:", error);
      const message = error instanceof Error ? error.message : String(error);
      return c.json({
        error: message,
      }, 400);
    }
  });

  // NIP-11: Relay information document
  app.get("/", (c) => {
    const acceptHeader = c.req.header("accept");

    if (acceptHeader?.includes("application/nostr+json")) {
      return c.json({
        name: "Ditto Relay",
        description: "A Nostr relay backed by OpenSearch",
        pubkey: "",
        contact: "",
        supported_nips: [1, 9, 50],
        software: "ditto-relay",
        version: "1.0.0",
        limitation: {
          max_message_length: 128000,
          max_subscriptions: 20,
          max_filters: 100,
          max_limit: 5000,
          max_subid_length: 100,
          max_event_tags: 2000,
          max_content_length: 102400,
          min_pow_difficulty: 0,
          auth_required: false,
          payment_required: false,
        },
        retention: [
          {
            kinds: [0, 1, 2, 3, 4, 5, 6, 7, 16, 40, 41, 42, 43, 44],
          },
        ],
        relay_countries: [],
        language_tags: [],
        tags: [],
        posting_policy: "",
      });
    }

    return c.text("Nostr relay - use application/nostr+json to get relay info");
  });

  return app;
}
