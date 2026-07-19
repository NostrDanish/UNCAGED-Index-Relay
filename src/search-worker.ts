/// Worker thread that performs OpenSearch read requests off the main thread.
///
/// The relay's WebSocket event loop is single-threaded. CPU profiles under
/// production load showed the OpenSearch read round-trip — building the
/// request JSON (`JSON.stringify`), the `fetch` syscalls, and parsing the
/// response (`res.json()`) — consuming ~20% of main-thread CPU, which is
/// exactly the budget that tips the loop into metastable congestion collapse
/// at peak. The box has many idle cores, so this worker moves that
/// stringify + fetch + parse work off the main thread.
///
/// Receives batches of requests (correlation id + operation + payload) and
/// responds with batches of parsed results to amortize the postMessage
/// structured-clone cost, mirroring the analyze-worker batching strategy.

declare var self: Worker;

export interface SearchWorkerConfig {
  node: string;
  auth?: { username: string; password: string };
}

/** A single search: `POST /{index}/_search`. */
export interface SearchOp {
  reqId: number;
  op: "search";
  index: string;
  body: unknown;
}

/** A multi-search: `POST /_msearch` (NDJSON). */
export interface MsearchOp {
  reqId: number;
  op: "msearch";
  searches: Array<{ index: string; body: unknown }>;
}

/** A count: `POST /{index}/_count`. */
export interface CountOp {
  reqId: number;
  op: "count";
  index: string;
  body: unknown;
}

export type SearchWorkerRequest = SearchOp | MsearchOp | CountOp;

/** Successful result: the parsed response body. Errors carry `err`. */
export interface SearchWorkerResult {
  reqId: number;
  body?: unknown;
  err?: string;
}

// The worker is configured once, via the first message it receives.
let baseUrl = "";
let authHeader: string | undefined;

function configure(config: SearchWorkerConfig): void {
  baseUrl = config.node.replace(/\/+$/, "");
  if (config.auth) {
    const encoded = btoa(`${config.auth.username}:${config.auth.password}`);
    authHeader = `Basic ${encoded}`;
  }
  self.postMessage("ready");
}

async function runSearch(op: SearchOp): Promise<unknown> {
  const url = `${baseUrl}/${encodeURIComponent(op.index)}/_search`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authHeader) headers.Authorization = authHeader;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(op.body),
  });
  if (res.status >= 500) {
    const text = await res.text();
    throw new Error(`OpenSearch POST _search responded ${res.status}: ${text}`);
  }
  return await res.json();
}

async function runMsearch(op: MsearchOp): Promise<unknown> {
  const lines: string[] = [];
  for (const s of op.searches) {
    lines.push(JSON.stringify({ index: s.index }));
    lines.push(typeof s.body === "string" ? s.body : JSON.stringify(s.body));
  }
  const ndjson = `${lines.join("\n")}\n`;
  const headers: Record<string, string> = {
    "Content-Type": "application/x-ndjson",
  };
  if (authHeader) headers.Authorization = authHeader;
  const res = await fetch(`${baseUrl}/_msearch`, {
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
  return await res.json();
}

async function runCount(op: CountOp): Promise<unknown> {
  const url = `${baseUrl}/${encodeURIComponent(op.index)}/_count`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authHeader) headers.Authorization = authHeader;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(op.body),
  });
  if (res.status >= 500) {
    const text = await res.text();
    throw new Error(`OpenSearch POST _count responded ${res.status}: ${text}`);
  }
  return await res.json();
}

async function runOne(req: SearchWorkerRequest): Promise<SearchWorkerResult> {
  try {
    let body: unknown;
    if (req.op === "search") {
      body = await runSearch(req);
    } else if (req.op === "msearch") {
      body = await runMsearch(req);
    } else {
      body = await runCount(req);
    }
    return { reqId: req.reqId, body };
  } catch (error) {
    return {
      reqId: req.reqId,
      err: error instanceof Error ? error.message : String(error),
    };
  }
}

self.onmessage = async (
  event: MessageEvent<SearchWorkerConfig | SearchWorkerRequest[]>,
) => {
  const data = event.data;
  // First message configures the worker; subsequent messages are batches.
  if (!Array.isArray(data)) {
    configure(data);
    return;
  }
  // Fire all requests in the batch concurrently — each is I/O-bound on
  // OpenSearch, so awaiting them in parallel keeps the worker busy and
  // returns results as a single batched postMessage.
  const results = await Promise.all(data.map(runOne));
  self.postMessage(results);
};
