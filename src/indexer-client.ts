/**
 * IndexerClient — the write half of storage, as seen from a protocol worker.
 *
 * All OpenSearch writes (event indexing, deletions) are owned by the single
 * indexer worker (indexer-worker.ts) so that bulk batches stay coalesced and
 * replaceable-slot resolution has one writer instead of racing across N
 * protocol workers. Each protocol worker talks to the indexer over a
 * dedicated MessageChannel port (transferred by the pool at spawn), so
 * indexing traffic never touches the main thread.
 *
 * Requests are batched per event-loop tick (same setImmediate pattern as
 * the other pools) and correlated by reqId. `event()` resolves when the
 * indexer's bulk flush confirms the write — the same semantics the Relay
 * had when it called OpenSearchRelay.event() directly — so OK responses
 * still reflect durability.
 *
 * Backpressure: when the number of in-flight requests reaches `maxPending`
 * (wire it to the indexer's bulk queue cap), `event()`/`remove()` throw
 * StorageOverloaded, which the Relay already translates into
 * `OK false "error: relay overloaded, try again"`.
 */

import type { Filter, NostrEvent } from "nostr-tools";

import { StorageOverloaded } from "./errors.ts";
import type { EventAnalysis } from "./relay.ts";

/** One write request, sent over the port inside a batch. */
export type IndexerRequest =
  | { t: "index"; reqId: number; event: NostrEvent; analysis?: EventAnalysis }
  | { t: "remove"; reqId: number; filters: Filter[]; excludeKinds?: number[] };

/** Batch envelope: protocol worker → indexer worker (over the port). */
export interface IndexerBatch {
  t: "batch";
  items: IndexerRequest[];
}

/** Per-request outcome: indexer worker → protocol worker (over the port). */
export interface IndexerReply {
  reqId: number;
  /** Absent on success. */
  err?: { code: "overloaded" | "error"; message: string };
}

/** Batch envelope for replies. */
export interface IndexerReplyBatch {
  t: "replies";
  items: IndexerReply[];
}

/** Messages sent from the main thread to the indexer worker. */
export type ToIndexerWorker =
  | { t: "port"; port: MessagePort }
  | { t: "metrics"; reqId: number };

/** Messages sent from the indexer worker to the main thread. */
export type FromIndexerWorker =
  | { t: "ready" }
  | { t: "metrics"; reqId: number; text: string }
  | {
      t: "dirty";
      ids: string[];
      pubkeys: string[];
      addrs: string[];
      identifiers: string[];
    };

interface PendingWrite {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class IndexerClient {
  private port: MessagePort | null = null;
  private pending = new Map<number, PendingWrite>();
  private nextReqId = 0;
  private queue: IndexerRequest[] = [];
  private flushScheduled = false;
  private readonly maxPending: number;

  /**
   * @param opts.maxPending In-flight + queued write cap before
   *   StorageOverloaded is thrown. Should match the indexer's bulk queue
   *   cap so backpressure semantics are unchanged. Default: 5000.
   */
  constructor(opts?: { maxPending?: number }) {
    this.maxPending = opts?.maxPending ?? 5_000;
  }

  /**
   * Attach the MessageChannel port to the indexer. Requests enqueued before
   * the port arrives (possible in the first ticks after worker spawn) are
   * flushed immediately on bind.
   */
  bind(port: MessagePort): void {
    if (this.port) {
      // Rebind after an indexer restart: outstanding writes died with the
      // old indexer. Reject them (surfaces as OK false to those clients)
      // rather than leaving handleEvent continuations hanging forever.
      for (const pending of this.pending.values()) {
        pending.reject(new Error("indexer restarted, write lost"));
      }
      this.pending.clear();
      this.port.close();
    }
    this.port = port;
    // Note: untyped param — Bun and undici both declare a global
    // MessageEvent and they disagree; let TS infer from the setter.
    port.onmessage = (event) => {
      const batch = event.data as IndexerReplyBatch;
      for (const item of batch.items) {
        const pending = this.pending.get(item.reqId);
        if (!pending) continue;
        this.pending.delete(item.reqId);
        if (!item.err) {
          pending.resolve();
        } else if (item.err.code === "overloaded") {
          // Reconstruct the typed error so the Relay's
          // `instanceof StorageOverloaded` branch still works across the
          // thread boundary; preserve the indexer's message.
          const err = new StorageOverloaded(0, 0);
          err.message = item.err.message;
          pending.reject(err);
        } else {
          pending.reject(new Error(item.err.message));
        }
      }
    };
    this.flush();
  }

  /** Index an event (resolves once the indexer's bulk flush confirms it). */
  event(event: NostrEvent, analysis?: EventAnalysis): Promise<void> {
    const req: IndexerRequest = {
      t: "index",
      reqId: 0, // assigned in enqueue
      event,
    };
    if (analysis) req.analysis = analysis;
    return this.enqueue(req);
  }

  /**
   * Delete events matching the filters (NIP-09 / NIP-62). Kinds listed in
   * `excludeKinds` are spared even when they match a filter.
   */
  remove(filters: Filter[], opts?: { excludeKinds?: number[] }): Promise<void> {
    const req: IndexerRequest = { t: "remove", reqId: 0, filters };
    if (opts?.excludeKinds) req.excludeKinds = opts.excludeKinds;
    return this.enqueue(req);
  }

  private enqueue(req: IndexerRequest): Promise<void> {
    if (this.pending.size >= this.maxPending) {
      throw new StorageOverloaded(this.pending.size, this.maxPending);
    }
    const reqId = this.nextReqId;
    this.nextReqId =
      this.nextReqId >= Number.MAX_SAFE_INTEGER ? 0 : this.nextReqId + 1;
    req.reqId = reqId;

    return new Promise<void>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.queue.push(req);
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        setImmediate(() => this.flush());
      }
    });
  }

  private flush(): void {
    this.flushScheduled = false;
    if (!this.port || this.queue.length === 0) return;
    this.port.postMessage({
      t: "batch",
      items: this.queue,
    } satisfies IndexerBatch);
    this.queue = [];
  }
}
