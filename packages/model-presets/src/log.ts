/**
 * Plugin log: every line goes to the console and, unless disabled, is also
 * appended to a log file. When OpenCode runs as a background service its
 * console output is not visible, so the file is where a broken preset edit
 * (with its file:line:col) or an applied switch can be seen.
 *
 * The file is kept small: once it would exceed `maxBytes` the oldest half is
 * dropped (at a line boundary). File errors never throw; the first one is
 * reported on the console and the logger falls back to console only.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { PREFIX } from "./options";

export const LOG_FILE_NAME = "model-presets.log";
export const MAX_LOG_BYTES = 256 * 1024;

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Absolute log file path, or undefined when file logging is off (disabled or failed). */
  readonly path: string | undefined;
}

/** `$XDG_STATE_HOME/opencode/model-presets.log`, else `~/.local/state/opencode/model-presets.log`. */
export function defaultLogPath(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  const state = env.XDG_STATE_HOME;
  const base = state && isAbsolute(state) ? state : join(home, ".local", "state");
  return join(base, "opencode", LOG_FILE_NAME);
}

/** Resolve the `logFile` plugin option: undefined = default path, false = disabled, `~` expanded. */
export function resolveLogPath(option: string | false | undefined, home: string = homedir()): string | undefined {
  if (option === false) return undefined;
  if (option === undefined) return defaultLogPath(process.env, home);
  if (option === "~") return home;
  if (option.startsWith("~/")) return join(home, option.slice(2));
  return option;
}

/** One log line: ISO timestamp, level, message (newlines flattened). */
export function formatLogLine(level: LogLevel, message: string, now: Date = new Date()): string {
  return `${now.toISOString()} ${level.toUpperCase()} ${message.replace(/\r?\n/g, " ")}\n`;
}

/** Keep the newest half of `text` (by bytes), starting at a line boundary. */
export function newestHalf(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  const keep = Math.floor(maxBytes / 2);
  if (buf.length <= keep) return text;
  const tail = buf.subarray(buf.length - keep).toString("utf8");
  const newline = tail.indexOf("\n");
  return newline === -1 ? "" : tail.slice(newline + 1);
}

export interface LoggerOptions {
  /** Log file; undefined = console only. */
  path?: string;
  maxBytes?: number;
  now?: () => Date;
  console?: Pick<Console, "info" | "warn" | "error">;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const out = options.console ?? console;
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
  const now = options.now ?? (() => new Date());
  let path = options.path;
  let dirReady = false;

  const append = (line: string) => {
    if (path === undefined) return;
    try {
      if (!dirReady) {
        mkdirSync(dirname(path), { recursive: true });
        dirReady = true;
      }
      let size = 0;
      try {
        size = statSync(path).size;
      } catch {
        // Missing file: created by the append below.
      }
      const lineBytes = Buffer.byteLength(line);
      if (size > 0 && size + lineBytes > maxBytes) {
        writeFileSync(path, newestHalf(readFileSync(path, "utf8"), maxBytes) + line);
      } else {
        appendFileSync(path, line);
      }
    } catch (error) {
      const failed = path;
      path = undefined;
      out.warn(`[${PREFIX}] cannot write log file ${failed}; logging to the console only: ${String(error)}`);
    }
  };

  const log = (level: LogLevel) => (message: string) => {
    out[level](message);
    append(formatLogLine(level, message, now()));
  };

  return {
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    get path() {
      return path;
    },
  };
}
