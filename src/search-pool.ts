import { errFields, Logger } from "./log.ts";
import {
  opensearchSearchDurationHistogram,
  searchPoolPendingGauge,
} from "./metrics.ts";
import type {
  MsearchResponseItem,
  SearchClient,
  SearchResponseBody,
} from "./opensearch-client.ts";
import type {
  SearchWorkerConfig,
  SearchWorkerRequest,
  SearchWorkerResult,
} from "./search-worker.ts";

interface ApiResponse<T> {
  body: T;
}

/** A worker request without its (pool-assigned) correlation id. */
type DispatchOp = DistributiveOmit<SearchWorkerRequest, "reqId">;
type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  workerIndex: number;
  /** Timer stop function for the search-duration histogram. */
  endTimer: () => void;
}

/**
 * Pool of Web Workers that perform OpenSearch read requests off the main
 * thread.
 *
 * The relay's WebSocket event loop is single-threaded. CPU profiles under
 * production load showed the OpenSearch read round-trip — request-body
 * `JSON.stringify`, the `fetch` syscalls, and response `res.json()` parsing —
 * consuming ~20% of main-thread CPU. That is the budget that tips the loop
 * into metastable congestion collapse at peak. This pool moves that work onto
 * otherwise-idle cores.
 *
 * It implements {@link SearchClient} so {@link OpenSearchRelay} can use it as a
 * drop-in read client. Only the read surface (`search`, `msearch`, `count`) is
 * offloaded; writes/bulk stay on the in-process client.
 *
 * Dispatch, batching, backpressure, and disposal mirror {@link AnalyzePool}.
 */
export class SearchPool implements SearchClient {
  private workers: Worker[];
  private workerReady: Promise<void>[];
  private pending: Map<number, PendingRequest> = new Map();
  private nextReqId = 0;
  private queues: SearchWorkerRequest[][];
  private inflight: number[];
  private flushScheduled = false;
  private readonly maxPending: number;
  private readonly log: Logger;

  /**
   * @param config OpenSearch node URL + optional auth, forwarded to workers.
   * @param size Desired worker count. `0`/unset means "auto":
   *             `max(1, hardwareConcurrency - 1)`. Hard-capped at
   *             `hardwareConcurrency`.
   * @param opts.maxPending Pending request cap before `search`/`msearch`/
   *             `count` reject (default 20_000).
   * @param opts.logger Structured logger (default: fresh `info`-level Logger).
   */
  constructor(
    config: SearchWorkerConfig,
    size?: number,
    opts?: { maxPending?: number; logger?: Logger },
  ) {
    const cores = navigator.hardwareConcurrency;
    const auto = Math.max(1, cores - 1);
    const requested = !size || size <= 0 ? auto : size;
    const poolSize = Math.max(1, Math.min(requested, cores));

    this.maxPending = opts?.maxPending ?? 20_000;
    this.log = opts?.logger ?? new Logger();

    const workerUrl = new URL("search-worker.ts", import.meta.url).href;

    this.workerReady = [];
    this.workers = Array.from({ length: poolSize }, (_, workerIndex) => {
      const worker = new Worker(workerUrl, { smol: true });
      let markReady = () => {};
      this.workerReady.push(
        new Promise<void>((resolve) => {
          markReady = resolve;
        }),
      );
      worker.onmessage = (
        event: MessageEvent<"ready" | SearchWorkerResult[]>,
      ) => {
        if (event.data === "ready") {
          markReady();
          return;
        }
        for (const result of event.data) {
          const request = this.pending.get(result.reqId);
          if (!request) continue;
          this.pending.delete(result.reqId);
          this.inflight[request.workerIndex]--;
          request.endTimer();
          if (result.err !== undefined) {
            request.reject(new Error(result.err));
          } else {
            request.resolve(result.body);
          }
        }
        searchPoolPendingGauge.set(this.pending.size);
      };
      worker.onerror = (error) => {
        this.log.error("search_worker_error", {
          worker: workerIndex,
          ...errFields(error),
        });
        markReady();
      };
      // Configure the worker with connection details. It replies "ready".
      worker.postMessage(config);
      return worker;
    });

    this.queues = Array.from({ length: poolSize }, () => []);
    this.inflight = new Array(poolSize).fill(0);

    this.log.info("search_pool_started", {
      workers: poolSize,
      max_pending: this.maxPending,
    });
  }

  private pickWorker(): number {
    let best = 0;
    let bestLoad = this.inflight[0] + this.queues[0].length;
    for (let i = 1; i < this.workers.length; i++) {
      const load = this.inflight[i] + this.queues[i].length;
      if (load < bestLoad) {
        best = i;
        bestLoad = load;
      }
    }
    return best;
  }

  /**
   * Enqueue an operation (minus its reqId) and return a Promise for the parsed
   * response body. Applies the same pending-cap backpressure as AnalyzePool.
   */
  private dispatch<T>(op: DispatchOp): Promise<T> {
    if (this.pending.size >= this.maxPending) {
      return Promise.reject(
        new Error(
          `search pool overloaded (${this.pending.size} >= ${this.maxPending})`,
        ),
      );
    }
    const workerIndex = this.pickWorker();
    const reqId = this.nextReqId;
    this.nextReqId =
      this.nextReqId >= Number.MAX_SAFE_INTEGER ? 0 : this.nextReqId + 1;

    const request = { reqId, ...op } as SearchWorkerRequest;
    const endTimer = opensearchSearchDurationHistogram.startTimer();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        workerIndex,
        endTimer,
      });
      this.queues[workerIndex].push(request);
      this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    for (let i = 0; i < this.workers.length; i++) {
      const queue = this.queues[i];
      if (queue.length > 0) {
        this.workers[i].postMessage(queue);
        this.inflight[i] += queue.length;
        this.queues[i] = [];
      }
    }
    searchPoolPendingGauge.set(this.pending.size);
  }

  async search<TSource = unknown>(params: {
    index: string;
    body: unknown;
  }): Promise<ApiResponse<SearchResponseBody<TSource>>> {
    const body = await this.dispatch<SearchResponseBody<TSource>>({
      op: "search",
      index: params.index,
      body: params.body,
    });
    return { body };
  }

  async msearch<TSource = unknown>(
    searches: Array<{ index: string; body: unknown }>,
  ): Promise<ApiResponse<{ responses: Array<MsearchResponseItem<TSource>> }>> {
    const body = await this.dispatch<{
      responses: Array<MsearchResponseItem<TSource>>;
    }>({
      op: "msearch",
      searches,
    });
    return { body };
  }

  async count(params: {
    index: string;
    body: unknown;
  }): Promise<ApiResponse<{ count: number }>> {
    const body = await this.dispatch<{ count: number }>({
      op: "count",
      index: params.index,
      body: params.body,
    });
    return { body };
  }

  /** Terminate all workers and reject any pending requests. */
  async close(): Promise<void> {
    const workers = this.workers;
    const workerReady = this.workerReady;
    this.workers = [];
    this.workerReady = [];
    for (const [, request] of this.pending) {
      request.reject(new Error("Search pool disposed"));
    }
    this.pending.clear();
    searchPoolPendingGauge.set(0);
    await Promise.all(workerReady);
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}
