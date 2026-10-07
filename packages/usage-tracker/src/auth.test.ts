import { describe, expect, it } from "bun:test";
import {
  getAuthJsonPaths,
  mergeRuntimeOpenAI,
  normalizeAuth,
  normalizeAnthropicCredential,
  normalizeOpenAICredential,
  readAuthTokens,
} from "./auth.ts";

describe("auth normalization", () => {
  it("accepts Anthropic OAuth credentials from storage and the live integration, excluding API keys", () => {
    const credential = { type: "oauth", access: " claude-token ", refresh: "private-refresh" };
    expect(normalizeAnthropicCredential(credential)).toEqual({ accessToken: "claude-token" });
    expect(normalizeAuth({ anthropic: credential })).toEqual({ anthropic: { accessToken: "claude-token" } });
    expect(normalizeAuth({ anthropic: { type: "api", key: "api-key" } })).toEqual({});
    expect(normalizeAnthropicCredential({ type: "oauth", access: " " })).toBeUndefined();
  });
  it("normalizes provider aliases and trims credential metadata", () => {
    expect(
      normalizeAuth({
        "github-copilot": { access: "  copilot-token  " },
        chatgpt: { accessToken: " openai-token ", account_id: " acct_123 " },
        unrelated: { access: "must-not-be-copied" },
      }),
    ).toEqual({
      copilot: { accessToken: "copilot-token" },
      openai: { accessToken: "openai-token", accountId: "acct_123" },
    });
  });

  it("fails closed for malformed entries", () => {
    expect(normalizeAuth(null)).toEqual({});
    expect(normalizeAuth({ copilot: { access: "   " }, openai: [], chatgpt: { accountId: 42 } })).toEqual({});
  });

  it("normalizes a live V2 OpenAI OAuth credential", () => {
    expect(
      normalizeOpenAICredential({
        type: "oauth",
        access: " refreshed-token ",
        refresh: "not-returned",
        expires: 123,
        metadata: { accountId: " account-live " },
      }),
    ).toEqual({ accessToken: "refreshed-token", accountId: "account-live" });
    expect(normalizeOpenAICredential({ type: "key", key: "api-key" })).toBeUndefined();
  });

  it("prefers live OAuth access while retaining the stored account ID and Copilot token", () => {
    const merged = mergeRuntimeOpenAI(
      {
        copilot: { accessToken: "copilot-token" },
        openai: { accessToken: "expired-token", accountId: "account-stored" },
      },
      { type: "oauth", access: "fresh-token", refresh: "refresh-token", expires: 456 },
    );
    expect(merged).toEqual({
      copilot: { accessToken: "copilot-token" },
      openai: { accessToken: "fresh-token", accountId: "account-stored" },
    });
  });

  it("uses injected paths and readers without depending on cwd", async () => {
    const paths = getAuthJsonPaths({ home: "/home/tester", xdgDataHome: "/data", platform: "darwin" });
    expect(paths).toEqual([
      "/home/tester/Library/Application Support/opencode/auth.json",
      "/data/opencode/auth.json",
      "/home/tester/.local/share/opencode/auth.json",
    ]);

    const tokens = await readAuthTokens({
      paths: ["/virtual/auth.json"],
      readFile: async (path) => {
        expect(path).toBe("/virtual/auth.json");
        return JSON.stringify({ openai: { access: "token" } });
      },
    });
    expect(tokens).toEqual({ openai: { accessToken: "token" } });
  });
});
