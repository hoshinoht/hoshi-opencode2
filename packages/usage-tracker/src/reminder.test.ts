import { describe, expect, it } from "bun:test";
import { createQuotaReminder, quotaReminder, reminderThresholds } from "./reminder.ts";
import type { UsageData } from "./format.ts";

const usage = (usedPercent: number, provider = "OpenAI/Codex"): UsageData => ({
  provider, windows: [{ label: "5h", usedPercent }],
});
const event = (providerID = "openai", id = "gpt-6") => ({
  model: { providerID, id }, system: [{ type: "text" as const, text: "Original instructions" }],
});

describe("quota reminders", () => {
  it("triggers at 10% remaining, never at 10% used, for either provider", () => {
    for (const provider of ["OpenAI/Codex", "Anthropic"]) {
      expect(quotaReminder(usage(10, provider), "model", 10)).toBeUndefined();
      expect(quotaReminder(usage(89.99, provider), "model", 10)).toBeUndefined();
      expect(quotaReminder(usage(90, provider), "model", 10)).toContain(`${provider} quota has 10% or less remaining`);
      expect(quotaReminder(usage(100, provider), "model", 10)).toContain("Do not skip required checks");
    }
  });

  it("uses any applicable window and ignores other model families", () => {
    const data = { provider: "Anthropic", windows: [
      { label: "5h", usedPercent: 5 },
      { label: "Weekly Opus", usedPercent: 95 },
    ] };
    expect(quotaReminder(data, "claude-sonnet-4-6", 10)).toBeUndefined();
    expect(quotaReminder(data, "claude-opus-5-5", 10)).toContain("Weekly Opus");
    expect(quotaReminder({ ...data, windows: [{ label: "Weekly", usedPercent: 90 }] }, "claude-sonnet-4-6", 10)).toContain("Weekly");
    expect(quotaReminder({ ...data, error: "HTTP 429" }, "claude-opus-5-5", 10)).toBeUndefined();
  });

  it("validates provider thresholds and defaults to disabled", () => {
    expect(reminderThresholds({})).toEqual({});
    expect(reminderThresholds({ quotaReminderRemainingPercent: { openai: 10, anthropic: 10 } })).toEqual({ openai: 10, anthropic: 10 });
    expect(reminderThresholds({ quotaReminderRemainingPercent: { openai: NaN, anthropic: -1 } })).toEqual({});
    expect(reminderThresholds({ quotaReminderRemainingPercent: { openai: "10", anthropic: 101 } })).toEqual({});
  });

  it("shares concurrent lookups across agents, refreshes, and removes recovered reminders", async () => {
    let calls = 0;
    let clock = 0;
    let percent = 95;
    const hook = createQuotaReminder({ openai: 10 }, async () => ({
      key: "account-a",
      fetch: async () => { calls++; return usage(percent); },
    }), () => clock);
    const parent = event(), child = event();
    await Promise.all([hook(parent), hook(child)]);
    expect(calls).toBe(1);
    expect(parent.system).toEqual(child.system);
    expect(parent.system).toHaveLength(2);
    await hook(parent);
    expect(parent.system).toHaveLength(2);
    expect(calls).toBe(1);
    clock = 300_001;
    percent = 20;
    await hook(parent);
    expect(calls).toBe(2);
    expect(parent.system).toEqual(event().system);
  });

  it("separates providers and invalidates cache when active accounts change", async () => {
    let account = "a";
    let calls = 0;
    const hook = createQuotaReminder({ openai: 10, anthropic: 10 }, async (provider) => ({
      key: account,
      fetch: async () => { calls++; return usage(account === "a" ? 95 : 5, provider); },
    }));
    await hook(event());
    const claude = event("anthropic", "claude-opus");
    await hook(claude);
    expect(claude.system[1]?.text).toContain("anthropic");
    expect(calls).toBe(2);
    account = "b";
    const next = event();
    await hook(next);
    expect(calls).toBe(3);
    expect(next.system).toHaveLength(1);
    await hook(event("github-copilot"));
    expect(calls).toBe(3);
  });

  it("caches failures and tolerates missing credentials without blocking work", async () => {
    let calls = 0;
    const hook = createQuotaReminder({ openai: 10 }, async () => ({
      key: "a", fetch: async () => { calls++; throw new Error("Unavailable"); },
    }));
    const request = event();
    await hook(request);
    await hook(request);
    expect(calls).toBe(1);
    expect(request.system).toHaveLength(1);
    await createQuotaReminder({ openai: 10 }, async () => undefined)(request);
    await createQuotaReminder({ openai: 10 }, async () => { throw new Error("No integration"); })(request);
    expect(request.system).toEqual(event().system);
  });
});
