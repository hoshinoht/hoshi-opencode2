import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_ROOT, loadPresetFile, parsePresetYaml, resolvePresetPath } from "./file";
import { activeName, activePreset, createPresetState, loadStoredName, reloadPresets } from "./state";

describe("resolvePresetPath", () => {
  it("resolves relative paths against the config root (the directory holding packages/)", () => {
    expect(CONFIG_ROOT.endsWith("/packages")).toBe(false);
    expect(resolvePresetPath("model-presets.yaml")).toBe(join(CONFIG_ROOT, "model-presets.yaml"));
    expect(resolvePresetPath("x.yaml", "/r")).toBe("/r/x.yaml");
    expect(resolvePresetPath("/abs/x.yaml", "/r")).toBe("/abs/x.yaml");
    expect(resolvePresetPath("~/p.yaml", "/r")).toBe(join(homedir(), "p.yaml"));
  });
});

describe("parsePresetYaml", () => {
  it("parses YAML with comments", () => {
    const result = parsePresetYaml("# c\ndefault: a # c\npresets:\n  a: {}\n  b:\n    tiers: { t: x/y#low }\n    default: '@t'\n", "p.yaml");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.options.presets.b?.defaultModel).toEqual({ providerID: "x", id: "y", variant: "low" });
  });

  it("reports YAML syntax errors with file:line:col", () => {
    const result = parsePresetYaml("default: a\npresets:\n  a: {\n", "/cfg/p.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^model-presets: \/cfg\/p\.yaml:\d+:\d+: YAML error: /);
  });

  it("rejects duplicate keys", () => {
    const result = parsePresetYaml("default: a\npresets:\n  a: {}\n  a: {}\n", "p.yaml");
    expect(result.ok).toBe(false);
  });

  it("points validation errors at the offending line", () => {
    const src = "default: a\npresets:\n  a:\n    agents:\n      explore: gpt-6\n";
    const result = parsePresetYaml(src, "p.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("model-presets: p.yaml:5:16: presets.a.agents.explore 'gpt-6' is malformed (expected provider/model[#variant])");

    const unknownKey = parsePresetYaml("default: a\npresets:\n  a:\n    agent: {}\n", "p.yaml");
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) expect(unknownKey.error).toMatch(/^model-presets: p\.yaml:4:\d+: presets\.a: unknown key 'agent'/);

    const badDefault = parsePresetYaml("default: z\npresets:\n  a: {}\n", "p.yaml");
    if (!badDefault.ok) expect(badDefault.error).toMatch(/p\.yaml:1:10: default 'z' is not a preset/);
  });
});

describe("loadPresetFile", () => {
  it("reads a real file and reports a missing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "model-presets-"));
    const path = join(dir, "model-presets.yaml");
    writeFileSync(path, "default: a\npresets:\n  a:\n");
    const ok = loadPresetFile(path);
    expect(ok.ok).toBe(true);
    const missing = loadPresetFile(join(dir, "nope.yaml"));
    expect(missing).toEqual({ ok: false, error: `model-presets: ${join(dir, "nope.yaml")}: preset file not found` });
  });

  it("validates the repository preset file", () => {
    const result = loadPresetFile(resolvePresetPath("model-presets.yaml"));
    if (!result.ok) throw new Error(result.error);
    expect(Object.keys(result.options.presets)).toEqual(["openai", "anthropic", "opencode"]);
    expect(result.options.default).toBe("openai");
  });
});

describe("state", () => {
  const src = "default: a\npresets:\n  a: {}\n  b:\n    default: x/y\n";
  const make = (source: { text: string }) => {
    const warnings: string[] = [];
    const state = createPresetState("p.yaml", {
      load: (p) => parsePresetYaml(source.text, p),
      warn: (w) => warnings.push(w),
    });
    return { state, warnings };
  };

  it("uses the stored preset when it exists, else the file default", () => {
    const { state } = make({ text: src });
    reloadPresets(state);
    expect(activeName(state)).toBe("a");
    state.stored = "b";
    expect(activePreset(state).name).toBe("b");
  });

  it("falls back to the default with one warning when the stored preset is gone", () => {
    const { state, warnings } = make({ text: src });
    reloadPresets(state);
    state.stored = "removed";
    expect(activeName(state)).toBe("a");
    expect(activeName(state)).toBe("a");
    expect(warnings).toEqual(["[model-presets] stored preset 'removed' no longer exists; using default 'a'"]);
  });

  it("applies an empty preset until the file first loads", () => {
    const { state, warnings } = make({ text: "presets: [" });
    reloadPresets(state);
    expect(activePreset(state)).toEqual({ name: "(none)", agents: {} });
    expect(state.lastError).toMatch(/YAML error/);
    expect(warnings).toHaveLength(1);
  });

  it("keeps the last good presets on error and warns once per distinct error", () => {
    const source = { text: src };
    const { state, warnings } = make(source);
    reloadPresets(state);
    source.text = "default: a\npresets:\n  a: { bogus: 1 }\n";
    reloadPresets(state);
    reloadPresets(state);
    expect(Object.keys(state.options!.presets)).toEqual(["a", "b"]);
    expect(state.lastError).toMatch(/keeping the last good presets/);
    expect(warnings).toHaveLength(1);
    source.text = src;
    reloadPresets(state);
    expect(state.lastError).toBeUndefined();
  });

  it("reads the stored name defensively", async () => {
    const warnings: string[] = [];
    const warn = (w: string) => warnings.push(w);
    expect(await loadStoredName({ get: async () => "b" }, warn)).toBe("b");
    expect(await loadStoredName({ get: async () => undefined }, warn)).toBeUndefined();
    expect(await loadStoredName({ get: async () => 42 }, warn)).toBeUndefined();
    expect(await loadStoredName({ get: async () => { throw new Error("db"); } }, warn)).toBeUndefined();
    expect(warnings).toHaveLength(2);
  });
});
