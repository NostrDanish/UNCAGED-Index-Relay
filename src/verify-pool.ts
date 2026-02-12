import type { NostrEvent } from "nostr-tools";

interface PendingRequest {
  resolve: (valid: boolean) => void;
  reject: (error: Error) => void;
}

/**
 * Pool of Web Workers for parallel Nostr event signature verification.
 * Distributes verification work across threads via round-robin.
 */
export class VerifyPool {
  private workers: Worker[];
  private pending: Map<string, PendingRequest> = new Map();
  private nextWorker = 0;

  constructor(size: number = navigator.hardwareConcurrency) {
    // Use at least 1 worker, cap at available cores
    const poolSize = Math.max(1, Math.min(size, navigator.hardwareConcurrency));
    const workerUrl = new URL("verify-worker.ts", import.meta.url).href;

    this.workers = Array.from({ length: poolSize }, () => {
      const worker = new Worker(workerUrl, { smol: true });
      worker.onmessage = (
        event: MessageEvent<{ id: string; valid: boolean }>,
      ) => {
        const { id, valid } = event.data;
        const request = this.pending.get(id);
        if (request) {
          this.pending.delete(id);
          request.resolve(valid);
        }
      };
      worker.onerror = (error) => {
        console.error("Verify worker error:", error);
      };
      return worker;
    });

    console.log(`Verify pool started with ${poolSize} workers`);
  }

  /** Verify a Nostr event signature off the main thread. */
  verify(event: NostrEvent): Promise<boolean> {
    const worker = this.workers[this.nextWorker];
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;

    return new Promise<boolean>((resolve, reject) => {
      this.pending.set(`${event.id}:${event.sig}`, { resolve, reject });
      worker.postMessage(event);
    });
  }

  /** Terminate all workers. */
  dispose(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    // Reject any pending requests
    for (const [, request] of this.pending) {
      request.reject(new Error("Verify pool disposed"));
    }
    this.pending.clear();
  }
}
