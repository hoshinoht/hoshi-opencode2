import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_ROOT, loadPresetFile, parsePresetYaml, resolvePresetPath } from "./file";
import {
  activeName,
  activePreset,
  agentFingerprint,
  createPresetState,
  modelFingerprint,
  pendingReloads,
  reloadPresets,
} from "./state";

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
    const result = parsePresetYaml("# c\nactive: a # c\npresets:\n  a: {}\n  b:\n    tiers: { t: x/y#low }\n    default: '@t'\n", "p.yaml");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.options.presets.b?.defaultModel).toEqual({ providerID: "x", id: "y", variant: "low" });
  });

  it("reports YAML syntax errors with file:line:col", () => {
    const result = parsePresetYaml("active: a\npresets:\n  a: {\n", "/cfg/p.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^model-presets: \/cfg\/p\.yaml:\d+:\d+: YAML error: /);
  });

  it("rejects duplicate keys", () => {
    const result = parsePresetYaml("active: a\npresets:\n  a: {}\n  a: {}\n", "p.yaml");
    expect(result.ok).toBe(false);
  });

  it("points validation errors at the offending line", () => {
    const src = "active: a\npresets:\n  a:\n    agents:\n      explore: gpt-6\n";
    const result = parsePresetYaml(src, "p.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("model-presets: p.yaml:5:16: presets.a.agents.explore 'gpt-6' is malformed (expected provider/model[#variant])");

    const unknownKey = parsePresetYaml("active: a\npresets:\n  a:\n    agent: {}\n", "p.yaml");
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) expect(unknownKey.error).toMatch(/^model-presets: p\.yaml:4:\d+: presets\.a: unknown key 'agent'/);

    const badActive = parsePresetYaml("active: z\npresets:\n  a: {}\n", "p.yaml");
    expect(badActive.ok).toBe(false);
    if (!badActive.ok) expect(badActive.error).toMatch(/p\.yaml:1:9: active 'z' is not a preset/);

    const badAlias = parsePresetYaml("default: z\npresets:\n  a: {}\n", "p.yaml");
    expect(badAlias.ok).toBe(false);
    if (!badAlias.ok) expect(badAlias.error).toMatch(/p\.yaml:1:10: default 'z' is not a preset/);
  });
});

describe("loadPresetFile", () => {
  it("reads a real file and reports a missing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "model-presets-"));
    const path = join(dir, "model-presets.yaml");
    writeFileSync(path, "active: a\npresets:\n  a:\n");
    const ok = loadPresetFile(path);
    expect(ok.ok).toBe(true);
    const missing = loadPresetFile(join(dir, "nope.yaml"));
    expect(missing).toEqual({ ok: false, error: `model-presets: ${join(dir, "nope.yaml")}: preset file not found` });
  });

  it("validates the repository preset file", () => {
    const result = loadPresetFile(resolvePresetPath("model-presets.yaml"));
    if (!result.ok) throw new Error(result.error);
    expect(Object.keys(result.options.presets)).toEqual(["openai", "anthropic", "opencode"]);
    expect(result.options.active).toBe("openai");
    expect(result.options.note).toBeUndefined();
  });
});

describe("state", () => {
  const src = "active: a\npresets:\n  a: {}\n  b:\n    default: x/y\n    model: p/m\n";
  const make = (source: { text: string }) => {
    const warnings: string[] = [];
    const state = createPresetState("p.yaml", {
      load: (p) => parsePresetYaml(source.text, p),
      warn: (w) => warnings.push(w),
    });
    return { state, warnings };
  };

  it("selects the preset named by `active`", () => {
    const source = { text: src };
    const { state, warnings } = make(source);
    expect(reloadPresets(state)).toEqual({ ok: true });
    expect(activeName(state)).toBe("a");
    source.text = src.replace("active: a", "active: b");
    reloadPresets(state);
    expect(activePreset(state).name).toBe("b");
    expect(warnings).toEqual([]);
  });

  it("accepts the deprecated top-level `default` and notes it once", () => {
    const source = { text: src.replace("active: a", "default: b") };
    const { state, warnings } = make(source);
    reloadPresets(state);
    reloadPresets(state);
    expect(activeName(state)).toBe("b");
    expect(warnings).toEqual(["[model-presets] p.yaml: top-level 'default' is deprecated; rename it to 'active'"]);
  });

  it("prefers `active` over `default` when both are set, with a one-time note", () => {
    const source = { text: `default: b\n${src}` };
    const { state, warnings } = make(source);
    reloadPresets(state);
    reloadPresets(state);
    expect(activeName(state)).toBe("a");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/both 'active' and the deprecated top-level 'default' are set; using active 'a'/);
  });

  it("applies an empty preset until the file first loads", () => {
    const { state, warnings } = make({ text: "presets: [" });
    const result = reloadPresets(state);
    expect(result.ok).toBe(false);
    expect(activePreset(state)).toEqual({ name: "(none)", agents: {} });
    expect(state.lastError).toMatch(/YAML error/);
    expect(warnings).toHaveLength(1);
  });

  it("keeps the last good presets on error and logs each error until a good load", () => {
    const source = { text: src };
    const { state, warnings } = make(source);
    reloadPresets(state);
    const broken = "active: a\npresets:\n  a: { bogus: 1 }\n";
    source.text = broken;
    reloadPresets(state);
    reloadPresets(state);
    expect(Object.keys(state.options!.presets)).toEqual(["a", "b"]);
    expect(state.lastError).toMatch(/^model-presets: p\.yaml:3:\d+: .*keeping the last good presets/);
    expect(warnings).toHaveLength(1);
    source.text = src;
    reloadPresets(state);
    expect(state.lastError).toBeUndefined();
    // The same mistake again is logged again.
    source.text = broken;
    reloadPresets(state);
    expect(warnings).toHaveLength(2);
  });

  it("tracks which reloads the active preset still needs", () => {
    const source = { text: src };
    const { state } = make(source);
    reloadPresets(state);
    expect(pendingReloads(state)).toEqual({ agents: true, model: false });
    state.appliedAgents = agentFingerprint(activePreset(state));
    state.appliedModel = modelFingerprint(activePreset(state));
    expect(pendingReloads(state)).toEqual({ agents: false, model: false });
    source.text = src.replace("active: a", "active: b");
    reloadPresets(state);
    expect(pendingReloads(state)).toEqual({ agents: true, model: true });
    // Editing an inactive preset needs no reload.
    state.appliedAgents = agentFingerprint(activePreset(state));
    state.appliedModel = modelFingerprint(activePreset(state));
    source.text = source.text + "  c: { default: q/r }\n";
    reloadPresets(state);
    expect(pendingReloads(state)).toEqual({ agents: false, model: false });
  });
});
