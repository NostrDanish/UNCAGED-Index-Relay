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

import { opensearchSearchDurationHistogram } from "./metrics.ts";

/** Options accepted by the client constructor. */
export interface ClientOptions {
  /** Base URL of the OpenSearch node, e.g. `http://localhost:9200`. */
  node?: string;
  /** Optional basic-auth credentials. */
  auth?: { username: string; password: string };
}

/** Thin wrapper so callers can access `response.body` like opensearch-js. */
interface ApiResponse<T> {
  body: T;
}

/**
 * The read-path surface the relay's query layer needs from a client. Both the
 * in-process {@link Client} and the worker-backed search pool implement this,
 * so {@link OpenSearchRelay} can be given either as its read client.
 */
export interface SearchClient {
  search<TSource = unknown>(params: {
    index: string;
    body: unknown;
  }): Promise<ApiResponse<SearchResponseBody<TSource>>>;
  msearch<TSource = unknown>(
    searches: Array<{ index: string; body: unknown }>,
  ): Promise<ApiResponse<{ responses: Array<MsearchResponseItem<TSource>> }>>;
  count(params: {
    index: string;
    body: unknown;
  }): Promise<ApiResponse<{ count: number }>>;
  close(): Promise<void>;
}

/** A single hit in a search response. */
export interface SearchHit<TSource = unknown> {
  _id?: string;
  _index?: string;
  _source?: TSource;
  sort?: Array<string | number>;
}

/** Body of a `/_search` response (only the fields the relay uses). */
export interface SearchResponseBody<TSource = unknown> {
  hits: {
    total?: { value?: number; relation?: string };
    hits: Array<SearchHit<TSource>>;
  };
  aggregations?: Record<string, unknown>;
}

/**
 * One entry of a `/_msearch` `responses` array: either a search response
 * body or an error object.
 */
export interface MsearchResponseItem<TSource = unknown> {
  error?: unknown;
  status?: number;
  hits?: {
    total?: { value?: number; relation?: string };
    hits?: Array<SearchHit<TSource>>;
  };
  aggregations?: Record<string, unknown>;
}

/**
 * One item of a `/_bulk` response, keyed by the action that produced it
 * (`index`, `update`, `delete`, or `create`).
 */
export type BulkResponseItem = Record<
  string,
  { error?: unknown; status?: number }
>;

/** Index-scoped helper exposed as `client.indices.*`. */
class IndicesApi {
  constructor(private _request: Client["_request"]) {}

  /** HEAD /{index} — returns `{ body: boolean }`. */
  async exists(params: { index: string }): Promise<ApiResponse<boolean>> {
    const res = await this._request(
      "HEAD",
      `/${encodeURIComponent(params.index)}`,
    );
    return { body: res.status === 200 };
  }

  /** HEAD /_alias/{name} — returns `{ body: boolean }`. */
  async existsAlias(params: { name: string }): Promise<ApiResponse<boolean>> {
    const res = await this._request(
      "HEAD",
      `/_alias/${encodeURIComponent(params.name)}`,
    );
    return { body: res.status === 200 };
  }

  /** PUT /{index} */
  async create(params: {
    index: string;
    body?: unknown;
  }): Promise<ApiResponse<unknown>> {
    const res = await this._request(
      "PUT",
      `/${encodeURIComponent(params.index)}`,
      params.body,
    );
    return { body: await res.json() };
  }

  /** POST /{index}/_close */
  async close(params: { index: string }): Promise<ApiResponse<unknown>> {
    const res = await this._request(
      "POST",
      `/${encodeURIComponent(params.index)}/_close`,
    );
    return { body: await res.json() };
  }

  /** POST /{index}/_open */
  async open(params: { index: string }): Promise<ApiResponse<unknown>> {
    const res = await this._request(
      "POST",
      `/${encodeURIComponent(params.index)}/_open`,
    );
    return { body: await res.json() };
  }

  /** PUT /{index}/_settings */
  async putSettings(params: {
    index: string;
    body?: unknown;
  }): Promise<ApiResponse<unknown>> {
    const res = await this._request(
      "PUT",
      `/${encodeURIComponent(params.index)}/_settings`,
      params.body,
    );
    return { body: await res.json() };
  }

  /** PUT /{index}/_mapping */
  async putMapping(params: {
    index: string;
    body?: unknown;
  }): Promise<ApiResponse<unknown>> {
    const res = await this._request(
      "PUT",
      `/${encodeURIComponent(params.index)}/_mapping`,
      params.body,
    );
    return { body: await res.json() };
  }
}

/** Fetch-based OpenSearch client. */
export class Client {
  private baseUrl: string;
  private authHeader: string | undefined;
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
    if (this.authHeader) headers.Authorization = this.authHeader;

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
      throw new Error(
        `OpenSearch ${method} ${path} responded ${res.status}: ${text}`,
      );
    }

    return res;
  }

  // ---------------------------------------------------------------------------
  // Document APIs
  // ---------------------------------------------------------------------------

  /** POST /{index}/_search */
  async search<TSource = unknown>(params: {
    index: string;
    body: unknown;
  }): Promise<ApiResponse<SearchResponseBody<TSource>>> {
    const end = opensearchSearchDurationHistogram.startTimer();
    const res = await this._request(
      "POST",
      `/${encodeURIComponent(params.index)}/_search`,
      params.body,
    );
    const body = (await res.json()) as SearchResponseBody<TSource>;
    end();
    return { body };
  }

  /**
   * POST /_msearch
   *
   * Sends multiple searches in a single HTTP request using NDJSON format.
   * Each search is a pair of lines: a header (with `index`) and a body
   * (the search query).
   */
  async msearch<TSource = unknown>(
    searches: Array<{ index: string; body: unknown }>,
  ): Promise<ApiResponse<{ responses: Array<MsearchResponseItem<TSource>> }>> {
    // Build NDJSON payload: header + body per search, trailing newline.
    const lines: string[] = [];
    for (const s of searches) {
      lines.push(JSON.stringify({ index: s.index }));
      lines.push(typeof s.body === "string" ? s.body : JSON.stringify(s.body));
    }
    const ndjson = `${lines.join("\n")}\n`;

    const url = `${this.baseUrl}/_msearch`;

    const headers: Record<string, string> = {
      "Content-Type": "application/x-ndjson",
    };
    if (this.authHeader) headers.Authorization = this.authHeader;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: ndjson,
    });

    if (res.status >= 500) {
      const text = await res.text();
      throw new Error(
        `OpenSearch POST /_msearch responded ${res.status}: ${text}`,
      );
    }

    return {
      body: (await res.json()) as {
        responses: Array<MsearchResponseItem<TSource>>;
      },
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
  }): Promise<ApiResponse<{ errors: boolean; items: BulkResponseItem[] }>> {
    // Build NDJSON payload.
    const ndjson = `${params.body.map((obj) => JSON.stringify(obj)).join("\n")}\n`;

    const query: Record<string, string> = {};
    if (params.refresh !== undefined) {
      query.refresh = String(params.refresh);
    }

    let url = `${this.baseUrl}/_bulk`;
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/x-ndjson",
    };
    if (this.authHeader) headers.Authorization = this.authHeader;

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
      throw new Error(
        `OpenSearch POST /_bulk responded ${res.status}: ${text}`,
      );
    }

    return {
      body: (await res.json()) as {
        errors: boolean;
        items: BulkResponseItem[];
      },
    };
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
    if (params.refresh !== undefined) query.refresh = String(params.refresh);
    if (params.conflicts !== undefined) query.conflicts = params.conflicts;
    if (params.wait_for_completion !== undefined) {
      query.wait_for_completion = String(params.wait_for_completion);
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
    if (params.refresh !== undefined) query.refresh = String(params.refresh);
    if (params.conflicts !== undefined) query.conflicts = params.conflicts;
    if (params.wait_for_completion !== undefined) {
      query.wait_for_completion = String(params.wait_for_completion);
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
