import { describe, expect, test } from "bun:test";
import { DEFAULT_CACHE_TTL_MINUTES, summarizeActivity, validateCacheTTL } from "./activity";

const MIN = 60_000;
const NOW = 100 * MIN;

// Shapes mirror live OpenCode 2 session.context output.
function assistant(createdAgoMin: number, completedAgoMin: number | undefined, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    model: { providerID: "anthropic", id: "claude-opus-5-5" },
    time: { created: NOW - createdAgoMin * MIN, ...(completedAgoMin !== undefined ? { completed: NOW - completedAgoMin * MIN } : {}) },
    tokens: { input: 2, output: 200, cache: { read: 134_019, write: 428 } },
    content: [],
    ...extra,
  };
}

describe("summarizeActivity", () => {
  test("a running shell tool is the current work", () => {
    const shell = { type: "tool", name: "shell", state: { status: "running" }, time: { created: NOW - 3 * MIN, ran: NOW - 2.9 * MIN } };
    const activity = summarizeActivity([assistant(10, 9), assistant(3, undefined, { content: [shell] })], NOW, DEFAULT_CACHE_TTL_MINUTES);
    expect(activity.current).toEqual({ what: "shell", since: NOW - 2.9 * MIN });
    expect(activity.lastActivityAt).toBe(NOW - 2.9 * MIN);
  });

  test("an unfinished assistant message without a running tool is a model response", () => {
    const activity = summarizeActivity([assistant(1, undefined)], NOW, DEFAULT_CACHE_TTL_MINUTES);
    expect(activity.current).toEqual({ what: "model response", since: NOW - MIN });
  });

  test("cache timing starts at the last completed call's request start", () => {
    const activity = summarizeActivity([assistant(40, 39), assistant(7, 2)], NOW, DEFAULT_CACHE_TTL_MINUTES);
    expect(activity.cache).toEqual({ providerID: "anthropic", lastCallAt: NOW - 7 * MIN, ttlMinutes: 5, cold: true, contextTokens: 134_449 });
  });

  test("within the lifetime the cache is warm", () => {
    const activity = summarizeActivity([assistant(3, 2.5)], NOW, DEFAULT_CACHE_TTL_MINUTES);
    expect(activity.cache?.cold).toBe(false);
  });

  test("openai gets its own lifetime and unknown providers get no cache note", () => {
    const openai = assistant(20, 19, { model: { providerID: "openai", id: "gpt-6" } });
    expect(summarizeActivity([openai], NOW, DEFAULT_CACHE_TTL_MINUTES).cache).toMatchObject({ ttlMinutes: 30, cold: false });
    const copilot = assistant(20, 19, { model: { providerID: "github-copilot", id: "x" } });
    expect(summarizeActivity([copilot], NOW, DEFAULT_CACHE_TTL_MINUTES).cache).toBeUndefined();
  });

  test("tolerates junk entries and empty history", () => {
    expect(summarizeActivity([], NOW, DEFAULT_CACHE_TTL_MINUTES)).toEqual({});
    expect(summarizeActivity([null, 3, "x", { type: "system" }], NOW, DEFAULT_CACHE_TTL_MINUTES)).toEqual({});
  });
});

describe("validateCacheTTL", () => {
  test("defaults and overrides", () => {
    expect(validateCacheTTL(undefined)).toEqual({ anthropic: 5, openai: 30 });
    expect(validateCacheTTL({ anthropic: 60 })).toEqual({ anthropic: 60 });
  });

  test("rejects bad values", () => {
    expect(() => validateCacheTTL([])).toThrow(/object/);
    expect(() => validateCacheTTL({ anthropic: 0 })).toThrow(/positive/);
    expect(() => validateCacheTTL({ openai: "30m" })).toThrow(/positive/);
  });
});
