/**
 * Lightweight fetch-based OpenSearch client.
 *
 * Drop-in replacement for `@opensearch-project/opensearch` `Client` that uses
 * the runtime's native `fetch()` instead of Node.js `http` module.  This
 * eliminates the ~55% CPU overhead from Node.js streams/event-emitters that
 * showed up in Bun CPU profiles.
 *
 * Only the methods actually used by the relay are implemented.  Every method
 * returns `{ body: T }` to match the opensearch-js response shape so that
 * call sites require zero changes.
 */

import {
  opensearchMsearchBatchSizeHistogram,
  opensearchMsearchDurationHistogram,
} from "./metrics.ts";

/** Options accepted by the client constructor. */
export interface ClientOptions {
  /** Base URL of the OpenSearch node, e.g. `http://localhost:9200`. */
  node?: string;
  /** Optional basic-auth credentials. */
  auth?: { username: string; password: string };
  /**
   * When set to a non-negative number, `search()` calls are micro-batched
   * into `_msearch` requests.  The value is the maximum time in ms to wait
   * before flushing the batch.  Use `0` to flush on the next microtask
   * (batches everything in the current event-loop tick).  `undefined` or
   * negative values disable batching.
   */
  batchSearchMs?: number;
}

/** Thin wrapper so callers can access `response.body` like opensearch-js. */
interface ApiResponse<T> {
  body: T;
}

/** Index-scoped helper exposed as `client.indices.*`. */
class IndicesApi {
  constructor(private _request: Client["_request"]) {}

  /** HEAD /{index} — returns `{ body: boolean }`. */
  async exists(params: { index: string }): Promise<ApiResponse<boolean>> {
    const res = await this._request("HEAD", `/${encodeURIComponent(params.index)}`);
    return { body: res.status === 200 };
  }

  /** HEAD /_alias/{name} — returns `{ body: boolean }`. */
  async existsAlias(params: { name: string }): Promise<ApiResponse<boolean>> {
    const res = await this._request("HEAD", `/_alias/${encodeURIComponent(params.name)}`);
    return { body: res.status === 200 };
  }

  /** PUT /{index} */
  async create(params: { index: string; body?: unknown }): Promise<ApiResponse<unknown>> {
    const res = await this._request("PUT", `/${encodeURIComponent(params.index)}`, params.body);
    return { body: await res.json() };
  }

  /** POST /{index}/_close */
  async close(params: { index: string }): Promise<ApiResponse<unknown>> {
    const res = await this._request("POST", `/${encodeURIComponent(params.index)}/_close`);
    return { body: await res.json() };
  }

  /** POST /{index}/_open */
  async open(params: { index: string }): Promise<ApiResponse<unknown>> {
    const res = await this._request("POST", `/${encodeURIComponent(params.index)}/_open`);
    return { body: await res.json() };
  }

  /** PUT /{index}/_settings */
  async putSettings(params: { index: string; body?: unknown }): Promise<ApiResponse<unknown>> {
    const res = await this._request("PUT", `/${encodeURIComponent(params.index)}/_settings`, params.body);
    return { body: await res.json() };
  }

  /** PUT /{index}/_mapping */
  async putMapping(params: { index: string; body?: unknown }): Promise<ApiResponse<unknown>> {
    const res = await this._request("PUT", `/${encodeURIComponent(params.index)}/_mapping`, params.body);
    return { body: await res.json() };
  }
}

// ---------------------------------------------------------------------------
// Search batcher — collects concurrent search() calls and flushes them as a
// single _msearch request to reduce HTTP connection pressure.
// ---------------------------------------------------------------------------

/** A pending search waiting to be batched. */
interface PendingSearch {
  index: string;
  body: unknown;
  resolve: (value: ApiResponse<Record<string, unknown>>) => void;
  reject: (reason: unknown) => void;
}

/**
 * Lane hint passed to `search()` to separate user-facing queries from
 * internal infrastructure queries (slot resolution, aggregations, etc.).
 * Queries in different lanes are batched independently so slow internal
 * work never blocks user-facing REQs.
 */
export type SearchLane = "user" | "internal";

/** A single flush lane. */
class BatchLane {
  queue: PendingSearch[] = [];
  timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly name: string,
    private flushFn: (batch: PendingSearch[], lane: string) => Promise<void>,
    private delayMs: number,
  ) {}

  push(item: PendingSearch): void {
    this.queue.push(item);

    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.delayMs);
    }
  }

  private flush(): void {
    this.timer = null;
    const batch = this.queue;
    this.queue = [];
    if (batch.length > 0) {
      this.flushFn(batch, this.name);
    }
  }
}

/**
 * Micro-batches `search()` calls into `_msearch` requests.
 *
 * When the relay has hundreds of concurrent WebSocket clients, each generating
 * a `search()` call, the runtime's HTTP connection pool becomes the bottleneck.
 * By combining N concurrent searches into one HTTP round-trip we reduce
 * connection pressure by ~N×.
 *
 * Queries are split into two lanes — **user** (default) and **internal** —
 * so that user-facing REQs are never blocked by slow internal queries
 * (slot resolution, aggregations) sharing the same `_msearch` response.
 */
export class SearchBatcher {
  private userLane: BatchLane;
  private internalLane: BatchLane;

  constructor(
    private client: Client,
    /** Max ms to wait before flushing. 0 = next microtask. */
    delayMs: number = 0,
  ) {
    const flush = (batch: PendingSearch[], lane: string) => this.flushBatch(batch, lane);
    this.userLane = new BatchLane("user", flush, delayMs);
    this.internalLane = new BatchLane("internal", flush, delayMs);
  }

  /** Enqueue a search and return a Promise for its result. */
  search(params: {
    index: string;
    body: unknown;
    lane?: SearchLane;
  }): Promise<ApiResponse<Record<string, unknown>>> {
    return new Promise<ApiResponse<Record<string, unknown>>>((resolve, reject) => {
      const item: PendingSearch = { index: params.index, body: params.body, resolve, reject };
      const lane = params.lane === "internal"
        ? this.internalLane
        : this.userLane;
      lane.push(item);
    });
  }

  /** Flush a batch of searches as a single _msearch call. */
  private async flushBatch(batch: PendingSearch[], lane: string): Promise<void> {
    opensearchMsearchBatchSizeHistogram.observe({ lane }, batch.length);

    // Single-query fast path: skip msearch overhead.
    if (batch.length === 1) {
      const item = batch[0];
      const end = opensearchMsearchDurationHistogram.startTimer({ lane });
      try {
        const result = await this.client.searchDirect({
          index: item.index,
          body: item.body,
        });
        end();
        item.resolve(result);
      } catch (err) {
        end();
        item.reject(err);
      }
      return;
    }

    const end = opensearchMsearchDurationHistogram.startTimer({ lane });
    try {
      const result = await this.client.msearch(
        batch.map((item) => ({ index: item.index, body: item.body })),
      );
      end();
      const responses = result.body.responses;

      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        const resp = responses[i];
        if (resp && (resp as Record<string, unknown>).status !== undefined) {
          const status = (resp as Record<string, unknown>).status as number;
          if (status >= 500) {
            item.reject(
              new Error(`OpenSearch msearch sub-query ${i} responded ${status}: ${JSON.stringify(resp)}`),
            );
            continue;
          }
        }
        item.resolve({ body: resp as Record<string, unknown> });
      }
    } catch (err) {
      end();
      // Whole msearch failed — reject all pending.
      for (const item of batch) {
        item.reject(err);
      }
    }
  }
}

/** Fetch-based OpenSearch client. */
export class Client {
  private baseUrl: string;
  private authHeader: string | undefined;
  private batcher: SearchBatcher | null = null;
  readonly indices: IndicesApi;

  constructor(opts?: ClientOptions) {
    // Strip trailing slash for clean URL joins.
    this.baseUrl = (opts?.node ?? "http://localhost:9200").replace(/\/+$/, "");

    if (opts?.auth) {
      const encoded = btoa(`${opts.auth.username}:${opts.auth.password}`);
      this.authHeader = `Basic ${encoded}`;
    }

    // Bind `_request` so IndicesApi can call it without losing `this`.
    this._request = this._request.bind(this);
    this.indices = new IndicesApi(this._request);

    // Enable search batching when configured.
    if (opts?.batchSearchMs !== undefined && opts.batchSearchMs >= 0) {
      this.batcher = new SearchBatcher(this, opts.batchSearchMs);
    }
  }

  // ---------------------------------------------------------------------------
  // Core HTTP helper
  // ---------------------------------------------------------------------------

  /** Low-level request.  Returns the raw `Response` for status-code checks. */
  async _request(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<Response> {
    let url = `${this.baseUrl}${path}`;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = {};
    if (this.authHeader) headers["Authorization"] = this.authHeader;

    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    const res = await fetch(url, init);

    // Throw on server errors (5xx) to match opensearch-js behaviour.
    // 4xx codes (404, 409, etc.) are often expected and handled by callers.
    if (res.status >= 500) {
      const text = await res.text();
      throw new Error(`OpenSearch ${method} ${path} responded ${res.status}: ${text}`);
    }

    return res;
  }

  // ---------------------------------------------------------------------------
  // Document APIs
  // ---------------------------------------------------------------------------

  /**
   * POST /{index}/_search
   *
   * When batching is enabled, concurrent calls are transparently combined
   * into a single `_msearch` request.  Pass `lane: "internal"` for
   * infrastructure queries (slot resolution, aggregations) so they don't
   * block user-facing REQs.
   */
  async search(params: {
    index: string;
    body: unknown;
    lane?: SearchLane;
  }): Promise<ApiResponse<Record<string, unknown>>> {
    if (this.batcher) {
      return this.batcher.search(params);
    }
    return this.searchDirect(params);
  }

  /** Direct (non-batched) POST /{index}/_search. */
  async searchDirect(params: {
    index: string;
    body: unknown;
  }): Promise<ApiResponse<Record<string, unknown>>> {
    const res = await this._request(
      "POST",
      `/${encodeURIComponent(params.index)}/_search`,
      params.body,
    );
    return { body: (await res.json()) as Record<string, unknown> };
  }

  /**
   * POST /_msearch
   *
   * Sends multiple searches in a single HTTP request using NDJSON format.
   * Each search is a pair of lines: a header (with `index`) and a body
   * (the search query).
   */
  async msearch(
    searches: Array<{ index: string; body: unknown }>,
  ): Promise<ApiResponse<{ responses: Array<Record<string, unknown>> }>> {
    // Build NDJSON payload: header + body per search, trailing newline.
    const lines: string[] = [];
    for (const s of searches) {
      lines.push(JSON.stringify({ index: s.index }));
      lines.push(typeof s.body === "string" ? s.body : JSON.stringify(s.body));
    }
    const ndjson = lines.join("\n") + "\n";

    let url = `${this.baseUrl}/_msearch`;

    const headers: Record<string, string> = {
      "Content-Type": "application/x-ndjson",
    };
    if (this.authHeader) headers["Authorization"] = this.authHeader;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: ndjson,
    });

    if (res.status >= 500) {
      const text = await res.text();
      throw new Error(`OpenSearch POST /_msearch responded ${res.status}: ${text}`);
    }

    return {
      body: (await res.json()) as { responses: Array<Record<string, unknown>> },
    };
  }

  /** POST /{index}/_count */
  async count(params: {
    index: string;
    body: unknown;
  }): Promise<ApiResponse<{ count: number }>> {
    const res = await this._request(
      "POST",
      `/${encodeURIComponent(params.index)}/_count`,
      params.body,
    );
    return { body: (await res.json()) as { count: number } };
  }

  /**
   * POST /_bulk
   *
   * The `body` array is serialised to NDJSON (one JSON object per line,
   * terminated by a final newline).  `refresh` is sent as a query-string
   * parameter.
   */
  async bulk(params: {
    body: unknown[];
    refresh?: boolean | "wait_for" | "true" | "false";
    signal?: AbortSignal;
  }): Promise<ApiResponse<{ errors: boolean; items: unknown[] }>> {
    // Build NDJSON payload.
    const ndjson = params.body.map((obj) => JSON.stringify(obj)).join("\n") + "\n";

    const query: Record<string, string> = {};
    if (params.refresh !== undefined) {
      query["refresh"] = String(params.refresh);
    }

    let url = `${this.baseUrl}/_bulk`;
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/x-ndjson",
    };
    if (this.authHeader) headers["Authorization"] = this.authHeader;

    const init: RequestInit = {
      method: "POST",
      headers,
      body: ndjson,
    };
    if (params.signal) {
      init.signal = params.signal;
    }

    const res = await fetch(url, init);
    if (res.status >= 500) {
      const text = await res.text();
      throw new Error(`OpenSearch POST /_bulk responded ${res.status}: ${text}`);
    }

    return { body: (await res.json()) as { errors: boolean; items: unknown[] } };
  }

  /** POST /{index}/_delete_by_query */
  async deleteByQuery(params: {
    index: string;
    body: unknown;
    refresh?: boolean | "wait_for" | "true" | "false";
    conflicts?: string;
    wait_for_completion?: boolean;
  }): Promise<ApiResponse<unknown>> {
    const query: Record<string, string> = {};
    if (params.refresh !== undefined) query["refresh"] = String(params.refresh);
    if (params.conflicts !== undefined) query["conflicts"] = params.conflicts;
    if (params.wait_for_completion !== undefined) {
      query["wait_for_completion"] = String(params.wait_for_completion);
    }

    const res = await this._request(
      "POST",
      `/${encodeURIComponent(params.index)}/_delete_by_query`,
      params.body,
      query,
    );
    return { body: await res.json() };
  }

  /** POST /{index}/_update_by_query */
  async updateByQuery(params: {
    index: string;
    body: unknown;
    refresh?: boolean | "wait_for" | "true" | "false";
    conflicts?: string;
    wait_for_completion?: boolean;
  }): Promise<ApiResponse<unknown>> {
    const query: Record<string, string> = {};
    if (params.refresh !== undefined) query["refresh"] = String(params.refresh);
    if (params.conflicts !== undefined) query["conflicts"] = params.conflicts;
    if (params.wait_for_completion !== undefined) {
      query["wait_for_completion"] = String(params.wait_for_completion);
    }

    const res = await this._request(
      "POST",
      `/${encodeURIComponent(params.index)}/_update_by_query`,
      params.body,
      query,
    );
    return { body: await res.json() };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** No-op — `fetch` connections are managed by the runtime. */
  async close(): Promise<void> {}
}
