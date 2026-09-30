import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePresetYaml, type LoadResult } from "./file";
import { createLogger, defaultLogPath, formatLogLine, newestHalf, resolveLogPath } from "./log";
import { createPresetState, reloadPresets } from "./state";

const NOW = new Date("2026-10-01T12:00:00.000Z");

function quietConsole() {
  const lines: string[] = [];
  const push = (level: string) => (m: string) => void lines.push(`${level} ${m}`);
  return { lines, console: { info: push("info"), warn: push("warn"), error: push("error") } };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "model-presets-log-"));
}

describe("log paths", () => {
  it("defaults to $XDG_STATE_HOME/opencode, else ~/.local/state/opencode", () => {
    expect(defaultLogPath({ XDG_STATE_HOME: "/x/state" }, "/home/u")).toBe("/x/state/opencode/model-presets.log");
    expect(defaultLogPath({}, "/home/u")).toBe("/home/u/.local/state/opencode/model-presets.log");
    expect(defaultLogPath({ XDG_STATE_HOME: "relative" }, "/home/u")).toBe("/home/u/.local/state/opencode/model-presets.log");
  });

  it("resolves the logFile option: false disables, ~ expands", () => {
    expect(resolveLogPath(false)).toBeUndefined();
    expect(resolveLogPath("~/logs/mp.log", "/home/u")).toBe("/home/u/logs/mp.log");
    expect(resolveLogPath("/var/log/mp.log", "/home/u")).toBe("/var/log/mp.log");
    expect(resolveLogPath(undefined)).toMatch(/opencode\/model-presets\.log$/);
  });

  it("formats ISO timestamp, level and message on one line", () => {
    expect(formatLogLine("warn", "a\nb", NOW)).toBe("2026-10-01T12:00:00.000Z WARN a b\n");
  });
});

describe("createLogger", () => {
  it("writes to the console and appends to the file, creating its directory", () => {
    const path = join(tempDir(), "nested", "dir", "model-presets.log");
    const c = quietConsole();
    const log = createLogger({ path, now: () => NOW, console: c.console });
    log.info("[model-presets] model preset: openai");
    log.error("[model-presets] boom");
    expect(c.lines).toEqual(["info [model-presets] model preset: openai", "error [model-presets] boom"]);
    expect(readFileSync(path, "utf8")).toBe(
      "2026-10-01T12:00:00.000Z INFO [model-presets] model preset: openai\n" +
        "2026-10-01T12:00:00.000Z ERROR [model-presets] boom\n",
    );
    expect(log.path).toBe(path);
  });

  it("logs to the console only when disabled", () => {
    const c = quietConsole();
    const log = createLogger({ path: undefined, console: c.console });
    log.warn("x");
    expect(c.lines).toEqual(["warn x"]);
    expect(log.path).toBeUndefined();
  });

  it("never throws on an unwritable path and falls back to the console", () => {
    const dir = tempDir();
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "");
    const c = quietConsole();
    const log = createLogger({ path: join(blocker, "model-presets.log"), console: c.console });
    expect(() => log.warn("first")).not.toThrow();
    expect(() => log.warn("second")).not.toThrow();
    expect(c.lines[0]).toBe("warn first");
    expect(c.lines[1]).toMatch(/^warn \[model-presets\] cannot write log file .*not-a-dir\/model-presets\.log; logging to the console only/);
    expect(c.lines[2]).toBe("warn second");
    expect(c.lines).toHaveLength(3); // the failure is reported once
    expect(log.path).toBeUndefined();
  });

  it("does not throw when the file is read-only", () => {
    if (process.getuid?.() === 0) return; // root ignores permissions
    const dir = tempDir();
    const path = join(dir, "model-presets.log");
    writeFileSync(path, "");
    chmodSync(path, 0o444);
    const c = quietConsole();
    const log = createLogger({ path, console: c.console });
    expect(() => log.info("x")).not.toThrow();
    expect(c.lines.some((l) => l.includes("cannot write log file"))).toBe(true);
  });

  it("keeps the newest half when the file would exceed maxBytes", () => {
    const path = join(tempDir(), "model-presets.log");
    const c = quietConsole();
    const maxBytes = 1000;
    const log = createLogger({ path, maxBytes, now: () => NOW, console: c.console });
    for (let i = 0; i < 100; i++) log.info(`line ${String(i).padStart(3, "0")}`);
    const text = readFileSync(path, "utf8");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(maxBytes);
    const lines = text.trimEnd().split("\n");
    expect(lines.at(-1)).toBe("2026-10-01T12:00:00.000Z INFO line 099");
    // Every kept line is whole and lines are contiguous up to the newest.
    for (const line of lines) expect(line).toMatch(/^2026-10-01T12:00:00\.000Z INFO line \d{3}$/);
    const numbers = lines.map((l) => Number(l.slice(-3)));
    expect(numbers).toEqual(numbers.map((_, i) => numbers[0]! + i));
    expect(numbers[0]).toBeGreaterThan(0);
  });

  it("newestHalf cuts at a line boundary", () => {
    expect(newestHalf("aaaa\nbbbb\ncccc\n", 12)).toBe("cccc\n");
    expect(newestHalf("ab\n", 100)).toBe("ab\n");
  });
});

describe("preset errors in the log file", () => {
  it("logs a repeated identical error once, a new error again, and the recovery", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "model-presets.log");
    const c = quietConsole();
    const log = createLogger({ path, now: () => NOW, console: c.console });
    const file = { source: "active: a\npresets:\n  a: {}\n" };
    const state = createPresetState("/cfg/model-presets.yaml", {
      load: (p): LoadResult => parsePresetYaml(file.source, p),
      warn: log.warn,
      error: log.error,
      info: log.info,
    });
    expect(reloadPresets(state).ok).toBe(true);
    expect(existsSync(path)).toBe(false); // a good load logs nothing

    file.source = "active: nope\npresets:\n  a: {}\n";
    for (let i = 0; i < 3; i++) expect(reloadPresets(state).ok).toBe(false);
    file.source = "active: a\npresets: [\n";
    reloadPresets(state);
    reloadPresets(state);
    file.source = "active: a\npresets:\n  a: {}\n";
    reloadPresets(state);
    reloadPresets(state);

    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      /^2026-10-01T12:00:00\.000Z ERROR \[model-presets\] model-presets: \/cfg\/model-presets\.yaml:1:9: active 'nope' is not a preset/,
    );
    expect(lines[1]).toMatch(/^\S+ ERROR \[model-presets\] model-presets: \/cfg\/model-presets\.yaml:\d+:\d+: YAML error/);
    expect(lines[2]).toBe(
      "2026-10-01T12:00:00.000Z INFO [model-presets] /cfg/model-presets.yaml: preset file is valid again (active: a)",
    );
  });
});
