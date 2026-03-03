import { Counter, Gauge, Histogram, register } from "prom-client";

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

/** Total Nostr messages processed by relay, labeled by verb (EVENT, REQ, COUNT, AUTH, CLOSE). */
export const relayMessagesCounter = new Counter({
  name: "ditto_relay_messages_total",
  help: "Total Nostr messages processed by relay",
  labelNames: ["verb"] as const,
});

/** Total EVENT messages processed by relay, labeled by kind. */
export const relayEventsCounter = new Counter({
  name: "ditto_relay_events_total",
  help: "Total EVENT messages processed by relay",
  labelNames: ["kind"] as const,
});

/** Active relay WebSocket connections. */
export const relayConnectionsGauge = new Gauge({
  name: "ditto_relay_connections",
  help: "Active relay connections",
});

// ---------------------------------------------------------------------------
// OpenSearch
// ---------------------------------------------------------------------------

/** Total events indexed into OpenSearch, labeled by kind. */
export const opensearchEventsCounter = new Counter({
  name: "ditto_opensearch_events_total",
  help: "Total events indexed into OpenSearch",
  labelNames: ["kind"] as const,
});

/** Total OpenSearch queries executed. */
export const opensearchQueriesCounter = new Counter({
  name: "ditto_opensearch_queries_total",
  help: "Total OpenSearch queries executed",
});

/** Duration of OpenSearch queries in seconds. */
export const opensearchQueryDurationHistogram = new Histogram({
  name: "ditto_opensearch_query_duration_seconds",
  help: "Duration of OpenSearch queries in seconds",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

/** Current size of the OpenSearch bulk indexing queue. */
export const opensearchBulkQueueGauge = new Gauge({
  name: "ditto_opensearch_bulk_queue_size",
  help: "Current size of the OpenSearch bulk indexing queue",
});

/** Duration of OpenSearch bulk flush operations in seconds. */
export const opensearchFlushDurationHistogram = new Histogram({
  name: "ditto_opensearch_flush_duration_seconds",
  help: "Duration of OpenSearch bulk flush operations in seconds",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

// ---------------------------------------------------------------------------
// Analyze pool
// ---------------------------------------------------------------------------

/** Pending analysis requests in the worker pool. */
export const analyzePendingGauge = new Gauge({
  name: "ditto_analyze_pending",
  help: "Pending analysis requests in the worker pool",
});

// ---------------------------------------------------------------------------
// Export registry for /metrics endpoint
// ---------------------------------------------------------------------------

export { register };
