import { describe, expect, it } from "bun:test";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPresetDefaultModel, applyPresetToAgents, type AgentLike } from "./apply";
import { parsePresetYaml, type LoadResult } from "./file";
import modelPresets, { applyFileChange, CONFIG_PLUGINS, waitForPlugins } from "./index";
import { formatModel, parseModelString as m } from "./options";
import { activePreset, agentFingerprint, createPresetState, modelFingerprint, reloadPresets } from "./state";

const YAML = `
active: openai
presets:
  openai: {}
  anthropic:
    default: anthropic/claude-opus-5-5#medium
    model: anthropic/claude-opus-5-5
    agents:
      explore: anthropic/claude-haiku-4-5#low
`;

const CONFIG_AGENTS: Record<string, string> = {
  build: "openai/gpt-6.1-sol-1m#high",
  explore: "openai/gpt-6-luna#low",
};
const CONFIG_DEFAULT = { providerID: "openai", modelID: "gpt-6.1-sol-1m" };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(20);
  }
  return check();
}

describe("waitForPlugins", () => {
  it("resolves once every id is listed, and gives up on stop or timeout", async () => {
    let calls = 0;
    const ctx = {
      plugin: {
        list: async () => {
          calls++;
          if (calls === 1) throw new Error("starting");
          return { data: calls < 3 ? [{ id: "a" }] : [{ id: "a" }, { id: "b" }, {}] };
        },
      },
    };
    expect(await waitForPlugins(ctx, ["a", "b"], () => false, { intervalMs: 1 })).toBe(true);
    expect(calls).toBe(3);
    expect(await waitForPlugins(ctx, ["zzz"], () => false, { intervalMs: 1, timeoutMs: 10 })).toBe(false);
    expect(await waitForPlugins(ctx, ["a"], () => true)).toBe(false);
  });
});

/** Fake host for applyFileChange: rebuilds agents from config and replays the transforms. */
function liveHarness(source = YAML) {
  const file = { source };
  const warnings: string[] = [];
  const infos: string[] = [];
  const state = createPresetState("/cfg/model-presets.yaml", {
    load: (path): LoadResult => parsePresetYaml(file.source, path),
    warn: (w) => warnings.push(w),
  });
  const agents = new Map<string, AgentLike>();
  let defaultModel = { ...CONFIG_DEFAULT };
  const counts = { agents: 0, models: 0 };
  const reloadAgents = async () => {
    counts.agents++;
    for (const [id, model] of Object.entries(CONFIG_AGENTS)) agents.set(id, { id, model: m(model) });
    reloadPresets(state);
    const preset = activePreset(state);
    applyPresetToAgents(
      { list: () => [...agents.values()].map((a) => ({ ...a })), update: (id, fn) => fn(agents.get(id)!) },
      preset,
      state.memory,
    );
    state.appliedAgents = agentFingerprint(preset);
  };
  const reloadModels = async () => {
    counts.models++;
    defaultModel = { ...CONFIG_DEFAULT };
    const preset = activePreset(state);
    applyPresetDefaultModel(
      { default: { get: () => defaultModel, set: (providerID, modelID) => (defaultModel = { providerID, modelID }) } },
      preset,
    );
    state.appliedModel = modelFingerprint(preset);
  };
  const deps = { state, reloadAgents, reloadModels, info: (i: string) => infos.push(i) };
  const snapshot = () => ({
    agents: Object.fromEntries([...agents].map(([id, a]) => [id, formatModel(a.model)])),
    model: `${defaultModel.providerID}/${defaultModel.modelID}`,
  });
  return { file, state, warnings, infos, counts, deps, snapshot, boot: async () => (await reloadAgents(), await reloadModels()) };
}

describe("applyFileChange", () => {
  it("switches agents and the default model when `active` changes, and restores them exactly", async () => {
    const h = liveHarness();
    await h.boot();
    const original = h.snapshot();
    expect(original.agents).toEqual(CONFIG_AGENTS);

    h.file.source = YAML.replace("active: openai", "active: anthropic");
    expect(await applyFileChange(h.deps)).toEqual({ ok: true, agents: true, model: true });
    expect(h.snapshot()).toEqual({
      agents: { build: "anthropic/claude-opus-5-5#medium", explore: "anthropic/claude-haiku-4-5#low" },
      model: "anthropic/claude-opus-5-5",
    });
    expect(h.infos).toEqual(["[model-presets] model preset: anthropic (default model anthropic/claude-opus-5-5)"]);

    h.file.source = YAML;
    expect(await applyFileChange(h.deps)).toEqual({ ok: true, agents: true, model: true });
    expect(h.snapshot()).toEqual(original);
    expect(h.infos.at(-1)).toBe("[model-presets] model preset: openai");
  });

  it("does nothing for edits that do not affect the active preset", async () => {
    const h = liveHarness();
    await h.boot();
    const before = { ...h.counts };
    h.file.source = `${YAML}  extra: { default: x/y }\n`;
    expect(await applyFileChange(h.deps)).toEqual({ ok: true, agents: false, model: false });
    expect(h.counts).toEqual(before);
    expect(h.infos).toEqual([]);
  });

  it("reloads only agents when the global default model is unchanged", async () => {
    const h = liveHarness(YAML.replace("active: openai", "active: anthropic"));
    await h.boot();
    h.file.source = h.file.source.replace("claude-haiku-4-5#low", "claude-haiku-4-5#high");
    expect(await applyFileChange(h.deps)).toEqual({ ok: true, agents: true, model: false });
    expect(h.snapshot().agents.explore).toBe("anthropic/claude-haiku-4-5#high");
  });

  it("keeps the last good presets on a broken edit and logs file:line", async () => {
    const h = liveHarness();
    await h.boot();
    const before = { ...h.counts };
    h.file.source = YAML.replace("active: openai", "active: nope");
    expect((await applyFileChange(h.deps)).ok).toBe(false);
    expect(h.counts).toEqual(before);
    expect(h.warnings).toEqual([
      "[model-presets] model-presets: /cfg/model-presets.yaml:2:9: active 'nope' is not a preset (known: openai, anthropic) (keeping the last good presets)",
    ]);
    expect(activePreset(h.state).name).toBe("openai");
  });

  it("skips the model reload when model transforms are unavailable", async () => {
    const h = liveHarness();
    await h.boot();
    h.file.source = YAML.replace("active: openai", "active: anthropic");
    const { reloadModels: _, ...deps } = h.deps;
    expect(await applyFileChange(deps)).toEqual({ ok: true, agents: true, model: false });
  });
});

/** Minimal fake of the plugin Context covering what setup() touches. */
function fakeContext(file: string) {
  type Fn = (editor: unknown) => void;
  // Keyed by registration so re-registering the same callback yields a distinct handle.
  const agentTransforms = new Map<object, Fn>();
  const modelTransforms = new Map<object, Fn>();
  const agents = new Map<string, AgentLike>();
  let defaultModel = { ...CONFIG_DEFAULT };
  const counts = { agentReloads: 0, modelReloads: 0, commands: 0, storage: 0 };
  const agentReload = async () => {
    counts.agentReloads++;
    agents.clear();
    const editor = {
      list: () => [...agents.values()],
      update: (id: string, fn: (a: AgentLike) => void) => fn(agents.get(id)!),
    };
    // Config layer first, then plugin transforms (as the host does once
    // opencode.config.agent is active).
    for (const [id, model] of Object.entries(CONFIG_AGENTS)) agents.set(id, { id, model: m(model) });
    for (const t of agentTransforms.values()) t(editor);
  };
  const modelReload = async () => {
    counts.modelReloads++;
    defaultModel = { ...CONFIG_DEFAULT };
    const editor = { default: { get: () => defaultModel, set: (p: string, id: string) => (defaultModel = { providerID: p, modelID: id }) } };
    for (const t of modelTransforms.values()) t(editor);
  };
  const register = (map: Map<object, Fn>) => async (fn: Fn) => {
    const key = {};
    map.set(key, fn);
    return { dispose: async () => void map.delete(key) };
  };
  const ctx = {
    options: { file },
    agent: { transform: register(agentTransforms), reload: agentReload },
    model: { transform: register(modelTransforms), reload: modelReload },
    plugin: { list: async () => ({ data: CONFIG_PLUGINS.map((id) => ({ id })) }) },
    command: { transform: async () => void counts.commands++ },
    storage: new Proxy({}, { get: () => () => void counts.storage++ }),
  };
  const snapshot = () => ({
    agents: Object.fromEntries([...agents].map(([id, a]) => [id, formatModel(a.model)])),
    model: `${defaultModel.providerID}/${defaultModel.modelID}`,
  });
  return { ctx, counts, snapshot, agentReload, modelReload };
}

describe("plugin setup (fake host, real file watcher)", () => {
  it("applies `active` at load, live-applies edits (including rename-replace), and cleans up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "model-presets-plugin-"));
    const path = join(dir, "model-presets.yaml");
    writeFileSync(path, YAML);
    const host = fakeContext(path);
    const cleanup = (await modelPresets.setup(host.ctx as never)) as () => void;
    try {
      await sleep(50); // let the config-plugin wait re-register
      await host.agentReload();
      await host.modelReload();
      const original = host.snapshot();
      expect(original.agents).toEqual(CONFIG_AGENTS);
      expect(host.counts.commands).toBe(0);
      expect(host.counts.storage).toBe(0);

      const reloads = host.counts.agentReloads;
      writeFileSync(path, YAML.replace("active: openai", "active: anthropic"));
      expect(await until(() => host.snapshot().model === "anthropic/claude-opus-5-5")).toBe(true);
      expect(host.snapshot().agents).toEqual({
        build: "anthropic/claude-opus-5-5#medium",
        explore: "anthropic/claude-haiku-4-5#low",
      });
      expect(host.counts.agentReloads).toBe(reloads + 1);

      // Broken edit: nothing reloads, last good presets stay.
      writeFileSync(path, "active: anthropic\npresets: [\n");
      await sleep(600);
      expect(host.counts.agentReloads).toBe(reloads + 1);

      // Editor-style save: temp file renamed over the original.
      const tmp = join(dir, ".model-presets.yaml.tmp");
      writeFileSync(tmp, YAML);
      renameSync(tmp, path);
      expect(await until(() => host.snapshot().model === original.model)).toBe(true);
      expect(host.snapshot()).toEqual(original);
    } finally {
      cleanup();
    }
    const after = host.counts.agentReloads;
    writeFileSync(path, YAML.replace("active: openai", "active: anthropic"));
    await sleep(600);
    expect(host.counts.agentReloads).toBe(after);
  });
});
