import assert from "node:assert/strict";
import { test } from "node:test";
import { clip, errFields, Logger, parseLogLevel } from "./log.ts";

/** Capture console output emitted during `fn`. */
function capture(fn: () => void): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (line: string) => out.push(line);
  console.error = (line: string) => err.push(line);
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { out, err };
}

test("emits single-line JSON with level, msg, and fields", () => {
  const log = new Logger("info");
  const { out } = capture(() => {
    log.info("started", { port: 13131, ready: true });
  });
  assert.equal(out.length, 1);
  assert.ok(!out[0].includes("\n"));
  const entry = JSON.parse(out[0]);
  assert.equal(entry.level, "info");
  assert.equal(entry.msg, "started");
  assert.equal(entry.port, 13131);
  assert.equal(entry.ready, true);
  // No app-emitted `time` field — journald provides the timestamp.
  assert.ok(!("time" in entry));
});

test("drops undefined fields", () => {
  const log = new Logger("info");
  const { out } = capture(() => {
    log.info("req", { ip: undefined, returned: 5 });
  });
  const entry = JSON.parse(out[0]);
  assert.ok(!("ip" in entry));
  assert.equal(entry.returned, 5);
});

test("suppresses entries below the constructed level", () => {
  const info = new Logger("info");
  assert.equal(info.levelEnabled("debug"), false);
  const suppressed = capture(() => {
    info.debug("req", { returned: 1 });
  });
  assert.equal(suppressed.out.length, 0);

  const debug = new Logger("debug");
  assert.equal(debug.levelEnabled("debug"), true);
  const emitted = capture(() => {
    debug.debug("req", { returned: 1 });
  });
  assert.equal(emitted.out.length, 1);
});

test("defaults to info level", () => {
  const log = new Logger();
  assert.equal(log.level, "info");
  assert.equal(log.levelEnabled("debug"), false);
  assert.equal(log.levelEnabled("info"), true);
});

test("warn and error go to stderr", () => {
  const log = new Logger("info");
  const { out, err } = capture(() => {
    log.warn("phase2_failed");
    log.error("store_failed");
  });
  assert.equal(out.length, 0);
  assert.equal(err.length, 2);
  assert.equal(JSON.parse(err[0]).level, "warn");
  assert.equal(JSON.parse(err[1]).level, "error");
});

test("error level suppresses warn", () => {
  const log = new Logger("error");
  const { err } = capture(() => {
    log.warn("phase2_failed");
    log.error("store_failed");
  });
  assert.equal(err.length, 1);
  assert.equal(JSON.parse(err[0]).msg, "store_failed");
});

test("parseLogLevel normalizes and defaults to info", () => {
  assert.equal(parseLogLevel("debug"), "debug");
  assert.equal(parseLogLevel("WARN"), "warn");
  assert.equal(parseLogLevel("bogus"), "info");
  assert.equal(parseLogLevel(undefined), "info");
});

test("errFields flattens an Error to single-line fields", () => {
  const fields = errFields(new TypeError("bad thing"));
  assert.equal(fields.err_name, "TypeError");
  assert.equal(fields.err_msg, "bad thing");
  if (fields.err_stack !== undefined) {
    assert.ok(String(fields.err_stack).startsWith("at "));
    assert.ok(!String(fields.err_stack).includes("\n"));
  }
});

test("errFields handles non-Error values", () => {
  assert.deepEqual(errFields("oops"), { err_msg: "oops" });
});

test("clip bounds long values and passes short ones through", () => {
  assert.equal(clip("short"), "short");
  const long = "x".repeat(5000);
  const clipped = clip(long);
  assert.equal(clipped.length, 4001);
  assert.ok(clipped.endsWith("…"));
  assert.equal(clip(long, 10), `${"x".repeat(10)}…`);
});
