import { describe, expect, it } from "bun:test";
import { ANTHROPIC_USAGE_ENDPOINT, fetchAnthropicUsage, parseAnthropicUsage } from "./anthropic.ts";

describe("Anthropic subscription quota", () => {
  it("parses shared and model-specific windows without treating spending as quota", () => {
    const data = parseAnthropicUsage({
      five_hour: { utilization: 90, resets_at: "2026-10-02T12:00:00Z" },
      seven_day: { utilization: 42 },
      seven_day_opus: { utilization: 95 },
      seven_day_sonnet: null,
      extra_usage: { utilization: 100 },
    }, new Date("2026-10-02T11:00:00Z"));
    expect(data.windows.map((w) => [w.label, w.usedPercent])).toEqual([["5h", 90], ["Weekly", 42], ["Weekly Opus", 95]]);
    expect(data.windows[0]?.resetTime).toContain("1h");
  });

  it("rejects missing, malformed and out-of-range quota readings", () => {
    for (const value of [null, [], {}, { five_hour: { utilization: NaN } }, { five_hour: { utilization: 110 } }]) {
      expect(parseAnthropicUsage(value).error).toBe("Invalid usage response");
    }
  });

  it("uses the OAuth endpoint and does not expose error bodies", async () => {
    const fetcher = (async (url, init) => {
      expect(url).toBe(ANTHROPIC_USAGE_ENDPOINT);
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer test-token");
      expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
      return new Response("sensitive error body", { status: 429 });
    }) as typeof fetch;
    expect(await fetchAnthropicUsage("test-token", { fetch: fetcher })).toEqual({ provider: "Anthropic", windows: [], error: "HTTP 429" });
  });
});
