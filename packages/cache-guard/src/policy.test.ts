import { describe, expect, it } from "bun:test";
import { evaluateCacheRisk, formatWarning, selectEligibleResponse, validateOptions } from "./policy";

const now = 1_800_000;
const eligible = (overrides: Record<string, unknown> = {}) => ({ type: "assistant", id: "msg_1", model: { providerID: "openai", id: "gpt-5.6" }, time: { completed: 0 }, tokens: { cache: { read: 10_000, write: 99_999 } }, ...overrides });

describe("cache guard policy", () => {
  it("uses exact risk threshold boundaries", () => {
    const options = validateOptions(undefined);
    expect(evaluateCacheRisk("ses_1", [eligible()], options, now - 1)).toBeUndefined();
    expect(evaluateCacheRisk("ses_1", [eligible()], options, now)).toMatchObject({ idleMinutes: 30 });
  });

  it("validates documented options", () => {
    expect(validateOptions({ mode: "confirm", providerIDs: ["openai", "azure"], diagnosticsLimit: 1 })).toMatchObject({ mode: "confirm", providerIDs: ["openai", "azure"] });
    expect(() => validateOptions({ mode: "block" })).toThrow();
    expect(() => validateOptions({ providerIDs: [] })).toThrow();
    expect(() => validateOptions({ unknown: true })).toThrow();
  });

  it("excludes wrong providers and zero or missing cache reads", () => {
    const options = validateOptions(undefined);
    expect(selectEligibleResponse([eligible({ model: { providerID: "anthropic", id: "x" } })], options)).toBeUndefined();
    expect(selectEligibleResponse([eligible({ tokens: { cache: { read: 0 } } })], options)).toBeUndefined();
    expect(selectEligibleResponse([eligible({ tokens: {} })], options)).toBeUndefined();
  });

  it("ignores role-only assistant-shaped objects", () => {
    const roleOnly = { ...eligible(), type: undefined, role: "assistant" };
    expect(selectEligibleResponse([roleOnly], validateOptions(undefined))).toBeUndefined();
  });

  it("selects the newest completed assistant response when it is eligible", () => {
    const selected = selectEligibleResponse([eligible({ id: "old", time: { completed: 10 } }), { type: "user" }, eligible({ id: "new", time: { completed: 20 } })], validateOptions(undefined));
    expect(selected?.id).toBe("new");
  });

  it("does not fall back to an older cache hit after a newer OpenAI cache miss", () => {
    const messages = [eligible({ id: "old", time: { completed: 10 } }), eligible({ id: "miss", time: { completed: 20 }, tokens: { cache: { read: 0 } } })];
    expect(selectEligibleResponse(messages, validateOptions(undefined))).toBeUndefined();
  });

  it("does not fall back to an older OpenAI cache hit after a newer provider response", () => {
    const messages = [eligible({ id: "old", time: { completed: 10 } }), eligible({ id: "other", time: { completed: 20 }, model: { providerID: "anthropic", id: "claude" } })];
    expect(selectEligibleResponse(messages, validateOptions(undefined))).toBeUndefined();
  });

  it("suppresses a hit after a native provider switch record", () => {
    const messages = [eligible(), { type: "model-switched", id: "msg_switch", time: { created: 1 }, model: { providerID: "anthropic", id: "claude" }, previous: { providerID: "openai", id: "gpt-5.6" } }];
    expect(selectEligibleResponse(messages, validateOptions(undefined))).toBeUndefined();
  });

  it("suppresses a hit after switching to another model on the same provider", () => {
    const messages = [eligible(), { type: "model-switched", id: "msg_switch", time: { created: 1 }, model: { providerID: "openai", id: "gpt-5.6-mini" }, previous: { providerID: "openai", id: "gpt-5.6" } }];
    expect(selectEligibleResponse(messages, validateOptions(undefined))).toBeUndefined();
  });

  it("keeps a hit after a redundant native switch to the same model", () => {
    const messages = [eligible(), { type: "model-switched", id: "msg_switch", time: { created: 1 }, model: { providerID: "openai", id: "gpt-5.6" } }];
    expect(selectEligibleResponse(messages, validateOptions(undefined))?.id).toBe("msg_1");
  });

  it("formats privacy-preserving diagnostics without prompt text or cache writes", () => {
    const risk = evaluateCacheRisk("ses_secret", [eligible({ parts: [{ text: "SECRET-PROMPT" }] })], validateOptions(undefined), now)!;
    const warning = formatWarning(risk);
    expect(warning).toMatch(/10,000 cache-read tokens/);
    expect(warning).not.toContain("SECRET-PROMPT");
    expect(warning).not.toContain("99999");
  });
});
