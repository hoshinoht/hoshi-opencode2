import { describe, expect, it } from "bun:test";
import { fetchUsageResult } from "./usage.ts";

describe("usage orchestration", () => {
  it("fetches Anthropic alone without requesting other providers", async () => {
    const result = await fetchUsageResult("anthropic", {
      auth: { anthropic: { accessToken: "claude-token" }, openai: { accessToken: "openai-token" } },
      anthropic: async (token) => {
        expect(token).toBe("claude-token");
        return { provider: "Anthropic", windows: [{ label: "5h", usedPercent: 25 }] };
      },
      openai: async () => { throw new Error("Must not fetch OpenAI"); },
    });
    expect(result).toEqual({ kind: "ok", provider: "anthropic", providers: [
      { provider: "Anthropic", windows: [{ label: "5h", usedPercent: 25 }] },
    ] });
  });

  it("includes Anthropic in all providers and keeps its failure scoped", async () => {
    const result = await fetchUsageResult("all", {
      auth: {
        copilot: { accessToken: "copilot-token" },
        openai: { accessToken: "openai-token" },
        anthropic: { accessToken: "claude-secret" },
      },
      copilot: async () => ({ provider: "GitHub Copilot", windows: [] }),
      openai: async () => ({ provider: "OpenAI/Codex", windows: [] }),
      anthropic: async () => { throw new Error("claude-secret"); },
    });
    expect(result).toMatchObject({ kind: "ok", providers: [
      { provider: "GitHub Copilot" }, { provider: "OpenAI/Codex" },
      { provider: "Anthropic", error: "Request failed" },
    ] });
    expect(JSON.stringify(result)).not.toContain("claude-secret");
  });

  it("recognizes an Anthropic-only account and reports missing Anthropic auth", async () => {
    const result = await fetchUsageResult("all", {
      auth: { anthropic: { accessToken: "claude-token" } },
      anthropic: async () => ({ provider: "Anthropic", windows: [] }),
    });
    expect(result).toEqual({ kind: "ok", provider: "all", providers: [{ provider: "Anthropic", windows: [] }] });
    expect(await fetchUsageResult("anthropic", { auth: {} })).toEqual({
      kind: "error", provider: "anthropic", message: "Provider not configured: anthropic",
    });
  });
  it("keeps a successful provider when the other provider fails", async () => {
    const result = await fetchUsageResult("all", {
      auth: {
        copilot: { accessToken: "copilot-secret" },
        openai: { accessToken: "openai-secret" },
      },
      copilot: async () => ({
        provider: "GitHub Copilot",
        windows: [{ label: "Premium", usedPercent: 10 }],
      }),
      openai: async () => {
        throw new Error("openai-secret should never be surfaced");
      },
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.providers).toHaveLength(2);
    expect(result.providers[0]).toMatchObject({ provider: "GitHub Copilot" });
    expect(result.providers[1]).toMatchObject({ provider: "OpenAI/Codex", error: "Request failed" });
    expect(JSON.stringify(result)).not.toContain("openai-secret");
  });

  it("reports missing credentials without attempting a request", async () => {
    let called = false;
    const result = await fetchUsageResult("openai", {
      auth: { copilot: { accessToken: "copilot-secret" } },
      openai: async () => {
        called = true;
        return { provider: "OpenAI/Codex", windows: [] };
      },
    });

    expect(result).toEqual({ kind: "error", provider: "openai", message: "Provider not configured: openai" });
    expect(called).toBe(false);
  });
});
