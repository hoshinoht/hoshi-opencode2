import { describe, expect, it } from "bun:test";
import { fetchUsageResult } from "./usage.ts";

describe("usage orchestration", () => {
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
