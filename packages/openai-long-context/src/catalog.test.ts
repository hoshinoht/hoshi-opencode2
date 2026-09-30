import { describe, expect, it } from "bun:test";
import {
  applyLongContextModels,
  validateOptions,
  type ModelEditorLike,
  type CatalogEditorLike,
  type ModelInfoLike,
} from "./policy";

function makeEditor(
  models: ModelInfoLike[],
  providerID = "openai",
): { editor: ModelEditorLike; store: Map<string, Record<string, unknown>> } {
  const base = new Map<string, ModelInfoLike>(models.map((m) => [m.id, m]));
  const store = new Map<string, Record<string, unknown>>();
  const editor: ModelEditorLike = {
    provider: {
      get: (id: string) =>
        id === providerID ? { provider: { id }, models: base } : undefined,
    },
    update: (
      pid: string,
      mid: string,
      update: (model: Record<string, unknown>) => void,
    ) => {
      if (pid !== providerID) throw new Error(`unexpected provider ${pid}`);
      const draft: Record<string, unknown> = {};
      update(draft);
      store.set(mid, draft);
    },
  };
  return { editor, store };
}

function makeLegacyEditor(
  models: ModelInfoLike[],
  providerID = "openai",
): { editor: CatalogEditorLike; store: Map<string, Record<string, unknown>> } {
  const base = new Map<string, ModelInfoLike>(models.map((m) => [m.id, m]));
  const store = new Map<string, Record<string, unknown>>();
  const editor: CatalogEditorLike = {
    provider: {
      get: (id: string) =>
        id === providerID ? { provider: { id }, models: base } : undefined,
    },
    model: {
      update: (
        pid: string,
        mid: string,
        update: (model: Record<string, unknown>) => void,
      ) => {
        if (pid !== providerID) throw new Error(`unexpected provider ${pid}`);
        const draft: Record<string, unknown> = {};
        update(draft);
        store.set(mid, draft);
      },
    },
  };
  return { editor, store };
}

const BASE = (id: string, name: string): ModelInfoLike => ({
  id,
  modelID: id,
  providerID: "openai",
  name,
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 1 } }],
  status: "active",
  enabled: true,
  limit: { context: 400_000, input: 400_000, output: 32_000 },
});

describe("model transform", () => {
  it("clones eligible models with 1M limits and inherited fields", () => {
    const { editor, store } = makeEditor([
      BASE("gpt-5.6-terra", "Terra"),
      BASE("gpt-6-astra", "Astra"),
      BASE("gpt-4o", "4o"),
    ]);
    const created = applyLongContextModels(editor, validateOptions(undefined));

    expect(created).toEqual(["gpt-5.6-terra-1m", "gpt-6-astra-1m"]);
    expect(store.get("gpt-6-astra-1m")).toMatchObject({
      id: "gpt-6-astra-1m",
      modelID: "gpt-6-astra",
      name: "Astra (1M context)",
      limit: { context: 1_000_000, input: 872_000, output: 128_000 },
    });
    const variant = store.get("gpt-5.6-terra-1m");
    expect(variant).toMatchObject({
      id: "gpt-5.6-terra-1m",
      // Upstream alias: wire ID stays the base model (mirrors V1 `api.id`).
      modelID: "gpt-5.6-terra",
      providerID: "openai",
      name: "Terra (1M context)",
      limit: { context: 1_000_000, input: 872_000, output: 128_000 },
      status: "active",
      enabled: true,
    });
    expect(variant?.capabilities).toEqual({
      tools: true,
      input: ["text"],
      output: ["text"],
    });
    // Base limit object is not reused by reference.
    expect(variant?.limit).not.toBe(BASE("x", "y").limit);
  });

  it("clones dotted gpt-6.1 releases", () => {
    const { editor, store } = makeEditor([
      BASE("gpt-6.1-sol", "Sol 6.1"),
      BASE("gpt-6.1-sol-1m", "Sol 6.1 1M"),
    ]);
    const created = applyLongContextModels(editor, validateOptions(undefined));

    expect(created).toEqual(["gpt-6.1-sol-1m"]);
    expect(store.get("gpt-6.1-sol-1m")).toMatchObject({
      id: "gpt-6.1-sol-1m",
      modelID: "gpt-6.1-sol",
      name: "Sol 6.1 (1M context)",
      limit: { context: 1_000_000, input: 872_000, output: 128_000 },
    });
  });

  it("skips existing -1m models and ineligible prefixes", () => {
    const { editor, store } = makeEditor([
      BASE("gpt-5.6-terra-1m", "Terra 1M"),
      BASE("gpt-5.5-turbo", "Turbo"),
    ]);
    expect(applyLongContextModels(editor, validateOptions(undefined))).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("follows an existing upstream alias instead of the catalog ID", () => {
    const { editor, store } = makeEditor([
      { ...BASE("gpt-6-luna-fast", "Luna Fast"), modelID: "gpt-6-luna" },
    ]);
    const created = applyLongContextModels(editor, validateOptions(undefined));
    expect(created).toEqual(["gpt-6-luna-fast-1m"]);
    expect(store.get("gpt-6-luna-fast-1m")).toMatchObject({
      id: "gpt-6-luna-fast-1m",
      modelID: "gpt-6-luna",
    });
  });

  it("falls back to the ID when the base name is missing", () => {
    const { editor, store } = makeEditor([{ id: "gpt-6-sol" }]);
    applyLongContextModels(editor, validateOptions(undefined));
    expect(store.get("gpt-6-sol-1m")?.name).toBe("gpt-6-sol (1M context)");
  });

  it("registers nothing when disabled or the provider is absent", () => {
    const { editor } = makeEditor([BASE("gpt-5.6-terra", "Terra")]);
    expect(
      applyLongContextModels(editor, validateOptions({ enabled: false })),
    ).toEqual([]);

    const missing: ModelEditorLike = {
      provider: { get: () => undefined },
      update: () => {
        throw new Error("must not update without a provider");
      },
    };
    expect(applyLongContextModels(missing, validateOptions(undefined))).toEqual([]);
  });

  it("supports the legacy catalog editor shape", () => {
    const { editor, store } = makeLegacyEditor([
      BASE("gpt-5.6-terra", "Terra"),
    ]);
    expect(applyLongContextModels(editor, validateOptions(undefined))).toEqual([
      "gpt-5.6-terra-1m",
    ]);
    expect(store.get("gpt-5.6-terra-1m")).toMatchObject({
      id: "gpt-5.6-terra-1m",
      modelID: "gpt-5.6-terra",
    });
  });

  it("is idempotent across replays", () => {
    const first = makeEditor([BASE("gpt-5.6-terra", "Terra")]);
    const second = makeEditor([
      BASE("gpt-5.6-terra", "Terra"),
      BASE("gpt-5.6-terra-1m", "Terra (1M context)"),
    ]);
    const options = validateOptions(undefined);
    expect(applyLongContextModels(first.editor, options)).toEqual([
      "gpt-5.6-terra-1m",
    ]);
    // Replay sees the already-registered variant and still derives one update.
    expect(applyLongContextModels(second.editor, options)).toEqual([
      "gpt-5.6-terra-1m",
    ]);
  });
});
