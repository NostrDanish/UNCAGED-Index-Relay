/**
 * ProtocolPool — main-thread bridge to the protocol workers.
 *
 * The pool owns N protocol workers (protocol-worker.ts). Each worker runs a
 * full Relay instance and owns every bit of per-connection protocol state
 * for the connections assigned to it. Connections are sticky: a connection
 * is assigned to the least-loaded worker at open time and never moves, which
 * preserves per-connection message ordering (worker channels are FIFO).
 *
 * The main thread's job is deliberately dumb: forward raw inbound message
 * strings to the owning worker, and deliver finished NIP-01 frame strings
 * coming back to the right socket. Strings cross the thread boundary as
 * flat copies — no object graphs, no parsing, no serialization on main.
 *
 * Inbound messages are batched per worker per event-loop tick (the same
 * setImmediate pattern as AnalyzePool) so a busy tick costs one postMessage
 * per worker instead of one per message.
 *
 * Broadcast fan-out: when a worker accepts an EVENT it posts the event to
 * main, and main forwards it to every *other* worker so their connections'
 * subscriptions get matched too. Events injected from outside the pool
 * (e.g. the background stats worker's trend events) go to *all* workers via
 * {@link broadcastExternal}.
 */

import type { NostrRelayInfo } from "@nostrify/nostrify";
import type { NostrEvent } from "nostr-tools";

import { errFields, Logger } from "./log.ts";

/** Messages sent from the main thread to a protocol worker. */
export type ToProtocolWorker =
  | { t: "open"; id: number; ip?: string; ua?: string }
  | { t: "msgs"; msgs: Array<[id: number, data: string]> }
  | { t: "close"; id: number }
  | { t: "bcast"; events: NostrEvent[] }
  | { t: "metrics"; reqId: number };

/** Messages sent from a protocol worker to the main thread. */
export type FromProtocolWorker =
  | { t: "ready"; relayInfo: NostrRelayInfo }
  | { t: "frames"; frames: Array<[id: number, frame: string]> }
  | { t: "accepted"; events: NostrEvent[] }
  | {
      t: "dirty";
      ids: string[];
      pubkeys: string[];
      addrs: string[];
      identifiers: string[];
    }
  | { t: "metrics"; reqId: number; text: string };

/** Dirty-reference batch drained from a worker's storage layer. */
export interface DirtyBatch {
  ids: string[];
  pubkeys: string[];
  addrs: string[];
  identifiers: string[];
}

/** Resolve the worker count: explicit N, or auto from core count. */
export function resolveProtocolWorkers(configured: number | undefined): number {
  if (configured !== undefined) return configured;
  const cores = navigator.hardwareConcurrency;
  return Math.max(1, Math.min(16, Math.floor(cores / 4)));
}

export class ProtocolPool {
  private workers: Worker[];
  /** Resolves with the worker's relayInfo once it posts "ready". */
  private workerReady: Promise<NostrRelayInfo>[];
  /** connId → index of the owning worker. */
  private connWorker = new Map<number, number>();
  /** Open-connection count per worker, for least-loaded assignment. */
  private connCounts: number[];
  /** Per-worker inbound message batches awaiting flush. */
  private queues: Array<Array<[id: number, data: string]>>;
  private flushScheduled = false;

  /** Pending /metrics round trips, keyed by request id. */
  private metricsPending = new Map<
    number,
    { resolve: (text: string) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private nextMetricsReq = 0;

  private readonly log: Logger;
  private readonly sendFrame: (connId: number, frame: string) => void;
  private readonly onDirty?: (dirty: DirtyBatch) => void;

  constructor(
    size: number,
    opts: {
      /** Deliver one finished frame to a socket. Unknown ids must be ignored. */
      sendFrame: (connId: number, frame: string) => void;
      /** Receives dirty-reference batches for the background stats worker. */
      onDirty?: (dirty: DirtyBatch) => void;
      logger?: Logger;
      /**
       * Environment for the worker threads (tests use this to point workers
       * at a mock OpenSearch). Bun workers snapshot the process environment
       * at process start, so runtime `process.env` mutations are NOT visible
       * to workers — production simply omits this and workers see the same
       * env (including `.env` auto-loading) as the main thread.
       */
      workerEnv?: Record<string, string>;
    },
  ) {
    this.log = opts.logger ?? new Logger();
    this.sendFrame = opts.sendFrame;
    this.onDirty = opts.onDirty;

    const workerUrl = new URL("protocol-worker.ts", import.meta.url).href;

    this.workerReady = [];
    this.workers = Array.from({ length: size }, (_, workerIndex) => {
      // No `smol: true` here — unlike analyze workers, protocol workers do
      // the relay's real work and deserve a full-size heap.
      const worker = new Worker(
        workerUrl,
        opts.workerEnv ? { env: opts.workerEnv } : undefined,
      );
      let markReady: (info: NostrRelayInfo) => void = () => {};
      let markFailed: (err: Error) => void = () => {};
      this.workerReady.push(
        new Promise<NostrRelayInfo>((resolve, reject) => {
          markReady = resolve;
          markFailed = reject;
        }),
      );
      worker.onmessage = (event: MessageEvent<FromProtocolWorker>) => {
        const msg = event.data;
        switch (msg.t) {
          case "ready":
            markReady(msg.relayInfo);
            break;
          case "frames":
            for (const [connId, frame] of msg.frames) {
              this.sendFrame(connId, frame);
            }
            break;
          case "accepted":
            // Fan accepted events out to every *other* worker for broadcast
            // matching against their connections' subscriptions.
            for (let i = 0; i < this.workers.length; i++) {
              if (i === workerIndex) continue;
              this.workers[i].postMessage({
                t: "bcast",
                events: msg.events,
              } satisfies ToProtocolWorker);
            }
            break;
          case "dirty":
            this.onDirty?.(msg);
            break;
          case "metrics": {
            const pending = this.metricsPending.get(msg.reqId);
            if (pending) {
              this.metricsPending.delete(msg.reqId);
              clearTimeout(pending.timer);
              pending.resolve(msg.text);
            }
            break;
          }
        }
      };
      worker.onerror = (error) => {
        this.log.error("protocol_worker_error", {
          worker: workerIndex,
          err_msg: error.message,
        });
        // If the worker dies during startup, fail start() instead of
        // hanging it. No-op once the ready promise has settled.
        markFailed(new Error(`protocol worker ${workerIndex} failed to start`));
      };
      return worker;
    });

    this.connCounts = new Array(size).fill(0);
    this.queues = Array.from({ length: size }, () => []);
  }

  /** Number of workers in the pool. */
  get size(): number {
    return this.workers.length;
  }

  /**
   * Wait for every worker to finish initializing. Returns the relay info
   * document (identical across workers — same config) for NIP-11 serving.
   */
  async start(): Promise<NostrRelayInfo> {
    const infos = await Promise.all(this.workerReady);
    return infos[0];
  }

  /** Assign a new connection to the least-loaded worker. */
  open(connId: number, ip?: string, userAgent?: string): void {
    let best = 0;
    for (let i = 1; i < this.connCounts.length; i++) {
      if (this.connCounts[i] < this.connCounts[best]) best = i;
    }
    this.connWorker.set(connId, best);
    this.connCounts[best]++;
    this.workers[best].postMessage({
      t: "open",
      id: connId,
      ip,
      ua: userAgent,
    } satisfies ToProtocolWorker);
  }

  /** Forward one raw inbound message to the connection's owning worker. */
  message(connId: number, data: string): void {
    const workerIndex = this.connWorker.get(connId);
    if (workerIndex === undefined) return;
    this.queues[workerIndex].push([connId, data]);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => this.flush());
    }
  }

  /** Notify the owning worker that a connection closed. */
  close(connId: number): void {
    const workerIndex = this.connWorker.get(connId);
    if (workerIndex === undefined) return;
    this.connWorker.delete(connId);
    this.connCounts[workerIndex]--;
    // Flush queued messages first so the close doesn't overtake them on the
    // worker's FIFO channel and orphan still-queued messages for this conn.
    this.flush();
    this.workers[workerIndex].postMessage({
      t: "close",
      id: connId,
    } satisfies ToProtocolWorker);
  }

  /** Inject events from outside the pool (bg stats worker) into every worker. */
  broadcastExternal(events: NostrEvent[]): void {
    for (const worker of this.workers) {
      worker.postMessage({ t: "bcast", events } satisfies ToProtocolWorker);
    }
  }

  /** Post all queued inbound message batches to their workers. */
  private flush(): void {
    this.flushScheduled = false;
    for (let i = 0; i < this.queues.length; i++) {
      const queue = this.queues[i];
      if (queue.length > 0) {
        this.workers[i].postMessage({
          t: "msgs",
          msgs: queue,
        } satisfies ToProtocolWorker);
        this.queues[i] = [];
      }
    }
  }

  /**
   * Collect each worker's Prometheus exposition text. Workers that don't
   * answer within `timeoutMs` are skipped (a wedged worker must not be able
   * to hang the /metrics endpoint).
   */
  metrics(timeoutMs = 2_000): Promise<Array<{ label: string; text: string }>> {
    const collected = this.workers.map((worker, i) => {
      const reqId = this.nextMetricsReq++;
      return new Promise<{ label: string; text: string } | null>((resolve) => {
        const timer = setTimeout(() => {
          this.metricsPending.delete(reqId);
          this.log.warn("protocol_worker_metrics_timeout", { worker: i });
          resolve(null);
        }, timeoutMs);
        timer.unref?.();
        this.metricsPending.set(reqId, {
          resolve: (text) => resolve({ label: String(i), text }),
          timer,
        });
        worker.postMessage({ t: "metrics", reqId } satisfies ToProtocolWorker);
      });
    });
    return Promise.all(collected).then((results) =>
      results.filter((r): r is { label: string; text: string } => r !== null),
    );
  }

  /**
   * Terminate all workers. Waits for initialization to complete first —
   * terminating a worker mid-module-evaluation can segfault Bun.
   */
  async dispose(): Promise<void> {
    const workers = this.workers;
    const ready = this.workerReady;
    this.workers = [];
    this.workerReady = [];
    for (const pending of this.metricsPending.values()) {
      clearTimeout(pending.timer);
      pending.resolve("");
    }
    this.metricsPending.clear();
    try {
      await Promise.all(ready);
    } catch (err) {
      this.log.warn("protocol_pool_ready_failed", errFields(err));
    }
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}
