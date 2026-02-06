import process from "node:process";
import type { ServerWebSocket } from "bun";
import type { Filter, NostrEvent } from "nostr-tools";
import { verifyEvent } from "nostr-tools";

import { Config } from "./config.ts";
import { createOpenSearchClient, initializeIndex } from "./opensearch.ts";
import { EventQuery } from "./query.ts";
import { EventStorage } from "./storage.ts";

const config = new Config({
  get(key) {
    return process.env[key];
  },
});

// Initialize OpenSearch client
const opensearchClient = createOpenSearchClient(config);
const indexName = config.opensearchIndex;

// Initialize index on startup
try {
  await initializeIndex(opensearchClient, indexName);
  console.log("Connected to OpenSearch and initialized index");
} catch (error) {
  console.error("Failed to connect to OpenSearch:", error);
  console.error(`Make sure OpenSearch is running at ${config.opensearchNode}`);
  process.exit(1);
}

const storage = new EventStorage(opensearchClient, indexName);
const query = new EventQuery(opensearchClient, indexName);

// Track subscriptions per connection
interface Subscription {
  id: string;
  filters: Filter[];
}

interface WebSocketData {
  subscriptions: Map<string, Subscription>;
}

// NIP-11 relay information document
const relayInfo = {
  name: "Ditto Relay",
  description: "A Nostr relay backed by OpenSearch",
  pubkey: "",
  contact: "",
  supported_nips: [1, 9, 11, 50],
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
};

// Helper to send JSON message to client
function sendMessage(ws: ServerWebSocket<WebSocketData>, message: unknown[]) {
  ws.send(JSON.stringify(message));
}

// Handle EVENT message
async function handleEvent(
  ws: ServerWebSocket<WebSocketData>,
  event: NostrEvent,
) {
  try {
    // Verify event signature
    const isValid = verifyEvent(event);
    if (!isValid) {
      sendMessage(ws, [
        "OK",
        event.id,
        false,
        "invalid: signature verification failed",
      ]);
      return;
    }

    // Handle deletion events (kind 5)
    if (event.kind === 5) {
      const deletedCount = await storage.deleteEvents(event);
      sendMessage(ws, [
        "OK",
        event.id,
        true,
        `deleted: ${deletedCount} events deleted`,
      ]);
      return;
    }

    // Store the event
    const stored = await storage.storeEvent(event);

    if (stored) {
      sendMessage(ws, ["OK", event.id, true, ""]);
      // Broadcast event to all clients with matching subscriptions
      // Note: In a production relay, you'd iterate through all connected clients
    } else {
      sendMessage(ws, [
        "OK",
        event.id,
        true,
        "duplicate: already have this event",
      ]);
    }
  } catch (error) {
    console.error("Error handling EVENT:", error);
    const message = error instanceof Error ? error.message : String(error);
    sendMessage(ws, ["OK", event.id, false, `error: ${message}`]);
  }
}

// Handle REQ message
async function handleReq(
  ws: ServerWebSocket<WebSocketData>,
  subscriptionId: string,
  filters: Filter[],
) {
  try {
    const data = ws.data;

    // Validate subscription ID
    if (!subscriptionId || subscriptionId.length > 100) {
      sendMessage(ws, [
        "CLOSED",
        subscriptionId,
        "invalid: subscription ID too long or empty",
      ]);
      return;
    }

    // Validate filters
    if (!Array.isArray(filters) || filters.length === 0) {
      sendMessage(ws, [
        "CLOSED",
        subscriptionId,
        "invalid: filters must be a non-empty array",
      ]);
      return;
    }

    if (filters.length > 100) {
      sendMessage(ws, ["CLOSED", subscriptionId, "invalid: too many filters"]);
      return;
    }

    // Check subscription limit
    if (data.subscriptions.size >= 20) {
      sendMessage(ws, [
        "CLOSED",
        subscriptionId,
        "rate-limited: too many subscriptions",
      ]);
      return;
    }

    // Store subscription
    data.subscriptions.set(subscriptionId, { id: subscriptionId, filters });

    // Query and send existing events
    const events = await query.query(filters);

    for (const event of events) {
      sendMessage(ws, ["EVENT", subscriptionId, event]);
    }

    // Send EOSE (End of Stored Events)
    sendMessage(ws, ["EOSE", subscriptionId]);
  } catch (error) {
    console.error("Error handling REQ:", error);
    const message = error instanceof Error ? error.message : String(error);
    sendMessage(ws, ["CLOSED", subscriptionId, `error: ${message}`]);
  }
}

// Handle CLOSE message
function handleClose(
  ws: ServerWebSocket<WebSocketData>,
  subscriptionId: string,
) {
  const data = ws.data;
  data.subscriptions.delete(subscriptionId);
}

// Create Bun server with WebSocket support
const server = Bun.serve<WebSocketData>({
  port: config.port,
  fetch(req, server) {
    const url = new URL(req.url);

    // Handle WebSocket upgrade
    if (url.pathname === "/" && req.headers.get("upgrade") === "websocket") {
      const upgraded = server.upgrade(req, {
        data: {
          subscriptions: new Map<string, Subscription>(),
        },
      });

      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      return undefined;
    }

    // Handle NIP-11 relay information document
    if (url.pathname === "/" && req.method === "GET") {
      const acceptHeader = req.headers.get("accept");

      if (acceptHeader?.includes("application/nostr+json")) {
        return new Response(JSON.stringify(relayInfo), {
          headers: {
            "Content-Type": "application/nostr+json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      return new Response(
        "This is a Nostr relay. Connect using a WebSocket client or add application/nostr+json Accept header for relay info.",
        {
          headers: {
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(_ws) {
      console.log("WebSocket connection opened");
    },

    async message(ws, message) {
      try {
        const msg = JSON.parse(message.toString());

        if (!Array.isArray(msg) || msg.length === 0) {
          sendMessage(ws, [
            "NOTICE",
            "invalid: message must be a non-empty JSON array",
          ]);
          return;
        }

        const [type, ...params] = msg;

        switch (type) {
          case "EVENT":
            if (params.length !== 1) {
              sendMessage(ws, [
                "NOTICE",
                "invalid: EVENT message must have exactly 1 parameter",
              ]);
              return;
            }
            await handleEvent(ws, params[0] as NostrEvent);
            break;

          case "REQ": {
            if (params.length < 2) {
              sendMessage(ws, [
                "NOTICE",
                "invalid: REQ message must have subscription ID and at least 1 filter",
              ]);
              return;
            }
            const [subId, ...filters] = params;
            await handleReq(ws, subId as string, filters as Filter[]);
            break;
          }

          case "CLOSE":
            if (params.length !== 1) {
              sendMessage(ws, [
                "NOTICE",
                "invalid: CLOSE message must have exactly 1 parameter",
              ]);
              return;
            }
            handleClose(ws, params[0] as string);
            break;

          default:
            sendMessage(ws, [
              "NOTICE",
              `invalid: unknown message type: ${type}`,
            ]);
        }
      } catch (error) {
        console.error("Error processing message:", error);
        sendMessage(ws, ["NOTICE", "error: failed to process message"]);
      }
    },

    close(ws) {
      console.log("WebSocket connection closed");
      ws.data?.subscriptions.clear();
    },
  },
});

console.log(`Nostr relay listening on ws://localhost:${server.port}`);
