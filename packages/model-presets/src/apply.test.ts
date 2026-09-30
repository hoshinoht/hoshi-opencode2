import { describe, expect, it } from "bun:test";
import {
  applyPresetDefaultModel,
  applyPresetToAgents,
  createApplyMemory,
  type AgentEditorLike,
  type AgentLike,
  type DefaultModelEditorLike,
} from "./apply";
import { parseModelString as m, validatePresets, type ModelRef } from "./options";

const CONFIG: Record<string, ModelRef | undefined> = {
  build: m("openai/gpt-6.1-sol-1m#high"),
  explore: m("openai/gpt-6-luna#low"),
  "code-writer": m("openai/gpt-6-luna-1m#max"),
  general: m("openai/gpt-5.6-terra-1m#high"),
  title: m("openai/gpt-6-luna#low"),
  bare: undefined,
};

/**
 * Fake agent state that behaves like the host: every reload rebuilds agents
 * from config and replays the transform.
 */
function makeHost(config = CONFIG) {
  let agents = new Map<string, AgentLike>();
  let updates = 0;
  const editor: AgentEditorLike = {
    list: () => [...agents.values()].map((a) => ({ ...a, model: a.model ? { ...a.model } : undefined })),
    update: (id, fn) => {
      const agent = agents.get(id);
      if (!agent) return;
      updates++;
      fn(agent);
    },
  };
  const rebuild = () => {
    agents = new Map(
      Object.entries(config).map(([id, model]) => [id, model ? { id, model: { ...model } } : { id }]),
    );
  };
  rebuild();
  return {
    editor,
    rebuild,
    model: (id: string) => agents.get(id)?.model,
    get updates() {
      return updates;
    },
  };
}

const OPTIONS = validatePresets({
  default: "openai",
  presets: {
    openai: {},
    anthropic: {
      tiers: { heavy: "anthropic/claude-opus-5-5#high", fast: "anthropic/claude-haiku-4-5#low" },
      default: "@heavy",
      agents: { explore: "@fast", "code-writer": "anthropic/claude-opus-5-5#medium", ghost: "@fast" },
    },
    partial: { agents: { explore: "ollama/qwen3:32b", title: "openai/gpt-6-luna#low" } },
  },
});
const P = OPTIONS.presets;

describe("applyPresetToAgents", () => {
  it("leaves config models untouched for an empty preset", () => {
    const host = makeHost();
    const memory = createApplyMemory();
    const result = applyPresetToAgents(host.editor, P.openai!, memory);
    expect(result.changed).toEqual([]);
    expect(host.updates).toBe(0);
    expect(host.model("build")).toEqual(CONFIG.build);
    expect(memory.effective.get("build")).toEqual({ model: CONFIG.build, overridden: false });
    expect(memory.effective.get("bare")).toEqual({ model: undefined, overridden: false });
  });

  it("applies explicit agents, tiers and the preset default (built-in roles included)", () => {
    const host = makeHost();
    applyPresetToAgents(host.editor, P.anthropic!, createApplyMemory());
    expect(host.model("explore")).toEqual({ providerID: "anthropic", id: "claude-haiku-4-5", variant: "low" });
    expect(host.model("code-writer")).toEqual({ providerID: "anthropic", id: "claude-opus-5-5", variant: "medium" });
    for (const id of ["build", "general", "title", "bare"]) {
      expect(host.model(id)).toEqual({ providerID: "anthropic", id: "claude-opus-5-5", variant: "high" });
    }
  });

  it("leaves unlisted agents alone when the preset has no default", () => {
    const host = makeHost();
    applyPresetToAgents(host.editor, P.partial!, createApplyMemory());
    expect(host.model("explore")).toEqual({ providerID: "ollama", id: "qwen3:32b" });
    expect(host.model("build")).toEqual(CONFIG.build);
  });

  it("drops a stale variant when the preset model has none", () => {
    const host = makeHost();
    applyPresetToAgents(host.editor, P.partial!, createApplyMemory());
    expect(host.model("explore")).not.toHaveProperty("variant");
  });

  it("does not write when the preset model equals the config model", () => {
    const host = makeHost();
    const result = applyPresetToAgents(host.editor, P.partial!, createApplyMemory());
    expect(result.changed).toEqual(["explore"]);
    expect(host.model("title")).toEqual(CONFIG.title);
  });

  it("is idempotent across repeated passes", () => {
    const host = makeHost();
    const memory = createApplyMemory();
    applyPresetToAgents(host.editor, P.anthropic!, memory);
    const after = host.updates;
    expect(applyPresetToAgents(host.editor, P.anthropic!, memory).changed).toEqual([]);
    expect(host.updates).toBe(after);
  });

  it("restores the config models exactly when switching back (anthropic -> partial -> openai)", () => {
    const host = makeHost();
    const memory = createApplyMemory();
    for (const preset of [P.anthropic!, P.partial!, P.openai!]) {
      host.rebuild();
      applyPresetToAgents(host.editor, preset, memory);
    }
    for (const [id, model] of Object.entries(CONFIG)) expect(host.model(id)).toEqual(model);
    expect(host.model("bare")).toBeUndefined();
  });

  it("keeps an override equal to the config model after a rebuild (regression)", () => {
    // `partial.title` equals the config model; a rebuild must not lose it.
    const host = makeHost();
    const memory = createApplyMemory();
    applyPresetToAgents(host.editor, P.partial!, memory);
    host.rebuild();
    applyPresetToAgents(host.editor, P.openai!, memory);
    expect(host.model("title")).toEqual(CONFIG.title);
  });

  it("skips unknown agent ids and warns once per preset", () => {
    const host = makeHost();
    const memory = createApplyMemory();
    const warnings: string[] = [];
    const first = applyPresetToAgents(host.editor, P.anthropic!, memory, (w) => warnings.push(w));
    applyPresetToAgents(host.editor, P.anthropic!, memory, (w) => warnings.push(w));
    expect(first.unknown).toEqual(["ghost"]);
    expect(warnings).toEqual(["[model-presets] preset 'anthropic' names unknown agent 'ghost'; skipped"]);
    expect(memory.effective.has("ghost")).toBe(false);
  });

  it("does not warn (or remember) unknown agents when no warn callback is given", () => {
    const host = makeHost();
    const memory = createApplyMemory();
    expect(applyPresetToAgents(host.editor, P.anthropic!, memory).unknown).toEqual(["ghost"]);
    const warnings: string[] = [];
    applyPresetToAgents(host.editor, P.anthropic!, memory, (w) => warnings.push(w));
    expect(warnings).toHaveLength(1);
  });
});

describe("applyPresetDefaultModel", () => {
  function makeModelHost(initial?: { providerID: string; modelID: string }) {
    let current = initial;
    const editor: DefaultModelEditorLike = {
      default: {
        get: () => (current ? { ...current } : undefined),
        set: (providerID, modelID) => {
          current = { providerID, modelID };
        },
      },
    };
    return { editor, current: () => current, rebuild: () => (current = initial) };
  }
  const opts = validatePresets({ default: "a", presets: { a: {}, b: { model: "anthropic/claude-opus-5-5" } } });

  it("sets the global default model and leaves it alone for presets without one", () => {
    const host = makeModelHost({ providerID: "openai", modelID: "gpt-5.6-terra-1m" });
    expect(applyPresetDefaultModel(host.editor, opts.presets.a!)).toBe(false);
    expect(applyPresetDefaultModel(host.editor, opts.presets.b!)).toBe(true);
    expect(host.current()).toEqual({ providerID: "anthropic", modelID: "claude-opus-5-5" });
    expect(applyPresetDefaultModel(host.editor, opts.presets.b!)).toBe(false);
    host.rebuild();
    expect(applyPresetDefaultModel(host.editor, opts.presets.a!)).toBe(false);
    expect(host.current()).toEqual({ providerID: "openai", modelID: "gpt-5.6-terra-1m" });
  });
});
