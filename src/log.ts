/**
 * Structured JSON logging — one line per entry, queryable in Loki.
 *
 * Format (slog-style, flat snake_case keys):
 *
 *   {"level":"info","time":"2026-07-18T17:12:03.412Z","msg":"started","port":13131}
 *
 * - `level` is a string so Grafana's log panel auto-detects it for coloring.
 * - `msg` is a short stable event name (`req`, `ws_open`, ...) — put variable
 *   data in fields, never interpolated into `msg`, so LogQL can aggregate.
 * - Fields must be flat scalars. Serialize structured data (e.g. Nostr
 *   filters) to a compact JSON *string* field so `| json` output stays flat.
 *
 * Level semantics:
 * - `debug`: frequent traffic-driven entries (per-REQ, per-EVENT, per-connection).
 * - `info`:  infrequent lifecycle events (startup, migrations, background jobs).
 * - `warn`:  something unexpected but tolerated.
 * - `error`: something failed.
 *
 * The active level comes from the `LOG_LEVEL` env var (default `info`).
 * It is read at module load so worker threads and scripts inherit it.
 */

import process from "node:process";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function parseLevel(value: string | undefined): LogLevel {
  const lower = value?.toLowerCase();
  if (
    lower === "debug" ||
    lower === "info" ||
    lower === "warn" ||
    lower === "error"
  ) {
    return lower;
  }
  return "info";
}

let currentLevel: LogLevel = parseLevel(process.env.LOG_LEVEL);

/** Override the active log level (used by tests). */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/**
 * Whether entries at `level` are currently emitted. Hot paths can use this
 * to skip building fields entirely when the level is disabled.
 */
export function levelEnabled(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[currentLevel];
}

export type LogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

/**
 * Flatten an unknown thrown value into log fields. Keeps the stack to the
 * first frame so every entry stays on a single line.
 */
export function errFields(err: unknown): LogFields {
  if (err instanceof Error) {
    const frame = err.stack
      ?.split("\n")
      .find((line) => line.trimStart().startsWith("at "));
    return {
      err_name: err.name,
      err_msg: err.message,
      err_stack: frame?.trim(),
    };
  }
  return { err_msg: String(err) };
}

function write(level: LogLevel, msg: string, fields?: LogFields): void {
  if (!levelEnabled(level)) return;
  const entry: Record<string, unknown> = {
    level,
    time: new Date().toISOString(),
    msg,
  };
  if (fields) {
    for (const key in fields) {
      const value = fields[key];
      if (value !== undefined) entry[key] = value;
    }
  }
  const line = JSON.stringify(entry);
  // warn/error go to stderr so journald records them at a higher priority.
  if (LEVEL_RANK[level] >= LEVEL_RANK.warn) {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  debug(msg: string, fields?: LogFields): void {
    write("debug", msg, fields);
  },
  info(msg: string, fields?: LogFields): void {
    write("info", msg, fields);
  },
  warn(msg: string, fields?: LogFields): void {
    write("warn", msg, fields);
  },
  error(msg: string, fields?: LogFields): void {
    write("error", msg, fields);
  },
};
