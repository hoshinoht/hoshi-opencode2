import { describe, expect, it } from "bun:test";
import {
  DEFAULT_FILE,
  formatModel,
  parseModelString,
  PresetError,
  resolveModelRef,
  validatePluginOptions,
  validatePresets,
} from "./options";

describe("parseModelString", () => {
  it("parses provider/model and an optional variant", () => {
    expect(parseModelString("openai/gpt-6-luna")).toEqual({ providerID: "openai", id: "gpt-6-luna" });
    expect(parseModelString("anthropic/claude-opus-5-5#high")).toEqual({
      providerID: "anthropic",
      id: "claude-opus-5-5",
      variant: "high",
    });
  });

  it("splits only on the first slash (openrouter-style ids)", () => {
    expect(parseModelString("openrouter/anthropic/claude-x#low")).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude-x",
      variant: "low",
    });
    expect(parseModelString("opencode/muse-spark-1.3-contributor-free#high").id).toBe(
      "muse-spark-1.3-contributor-free",
    );
    expect(parseModelString("ollama/qwen3:32b").id).toBe("qwen3:32b");
  });

  it("rejects malformed strings with a clear message", () => {
    for (const bad of ["gpt-6", "/gpt", "openai/", "openai/gpt#", "openai/gpt#a#b", " openai/x", "open ai/x", "", "openai//x"]) {
      expect(() => parseModelString(bad, ["presets", "x", "agents", "y"])).toThrow(/model-presets: presets\.x\.agents\.y/);
    }
  });

  it("round-trips through formatModel", () => {
    expect(formatModel(parseModelString("anthropic/claude-haiku-4-5#low"))).toBe("anthropic/claude-haiku-4-5#low");
    expect(formatModel(undefined)).toBe("(unset)");
  });
});

describe("tier resolution", () => {
  const tiers = { heavy: parseModelString("anthropic/claude-opus-5-5#high") };

  it("resolves @tier references", () => {
    expect(resolveModelRef("@heavy", tiers)).toEqual({
      providerID: "anthropic",
      id: "claude-opus-5-5",
      variant: "high",
    });
  });

  it("fails on unknown tiers and lists the known ones", () => {
    expect(() => resolveModelRef("@fast", tiers, ["presets", "a", "default"])).toThrow(
      "model-presets: presets.a.default references unknown tier '@fast' (known tiers: @heavy)",
    );
    expect(() => resolveModelRef("@fast", {})).toThrow(/preset defines no tiers/);
  });

  it("does not resolve prototype keys as tiers", () => {
    expect(() => resolveModelRef("@toString", {})).toThrow(/unknown tier/);
  });
});

describe("validatePresets", () => {
  const good = {
    default: "openai",
    presets: {
      openai: {},
      anthropic: {
        tiers: { heavy: "anthropic/claude-opus-5-5#high", fast: "anthropic/claude-haiku-4-5#low" },
        default: "@heavy",
        model: "anthropic/claude-opus-5-5",
        agents: { explore: "@fast", "code-writer": "anthropic/claude-opus-5-5#medium" },
      },
    },
  };

  it("resolves a full config", () => {
    const options = validatePresets(good);
    expect(options.default).toBe("openai");
    expect(options.presets.openai).toEqual({ name: "openai", agents: {} });
    const anthropic = options.presets.anthropic!;
    expect(anthropic.defaultModel).toEqual({ providerID: "anthropic", id: "claude-opus-5-5", variant: "high" });
    expect(anthropic.model).toEqual({ providerID: "anthropic", id: "claude-opus-5-5" });
    expect(anthropic.agents.explore).toEqual({ providerID: "anthropic", id: "claude-haiku-4-5", variant: "low" });
    expect(anthropic.agents["code-writer"]?.variant).toBe("medium");
  });

  it("requires a mapping and at least one preset", () => {
    expect(() => validatePresets(undefined)).toThrow(/must be a mapping/);
    expect(() => validatePresets([])).toThrow(/must be a mapping/);
    expect(() => validatePresets({ default: "a", presets: {} })).toThrow(/at least one preset/);
    expect(() => validatePresets({ default: "a" })).toThrow(/'presets' must be a mapping/);
  });

  it("accepts a bare (null) preset as no overrides", () => {
    expect(validatePresets({ default: "a", presets: { a: null } }).presets.a).toEqual({ name: "a", agents: {} });
  });

  it("carries the key path of the offending value", () => {
    try {
      validatePresets({ default: "a", presets: { a: { agents: { explore: "bad" } } } });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PresetError);
      expect((error as PresetError).path).toEqual(["presets", "a", "agents", "explore"]);
    }
  });

  it("rejects an unknown default preset", () => {
    expect(() => validatePresets({ default: "nope", presets: { a: {} } })).toThrow(
      "model-presets: default 'nope' is not a preset (known: a)",
    );
    expect(() => validatePresets({ presets: { a: {} } })).toThrow(/'default' must name a preset/);
  });

  it("rejects unknown keys at both levels", () => {
    expect(() => validatePresets({ default: "a", presets: { a: {} }, extra: 1 })).toThrow(/unknown top-level key 'extra'/);
    expect(() => validatePresets({ default: "a", presets: { a: { agent: {} } } })).toThrow(
      /presets\.a: unknown key 'agent'/,
    );
  });

  it("rejects malformed model strings and unknown tiers inside presets", () => {
    expect(() => validatePresets({ default: "a", presets: { a: { agents: { explore: "haiku" } } } })).toThrow(
      /presets\.a\.agents\.explore 'haiku' is malformed/,
    );
    expect(() => validatePresets({ default: "a", presets: { a: { default: "@x" } } })).toThrow(
      /presets\.a\.default references unknown tier '@x'/,
    );
    expect(() => validatePresets({ default: "a", presets: { a: { tiers: { t: "@u" } } } })).toThrow(
      /must be a model string, not a tier reference/,
    );
    expect(() => validatePresets({ default: "a", presets: { a: { agents: { explore: 3 } } } })).toThrow(
      /must be a string/,
    );
  });

  it("rejects a variant on the global default model", () => {
    expect(() => validatePresets({ default: "a", presets: { a: { model: "openai/gpt-6#high" } } })).toThrow(
      /presets\.a\.model .* must not carry a #variant/,
    );
  });

  it("rejects invalid preset names", () => {
    expect(() => validatePresets({ default: "a b", presets: { "a b": {} } })).toThrow(/invalid preset name/);
  });
});

describe("validatePluginOptions", () => {
  it("defaults the preset file", () => {
    expect(validatePluginOptions(undefined)).toEqual({ file: DEFAULT_FILE });
    expect(validatePluginOptions({})).toEqual({ file: DEFAULT_FILE });
    expect(validatePluginOptions({ file: "x/presets.yaml" })).toEqual({ file: "x/presets.yaml" });
  });

  it("fails fast on bad options, including inline presets", () => {
    expect(() => validatePluginOptions({ file: "" })).toThrow(/options.file must be a non-empty string/);
    expect(() => validatePluginOptions({ presets: {} })).toThrow(/unknown option 'presets'.*preset file/);
    expect(() => validatePluginOptions("x")).toThrow(/options must be an object/);
  });
});
