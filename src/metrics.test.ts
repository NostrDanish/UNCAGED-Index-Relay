import assert from "node:assert/strict";
import { test } from "node:test";
import { register, startRuntimeMetrics } from "./metrics.ts";

test("startRuntimeMetrics samples lag and memory gauges", async () => {
  const stop = startRuntimeMetrics(10);
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    stop();
  }

  const output = await register.metrics();

  const rss = output.match(/^ditto_process_rss_bytes (\S+)$/m);
  assert.ok(rss, "rss gauge is exposed");
  assert.ok(Number(rss[1]) > 0, "rss is positive");

  const heap = output.match(/^ditto_js_heap_used_bytes (\S+)$/m);
  assert.ok(heap, "heap gauge is exposed");
  assert.ok(Number(heap[1]) > 0, "heap is positive");

  const lag = output.match(/^ditto_event_loop_lag_seconds (\S+)$/m);
  assert.ok(lag, "lag gauge is exposed");
  assert.ok(Number(lag[1]) >= 0, "lag is non-negative");
});
