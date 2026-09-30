import { describe, expect, it } from "bun:test";
import { ensurePresetApplied, findPresetMismatches } from "./index";
import type { ResolvedPreset } from "./options";

const preset = {
  name: "anthropic",
  agents: { build: { providerID: "anthropic", id: "claude-opus-5-5", variant: "medium" } },
} as unknown as ResolvedPreset;
const wanted = { providerID: "anthropic", id: "claude-opus-5-5", variant: "medium" };
const config = { providerID: "openai", id: "gpt-6.1-sol-1m", variant: "high" };

function deps(lists: Array<Array<{ id: string; model: typeof wanted }>>) {
  const log: string[] = [];
  let reapplies = 0;
  let call = 0;
  return {
    log,
    reapplies: () => reapplies,
    value: {
      listAgents: async () => lists[Math.min(call++, lists.length - 1)],
      preset: () => preset,
      reapply: async () => void reapplies++,
      stop: () => false,
      warn: (m: string) => log.push(`WARN ${m}`),
      info: (m: string) => log.push(`INFO ${m}`),
      delaysMs: [1, 1, 1],
    },
  };
}

describe("findPresetMismatches", () => {
  it("lists agents whose model differs from the preset and ignores unlisted agents", () => {
    expect(findPresetMismatches([{ id: "build", model: config }, { id: "explore", model: config }], preset)).toEqual(["build"]);
    expect(findPresetMismatches([{ id: "build", model: wanted }], preset)).toEqual([]);
  });
});

describe("ensurePresetApplied", () => {
  it("does nothing when the preset is already in effect", async () => {
    const d = deps([[{ id: "build", model: wanted }]]);
    expect(await ensurePresetApplied(d.value)).toBe(true);
    expect(d.reapplies()).toBe(0);
    expect(d.log).toEqual([]);
  });

  it("re-applies after a host reload let config models win", async () => {
    const d = deps([[{ id: "build", model: config }], [{ id: "build", model: wanted }]]);
    expect(await ensurePresetApplied(d.value)).toBe(true);
    expect(d.reapplies()).toBe(1);
    expect(d.log.some((l) => l.startsWith("INFO") && l.includes("re-applied"))).toBe(true);
  });

  it("gives up with a warning naming the agents after bounded retries", async () => {
    const d = deps([[{ id: "build", model: config }]]);
    expect(await ensurePresetApplied(d.value)).toBe(false);
    expect(d.reapplies()).toBe(3);
    expect(d.log.at(-1)).toContain("not in effect for: build");
  });
});
