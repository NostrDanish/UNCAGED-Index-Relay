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
 * There is no global logger: entry points (`server.ts`, `background-worker.ts`)
 * construct a {@link Logger} from `Config.logLevel` and pass it down to the
 * objects that log.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Normalize a raw `LOG_LEVEL` value, defaulting to `info`. */
export function parseLogLevel(value: string | undefined): LogLevel {
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

export type LogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

/**
 * Bound a field value's length so one entry can't exceed journald's line
 * limit (~48KB) and arrive in Loki as unparseable truncated JSON. Nostr
 * filters may legally contain up to `max_filter_values` (20k) 64-hex
 * entries, so serialized filters need this before logging.
 */
export function clip(value: string, max = 4000): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

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

export class Logger {
  readonly level: LogLevel;

  constructor(level: LogLevel = "info") {
    this.level = level;
  }

  /**
   * Whether entries at `level` are emitted. Hot paths can use this to skip
   * building fields entirely when the level is disabled.
   */
  levelEnabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.level];
  }

  debug(msg: string, fields?: LogFields): void {
    this.write("debug", msg, fields);
  }

  info(msg: string, fields?: LogFields): void {
    this.write("info", msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.write("warn", msg, fields);
  }

  error(msg: string, fields?: LogFields): void {
    this.write("error", msg, fields);
  }

  private write(level: LogLevel, msg: string, fields?: LogFields): void {
    if (!this.levelEnabled(level)) return;
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
}
