/// Worker thread that performs Nostr event analysis off the main thread.
/// Thin shell around the shared analyzer in `analyze.ts`.
///
/// Receives batches of events (AnalyzeRequest[]) and responds with batches of
/// results to amortize postMessage structured-clone overhead.

declare var self: Worker;

import { createAnalyzer } from "./analyze.ts";
import type { AnalyzeRequest, AnalyzeResult } from "./analyze-pool.ts";

const analyze = await createAnalyzer();

// Signal the pool that module evaluation is complete. Terminating a worker
// while it is still initializing (loading tinyld's n-gram tables, wasm, etc.)
// can segfault Bun, so the pool waits for this message before terminating.
self.postMessage("ready");

self.onmessage = (event: MessageEvent<AnalyzeRequest[]>) => {
  const batch = event.data;
  const results: Array<{ reqId: number } & AnalyzeResult> = new Array(
    batch.length,
  );
  for (let i = 0; i < batch.length; i++) {
    const { reqId, event: nostrEvent, verifyOnly } = batch[i];
    const out = analyze(nostrEvent, { verifyOnly }) as {
      reqId: number;
    } & AnalyzeResult;
    // Tag the correlation id onto the analyzer's result object directly —
    // it's freshly allocated per event, so mutating it is safe and avoids
    // a second per-event allocation.
    out.reqId = reqId;
    results[i] = out;
  }
  postMessage(results);
};
