import { describe, expect, it } from "bun:test";
import { formatUsageResult, formatUsageTable } from "./format.ts";
import { parseCopilotUsage } from "./providers/copilot.ts";
import { parseOpenAIUsage } from "./providers/openai.ts";

const NOW = new Date("2026-09-15T10:00:00.000Z");

describe("Copilot usage parsing", () => {
  it("parses premium/chat quotas, plan, and reset details", () => {
    const result = parseCopilotUsage(
      {
        copilot_plan: "individual",
        quota_reset_date_utc: "2026-09-20T10:00:00.000Z",
        quota_snapshots: {
          premium_interactions: { remaining: 25, entitlement: 100, unlimited: false },
          chat: { remaining: 8, entitlement: 10, unlimited: false },
        },
      },
      NOW,
    );

    expect(result).toMatchObject({ provider: "GitHub Copilot", planType: "Pro" });
    expect(result.windows.map((window) => [window.label, window.usedPercent])).toEqual([
      ["Premium", 75],
      ["Chat", 20],
    ]);
    expect(result.windows[0]?.resetTime).toContain("5d");
    expect(result.extra).toEqual({ Requests: "75/100 used", Remaining: "25 requests" });
  });
});

describe("OpenAI usage parsing", () => {
  it("parses rate-limit windows and credits in stable order", () => {
    const result = parseOpenAIUsage(
      {
        plan_type: "pro",
        rate_limit: {
          secondary_window: { used_percent: 80, limit_window_seconds: 604800, reset_at: 1780000000 },
          primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_after_seconds: 3600 },
        },
        credits: { balance: "1.5" },
      },
      NOW,
    );

    expect(result).toMatchObject({ provider: "OpenAI/Codex", planType: "Pro", extra: { Credits: "$1.50" } });
    expect(result.windows.map((window) => [window.label, window.usedPercent])).toEqual([
      ["5h", 40],
      ["Weekly", 80],
    ]);
    expect(result.windows[0]?.resetTime).toContain("1h");
  });

  it("formats provider data as readable text", () => {
    const result = parseOpenAIUsage(
      {
        rate_limit: { primary_window: { used_percent: 90, limit_window_seconds: 18000 } },
        credits: { unlimited: true },
      },
      NOW,
    );
    const text = formatUsageTable([result]);
    expect(text).toContain("OpenAI/Codex");
    expect(text).toContain("90%");
    expect(text).toContain("Credits: Unlimited");
    expect(formatUsageResult({ kind: "empty", provider: "all", message: "No auth" })).toBe("No auth");
  });
});
