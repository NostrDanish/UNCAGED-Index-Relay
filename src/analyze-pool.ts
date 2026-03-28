import type { NostrEvent } from "nostr-tools";
import { analyzePendingGauge } from "./metrics.ts";

/** Result of analyzing a Nostr event off the main thread. */
export interface AnalyzeResult {
  verified: boolean;
  search_text?: string;
  language?: string;
  sentiment?: string;
  media?: boolean;
  video?: boolean;
}

interface PendingRequest {
  resolve: (result: AnalyzeResult) => void;
  reject: (error: Error) => void;
}

/**
 * Pool of Web Workers for off-thread Nostr event analysis.
 * Each worker verifies the event signature and, when valid,
 * detects the language and sentiment of the content.
 *
 * Events are batched per microtask and dispatched to workers in
 * arrays to amortize the structured-clone cost of postMessage.
 */
export class AnalyzePool {
  private workers: Worker[];
  private pending: Map<string, PendingRequest> = new Map();
  private nextWorker = 0;

  /** Per-worker queues of events awaiting dispatch. */
  private queues: NostrEvent[][];
  /** Whether a microtask flush is already scheduled. */
  private flushScheduled = false;

  constructor(size: number = navigator.hardwareConcurrency) {
    // Use at least 1 worker, cap at available cores
    const poolSize = Math.max(1, Math.min(size, navigator.hardwareConcurrency));
    const workerUrl = new URL("analyze-worker.ts", import.meta.url).href;

    this.workers = Array.from({ length: poolSize }, () => {
      const worker = new Worker(workerUrl, { smol: true });
      worker.onmessage = (
        event: MessageEvent<({ id: string } & AnalyzeResult)[]>,
      ) => {
        const results = event.data;
        for (const result of results) {
          const {
            id,
            verified,
            search_text,
            language,
            sentiment,
            media,
            video,
          } = result;
          const request = this.pending.get(id);
          if (request) {
            this.pending.delete(id);
            request.resolve({
              verified,
              ...(search_text && { search_text }),
              ...(language && { language }),
              ...(sentiment && { sentiment }),
              ...(media !== undefined && { media }),
              ...(video !== undefined && { video }),
            });
          }
        }
        analyzePendingGauge.set(this.pending.size);
      };
      worker.onerror = (error) => {
        console.error("Analyze worker error:", error);
      };
      return worker;
    });

    this.queues = Array.from({ length: poolSize }, () => []);

    console.log(`Analyze pool started with ${poolSize} workers`);
  }

  /** Analyze a Nostr event off the main thread: verify, detect language, detect sentiment. */
  analyze(event: NostrEvent): Promise<AnalyzeResult> {
    const workerIndex = this.nextWorker;
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;

    return new Promise<AnalyzeResult>((resolve, reject) => {
      this.pending.set(`${event.id}:${event.sig}`, { resolve, reject });
      analyzePendingGauge.set(this.pending.size);
      this.queues[workerIndex].push(event);
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => this.flush());
      }
    });
  }

  /** Send all queued events to their respective workers. */
  private flush(): void {
    this.flushScheduled = false;
    for (let i = 0; i < this.workers.length; i++) {
      const queue = this.queues[i];
      if (queue.length > 0) {
        this.workers[i].postMessage(queue);
        this.queues[i] = [];
      }
    }
  }

  /** Terminate all workers. */
  dispose(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    // Reject any pending requests
    for (const [, request] of this.pending) {
      request.reject(new Error("Analyze pool disposed"));
    }
    this.pending.clear();
  }
}
