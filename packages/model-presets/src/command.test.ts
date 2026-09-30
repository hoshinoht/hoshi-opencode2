import { describe, expect, it } from "bun:test";
import { applyPresetToAgents, type AgentEditorLike, type AgentLike } from "./apply";
import { parsePresetArgs, runPresetCommand, type CommandDeps } from "./command";
import { parsePresetYaml, type LoadResult } from "./file";
import { parseModelString as m } from "./options";
import { activePreset, createPresetState, reloadPresets, STORAGE_KEY } from "./state";

const YAML = `
default: openai
presets:
  openai: {}
  anthropic:
    default: anthropic/claude-opus-5-5#medium
    agents:
      explore: anthropic/claude-haiku-4-5#low
`;

/** Fake host: agent editor, storage and a mutable preset file. */
function harness(source = YAML) {
  const file = { source };
  const agents = new Map<string, AgentLike>();
  const editor: AgentEditorLike = {
    list: () => [...agents.values()].map((a) => ({ ...a })),
    update: (id, fn) => fn(agents.get(id)!),
  };
  const warnings: string[] = [];
  const state = createPresetState("/cfg/model-presets.yaml", {
    load: (path): LoadResult => parsePresetYaml(file.source, path),
    warn: (w) => warnings.push(w),
  });
  const stored = new Map<string, unknown>();
  let reloads = 0;
  // Mirrors the host: rebuild agents from config, then run the plugin's
  // agent transform (re-read the file, apply the active preset).
  const reload = () => {
    reloads++;
    agents.set("build", { id: "build", model: m("openai/gpt-6.1-sol-1m#high") });
    agents.set("explore", { id: "explore", model: m("openai/gpt-6-luna#low") });
    reloadPresets(state);
    applyPresetToAgents(editor, activePreset(state), state.memory, (w) => warnings.push(w));
  };
  reload();
  const deps: CommandDeps = {
    state,
    activate: async (name) => {
      stored.set(STORAGE_KEY, name);
      state.stored = name;
      reload();
    },
    refresh: async () => reload(),
  };
  return { deps, agents, stored, file, warnings, state, reloads: () => reloads };
}

describe("parsePresetArgs", () => {
  it("handles empty, bare, prefixed and extra arguments", () => {
    expect(parsePresetArgs(undefined)).toEqual({});
    expect(parsePresetArgs("   ")).toEqual({});
    expect(parsePresetArgs(" anthropic ")).toEqual({ name: "anthropic" });
    expect(parsePresetArgs("/preset anthropic")).toEqual({ name: "anthropic" });
    expect(parsePresetArgs("/preset")).toEqual({});
    expect(parsePresetArgs("a b").error).toMatch(/at most one/);
  });
});

describe("runPresetCommand", () => {
  it("lists presets, marks the active one and shows effective models", async () => {
    const h = harness();
    const reply = await runPresetCommand("", h.deps);
    expect(reply).toMatch(/Model presets from \/cfg\/model-presets\.yaml/);
    expect(reply).toMatch(/\* openai\s+config models \(no overrides\)/);
    expect(reply).toMatch(/ {2}anthropic\s+1 agent override, others -> anthropic\/claude-opus-5-5#medium/);
    expect(reply).toMatch(/build\s+openai\/gpt-6\.1-sol-1m#high\n/);
    expect(h.reloads()).toBe(2);
    expect(h.stored.size).toBe(0);
  });

  it("switches, stores, reloads and reports the new models", async () => {
    const h = harness();
    const reply = await runPresetCommand("anthropic", h.deps);
    expect(reply).toMatch(/Switched model preset: openai -> anthropic\./);
    expect(reply).toMatch(/explicit per-session model keep it/);
    expect(reply).toMatch(/explore\s+anthropic\/claude-haiku-4-5#low {2}\(preset\)/);
    expect(h.stored.get(STORAGE_KEY)).toBe("anthropic");
    expect(h.reloads()).toBe(2);
    expect(h.agents.get("build")?.model?.providerID).toBe("anthropic");

    await runPresetCommand("/preset openai", h.deps);
    expect(h.agents.get("build")?.model).toEqual(m("openai/gpt-6.1-sol-1m#high"));
    expect(h.agents.get("explore")?.model).toEqual(m("openai/gpt-6-luna#low"));
  });

  it("rejects unknown names without switching", async () => {
    const h = harness();
    const reply = await runPresetCommand("gemini", h.deps);
    expect(reply).toBe("Unknown model preset 'gemini'. Valid presets: openai, anthropic");
    expect(h.stored.size).toBe(0);
    expect(h.reloads()).toBe(1);
  });

  it("reports usage for extra arguments", async () => {
    expect(await runPresetCommand("openai anthropic", harness().deps)).toMatch(/^Usage: \/preset \[name\]/);
  });

  it("notes when the preset is already active", async () => {
    expect(await runPresetCommand("openai", harness().deps)).toMatch(/already active/);
  });

  it("does not resolve prototype keys as preset names", async () => {
    expect(await runPresetCommand("constructor", harness().deps)).toMatch(/Unknown model preset/);
  });

  it("applies edits to the active preset on a plain /preset", async () => {
    const h = harness();
    await runPresetCommand("anthropic", h.deps);
    h.file.source = YAML.replace("anthropic/claude-haiku-4-5#low", "anthropic/claude-haiku-4-5#high");
    expect(await runPresetCommand("", h.deps)).toMatch(/explore\s+anthropic\/claude-haiku-4-5#high/);
    expect(h.agents.get("explore")?.model?.variant).toBe("high");
  });

  it("picks up file edits without a restart", async () => {
    const h = harness();
    h.file.source = YAML + "  local:\n    default: ollama/qwen3:32b\n";
    const list = await runPresetCommand("", h.deps);
    expect(list).toMatch(/ {2}local\s+others -> ollama\/qwen3:32b/);
    await runPresetCommand("local", h.deps);
    expect(h.agents.get("build")?.model).toEqual({ providerID: "ollama", id: "qwen3:32b" });
  });

  it("keeps the last good presets on a broken edit and reports the error with a line", async () => {
    const h = harness();
    await runPresetCommand("anthropic", h.deps);
    h.file.source = YAML.replace("anthropic/claude-haiku-4-5#low", '"@nope"');
    const reply = await runPresetCommand("", h.deps);
    expect(reply).toMatch(/^Preset file error: model-presets: \/cfg\/model-presets\.yaml:8:\d+: .*unknown tier '@nope'/);
    expect(reply).toMatch(/keeping the last good presets/);
    expect(reply).toMatch(/\* anthropic/);
    expect(h.agents.get("explore")?.model).toEqual(m("anthropic/claude-haiku-4-5#low"));
    expect(h.warnings.some((w) => w.includes("unknown tier '@nope'"))).toBe(true);

    h.file.source = YAML;
    expect(await runPresetCommand("", h.deps)).not.toMatch(/Preset file error/);
  });

  it("reports a startup error when no presets ever loaded", async () => {
    const h = harness("default: [");
    const reply = await runPresetCommand("anthropic", h.deps);
    expect(reply).toMatch(/^Preset file error: model-presets: \/cfg\/model-presets\.yaml:1:\d+: YAML error/);
    expect(reply).toMatch(/Fix \/cfg\/model-presets\.yaml and run \/preset again/);
    expect(h.stored.size).toBe(0);
    expect(h.agents.get("build")?.model).toEqual(m("openai/gpt-6.1-sol-1m#high"));
  });
});

describe("waitForPlugins", () => {
  it("resolves once every id is listed, and gives up on stop or timeout", async () => {
    const { waitForPlugins } = await import("./index");
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
