import type { NostrEvent } from "nostr-tools";

import { AnalyzePoolOverloaded } from "./errors.ts";
import { analyzePendingGauge, analyzeWorkerInflightGauge } from "./metrics.ts";

/** Result of analyzing a Nostr event off the main thread. */
export interface AnalyzeResult {
  verified: boolean;
  search_text?: string;
  autocomplete_text?: string;
  language?: string;
  sentiment?: string;
  media?: boolean;
  video?: boolean;
}

interface PendingRequest {
  resolve: (result: AnalyzeResult) => void;
  reject: (error: Error) => void;
  /** Index of the worker the request was dispatched to. */
  workerIndex: number;
}

/** Request sent to a worker: an event tagged with an opaque correlation id. */
export interface AnalyzeRequest {
  reqId: number;
  event: NostrEvent;
  /**
   * When `true`, the worker only performs signature verification and skips
   * search_text / language / sentiment / media derivation. Used by callers
   * that only need `verified` (e.g. NIP-42 AUTH handling).
   */
  verifyOnly?: boolean;
}

/**
 * Pool of Web Workers for off-thread Nostr event analysis.
 *
 * Each worker verifies the event signature and, for valid events, derives
 * search text, language, sentiment, and media metadata. Verification is the
 * dominant CPU cost; the rest is amortized into the same worker hop.
 *
 * Dispatch strategy: least-loaded. Each `analyze()` call picks the worker
 * with the smallest pending load (`inflight + queued`). This prevents head-
 * of-line blocking when one worker stalls on a slow batch — a problem that
 * round-robin dispatch creates under bursty firehose ingest (e.g. a Bluesky
 * bridge dumping thousands of events through a single connection).
 *
 * Batching: events enqueued in the same event-loop tick are coalesced into
 * a single `postMessage` per worker. The flush is scheduled via
 * `setImmediate` (rather than `queueMicrotask`) so that multiple incoming
 * WebSocket messages can land in the queue before the flush fires.
 * `queueMicrotask` would fire between `await` points and effectively flush
 * one event at a time, defeating batch amortization of the structured-clone
 * cost.
 *
 * Backpressure: when `pending.size` exceeds `maxPending`, new `analyze()`
 * calls throw `AnalyzePoolOverloaded` synchronously. The relay catches this
 * and replies with `OK false "error: relay overloaded"` so upstream clients
 * back off naturally instead of holding connections while we OOM.
 */
export class AnalyzePool {
  private workers: Worker[];
  /**
   * Per-worker promise that resolves once the worker has finished module
   * evaluation (posts "ready") or failed to start. Terminating a worker
   * mid-initialization can segfault Bun, so dispose() waits on these.
   */
  private workerReady: Promise<void>[];
  private pending: Map<number, PendingRequest> = new Map();

  /**
   * Monotonic correlation counter. Wraps at Number.MAX_SAFE_INTEGER as a
   * cheap belt-and-suspenders — in practice it will never overflow, but
   * wrapping keeps the counter from silently producing non-integer ids
   * if the relay runs long enough to hit 2^53.
   */
  private nextReqId = 0;

  /** Per-worker queues of requests awaiting dispatch. */
  private queues: AnalyzeRequest[][];
  /** Per-worker count of requests posted but not yet returned. */
  private inflight: number[];
  /** Whether a flush is already scheduled. */
  private flushScheduled = false;

  /** Maximum pending requests before `analyze()` throws AnalyzePoolOverloaded. */
  private readonly maxPending: number;

  /**
   * @param size Desired worker count. `0` or unset means "auto":
   *             `max(1, hardwareConcurrency - 1)`. Always hard-capped at
   *             `hardwareConcurrency`.
   * @param opts.maxPending Pending request cap (default 20_000).
   */
  constructor(size?: number, opts?: { maxPending?: number }) {
    const cores = navigator.hardwareConcurrency;
    // Auto-size: leave one core for the main WS event loop + OpenSearch I/O.
    const auto = Math.max(1, cores - 1);
    const requested = !size || size <= 0 ? auto : size;
    const poolSize = Math.max(1, Math.min(requested, cores));

    this.maxPending = opts?.maxPending ?? 20_000;

    const workerUrl = new URL("analyze-worker.ts", import.meta.url).href;

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
        event: MessageEvent<"ready" | ({ reqId: number } & AnalyzeResult)[]>,
      ) => {
        if (event.data === "ready") {
          markReady();
          return;
        }
        const results = event.data;
        for (const result of results) {
          // Destructure reqId off and resolve with the rest — the worker
          // already emits the canonical AnalyzeResult shape, so avoid the
          // redundant conditional-spread rebuild we used to do here.
          const { reqId, ...payload } = result;
          const request = this.pending.get(reqId);
          if (request) {
            this.pending.delete(reqId);
            this.inflight[request.workerIndex]--;
            request.resolve(payload);
          }
        }
        analyzePendingGauge.set(this.pending.size);
        analyzeWorkerInflightGauge.set(
          { worker: String(workerIndex) },
          this.inflight[workerIndex],
        );
      };
      worker.onerror = (error) => {
        console.error("Analyze worker error:", error);
        // Never leave dispose() waiting on a worker that failed to start.
        markReady();
      };
      return worker;
    });

    this.queues = Array.from({ length: poolSize }, () => []);
    this.inflight = new Array(poolSize).fill(0);

    console.log(
      `Analyze pool started with ${poolSize} workers (maxPending=${this.maxPending})`,
    );
  }

  /** Current number of in-flight + queued analyze requests. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Pick the worker with the smallest combined load (inflight + queued).
   * Linear scan; pool sizes are small (≤ #cores).
   */
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
   * Analyze a Nostr event off the main thread.
   *
   * @param event The event to analyze.
   * @param opts.verifyOnly When `true`, skip search_text / language /
   *   sentiment / media derivation and only return `verified`. Useful for
   *   NIP-42 AUTH where the rest of the analysis is discarded.
   * @throws {AnalyzePoolOverloaded} when `pendingCount >= maxPending`. The
   *   relay translates this into an `OK false "error: relay overloaded"`
   *   response so the client can back off.
   */
  analyze(
    event: NostrEvent,
    opts?: { verifyOnly?: boolean },
  ): Promise<AnalyzeResult> {
    if (this.pending.size >= this.maxPending) {
      throw new AnalyzePoolOverloaded(this.pending.size, this.maxPending);
    }

    const workerIndex = this.pickWorker();

    const reqId = this.nextReqId;
    this.nextReqId =
      this.nextReqId >= Number.MAX_SAFE_INTEGER ? 0 : this.nextReqId + 1;

    const request: AnalyzeRequest = { reqId, event };
    if (opts?.verifyOnly) request.verifyOnly = true;

    return new Promise<AnalyzeResult>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject, workerIndex });
      this.queues[workerIndex].push(request);
      this.scheduleFlush();
    });
  }

  /**
   * Schedule a flush of all per-worker queues. Uses `setImmediate` so that
   * multiple `analyze()` calls during the same tick (across await points
   * elsewhere in the event loop) accumulate into a single batched
   * postMessage per worker.
   */
  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => this.flush());
  }

  /**
   * Send all queued events to their respective workers.
   *
   * Gauge updates happen here once per flush tick (rather than per
   * `analyze()` call) so that under firehose load — where thousands of
   * events can be enqueued in a single tick — we pay the prom-client
   * gauge write cost O(workers) per tick instead of O(events).
   */
  private flush(): void {
    this.flushScheduled = false;
    for (let i = 0; i < this.workers.length; i++) {
      const queue = this.queues[i];
      if (queue.length > 0) {
        this.workers[i].postMessage(queue);
        this.inflight[i] += queue.length;
        analyzeWorkerInflightGauge.set({ worker: String(i) }, this.inflight[i]);
        this.queues[i] = [];
      }
    }
    analyzePendingGauge.set(this.pending.size);
  }

  /**
   * Terminate all workers and reject any pending requests.
   *
   * Waits for each worker to finish initializing before terminating it, and
   * awaits the terminations: tearing down a worker mid-module-evaluation (or
   * exiting the process mid-teardown) can segfault Bun, which manifested as
   * flaky `bun test` crashes in CI.
   */
  async dispose(): Promise<void> {
    const workers = this.workers;
    const workerReady = this.workerReady;
    this.workers = [];
    this.workerReady = [];
    // Reject any pending requests
    for (const [, request] of this.pending) {
      request.reject(new Error("Analyze pool disposed"));
    }
    this.pending.clear();
    analyzePendingGauge.set(0);
    await Promise.all(workerReady);
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}
