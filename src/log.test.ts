import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  errFields,
  getLogLevel,
  levelEnabled,
  log,
  setLogLevel,
} from "./log.ts";

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

afterEach(() => {
  setLogLevel("info");
});

test("emits single-line JSON with level, time, msg, and fields", () => {
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
  assert.ok(!Number.isNaN(Date.parse(entry.time)));
});

test("drops undefined fields", () => {
  const { out } = capture(() => {
    log.info("req", { ip: undefined, returned: 5 });
  });
  const entry = JSON.parse(out[0]);
  assert.ok(!("ip" in entry));
  assert.equal(entry.returned, 5);
});

test("suppresses entries below the active level", () => {
  assert.equal(getLogLevel(), "info");
  assert.equal(levelEnabled("debug"), false);
  const { out } = capture(() => {
    log.debug("req", { returned: 1 });
  });
  assert.equal(out.length, 0);

  setLogLevel("debug");
  assert.equal(levelEnabled("debug"), true);
  const captured = capture(() => {
    log.debug("req", { returned: 1 });
  });
  assert.equal(captured.out.length, 1);
});

test("warn and error go to stderr", () => {
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
  setLogLevel("error");
  const { err } = capture(() => {
    log.warn("phase2_failed");
    log.error("store_failed");
  });
  assert.equal(err.length, 1);
  assert.equal(JSON.parse(err[0]).msg, "store_failed");
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
