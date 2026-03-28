/**
 * Lightweight Prometheus metrics — drop-in replacement for prom-client.
 *
 * prom-client's `inc()` and `observe()` do expensive label-object hashing on
 * every call (~7% CPU in profiles).  This module provides the same Counter,
 * Gauge, and Histogram API with near-zero per-call overhead by using simple
 * string-keyed Maps.
 *
 * The `register` singleton serialises metrics in the Prometheus exposition
 * format expected by `/metrics`.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a labels object `{ verb: "REQ" }` to a stable string key. */
function labelKey(labels: Record<string, string | number>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return "";
  if (keys.length === 1) return `${keys[0]}="${labels[keys[0]]}"`;
  keys.sort();
  return keys.map((k) => `${k}="${labels[k]}"`).join(",");
}

/** Format a labels key as Prometheus label string: `{verb="REQ"}` */
function fmtLabels(key: string): string {
  return key ? `{${key}}` : "";
}

// ---------------------------------------------------------------------------
// Counter
// ---------------------------------------------------------------------------

interface CounterOpts {
  name: string;
  help: string;
  labelNames?: readonly string[];
}

export class Counter {
  readonly name: string;
  readonly help: string;
  private values = new Map<string, number>();

  constructor(opts: CounterOpts) {
    this.name = opts.name;
    this.help = opts.help;
    register._register(this);
  }

  inc(labelsOrValue?: Record<string, string | number> | number, value?: number): void {
    if (typeof labelsOrValue === "number" || labelsOrValue === undefined) {
      const key = "";
      this.values.set(key, (this.values.get(key) ?? 0) + (labelsOrValue ?? 1));
    } else {
      const key = labelKey(labelsOrValue);
      this.values.set(key, (this.values.get(key) ?? 0) + (value ?? 1));
    }
  }

  /** Serialize to Prometheus exposition format lines. */
  serialize(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} counter`);
    for (const [key, val] of this.values) {
      lines.push(`${this.name}${fmtLabels(key)} ${val}`);
    }
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Gauge
// ---------------------------------------------------------------------------

interface GaugeOpts {
  name: string;
  help: string;
  labelNames?: readonly string[];
}

export class Gauge {
  readonly name: string;
  readonly help: string;
  private values = new Map<string, number>();

  constructor(opts: GaugeOpts) {
    this.name = opts.name;
    this.help = opts.help;
    register._register(this);
  }

  set(labelsOrValue?: Record<string, string | number> | number, value?: number): void {
    if (typeof labelsOrValue === "number") {
      this.values.set("", labelsOrValue);
    } else if (labelsOrValue !== undefined && typeof labelsOrValue === "object") {
      const key = labelKey(labelsOrValue);
      this.values.set(key, value ?? 0);
    }
  }

  inc(labelsOrValue?: Record<string, string | number> | number, value?: number): void {
    if (typeof labelsOrValue === "number" || labelsOrValue === undefined) {
      const key = "";
      this.values.set(key, (this.values.get(key) ?? 0) + (labelsOrValue ?? 1));
    } else {
      const key = labelKey(labelsOrValue);
      this.values.set(key, (this.values.get(key) ?? 0) + (value ?? 1));
    }
  }

  serialize(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} gauge`);
    for (const [key, val] of this.values) {
      lines.push(`${this.name}${fmtLabels(key)} ${val}`);
    }
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

interface HistogramOpts {
  name: string;
  help: string;
  labelNames?: readonly string[];
  buckets?: number[];
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface HistogramData {
  buckets: number[];  // counts per bucket boundary
  sum: number;
  count: number;
}

export class Histogram {
  readonly name: string;
  readonly help: string;
  private readonly boundaries: number[];
  private data = new Map<string, HistogramData>();

  constructor(opts: HistogramOpts) {
    this.name = opts.name;
    this.help = opts.help;
    this.boundaries = opts.buckets ?? DEFAULT_BUCKETS;
    register._register(this);
  }

  private getOrCreate(key: string): HistogramData {
    let d = this.data.get(key);
    if (!d) {
      d = { buckets: new Array(this.boundaries.length).fill(0), sum: 0, count: 0 };
      this.data.set(key, d);
    }
    return d;
  }

  observe(labelsOrValue: Record<string, string | number> | number, value?: number): void {
    let key: string;
    let v: number;
    if (typeof labelsOrValue === "number") {
      key = "";
      v = labelsOrValue;
    } else {
      key = labelKey(labelsOrValue);
      v = value!;
    }
    const d = this.getOrCreate(key);
    d.sum += v;
    d.count++;
    // Increment only the first matching bucket (non-cumulative storage).
    // The serialize step accumulates them into cumulative counts.
    for (let i = 0; i < this.boundaries.length; i++) {
      if (v <= this.boundaries[i]) {
        d.buckets[i]++;
        break;
      }
    }
  }

  /** Returns a function that, when called, observes the elapsed time in seconds. */
  startTimer(labels?: Record<string, string | number>): () => void {
    const start = performance.now();
    return () => {
      const elapsed = (performance.now() - start) / 1000;
      if (labels) {
        this.observe(labels, elapsed);
      } else {
        this.observe(elapsed);
      }
    };
  }

  serialize(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} histogram`);
    for (const [key, d] of this.data) {
      const lblPrefix = key ? `{${key},` : "{";
      const lblSuffix = "}";
      let cumulative = 0;
      for (let i = 0; i < this.boundaries.length; i++) {
        cumulative += d.buckets[i];
        lines.push(`${this.name}_bucket${lblPrefix}le="${this.boundaries[i]}"${lblSuffix} ${cumulative}`);
      }
      lines.push(`${this.name}_bucket${lblPrefix}le="+Inf"${lblSuffix} ${d.count}`);
      lines.push(`${this.name}_sum${fmtLabels(key)} ${d.sum}`);
      lines.push(`${this.name}_count${fmtLabels(key)} ${d.count}`);
    }
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

class Registry {
  private collectors: Array<{ serialize(): string }> = [];

  readonly contentType = "text/plain; version=0.0.4; charset=utf-8";

  _register(collector: { serialize(): string }): void {
    this.collectors.push(collector);
  }

  async metrics(): Promise<string> {
    return this.collectors.map((c) => c.serialize()).join("\n\n") + "\n";
  }
}

export const register = new Registry();

// ---------------------------------------------------------------------------
// Relay metrics
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
// OpenSearch metrics
// ---------------------------------------------------------------------------

/** Total events indexed into OpenSearch, labeled by kind. */
export const opensearchEventsCounter = new Counter({
  name: "ditto_opensearch_events_total",
  help: "Total events indexed into OpenSearch",
  labelNames: ["kind"] as const,
});

/** Total OpenSearch queries executed, labeled by type (req, sort, count, slot_resolution, aggregation). */
export const opensearchQueriesCounter = new Counter({
  name: "ditto_opensearch_queries_total",
  help: "Total OpenSearch queries executed",
  labelNames: ["type"] as const,
});

/** Duration of OpenSearch queries in seconds, labeled by type. */
export const opensearchQueryDurationHistogram = new Histogram({
  name: "ditto_opensearch_query_duration_seconds",
  help: "Duration of OpenSearch queries in seconds",
  labelNames: ["type"] as const,
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

/** Number of queries per _msearch batch, labeled by lane (light, heavy). */
export const opensearchMsearchBatchSizeHistogram = new Histogram({
  name: "ditto_opensearch_msearch_batch_size",
  help: "Number of queries per msearch batch",
  labelNames: ["lane"] as const,
  buckets: [1, 2, 3, 5, 8, 13, 21, 34, 55],
});

/** Duration of _msearch HTTP calls in seconds, labeled by lane (light, heavy). */
export const opensearchMsearchDurationHistogram = new Histogram({
  name: "ditto_opensearch_msearch_duration_seconds",
  help: "Duration of msearch HTTP calls in seconds",
  labelNames: ["lane"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

// ---------------------------------------------------------------------------
// Relay broadcast metrics
// ---------------------------------------------------------------------------

/** Current size of the broadcast queue. */
export const relayBroadcastQueueGauge = new Gauge({
  name: "ditto_relay_broadcast_queue_size",
  help: "Current size of the relay broadcast queue",
});

// ---------------------------------------------------------------------------
// Analyze pool metrics
// ---------------------------------------------------------------------------

/** Pending analysis requests in the worker pool. */
export const analyzePendingGauge = new Gauge({
  name: "ditto_analyze_pending",
  help: "Pending analysis requests in the worker pool",
});
