/**
 * Plugin options and preset-file validation for model-presets.
 *
 * Plugin options (opencode.json entry) only locate the preset file:
 *
 *   { "package": "./packages/model-presets", "options": { "file": "model-presets.yaml" } }
 *
 * Preset file shape (YAML, comments allowed):
 *
 *   active: openai            # the preset in effect (`default:` is a deprecated alias)
 *   presets:
 *     openai: {}
 *     anthropic:
 *       tiers: { heavy: anthropic/claude-opus-5-5#high }
 *       default: "@heavy"
 *       model: anthropic/claude-opus-5-5
 *       agents: { explore: anthropic/claude-haiku-4-5#low }
 *
 * Model strings are `provider/model` with an optional `#variant`; `@name`
 * refers to the preset's `tiers`. Validation errors carry the key path so
 * the file loader can point at the offending line.
 */

export const PREFIX = "model-presets";
export const DEFAULT_FILE = "model-presets.yaml";

/** Provider-agnostic model reference, matching `Agent.Info["model"]`. */
export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
  readonly variant?: string;
}

export interface ResolvedPreset {
  readonly name: string;
  /** Applied to agents not listed in `agents`; undefined = leave them unchanged. */
  readonly defaultModel?: ModelRef;
  /** Explicit per-agent models. */
  readonly agents: Readonly<Record<string, ModelRef>>;
  /** Global default model (root `model` in opencode.json); never carries a variant. */
  readonly model?: ModelRef;
}

export interface PresetOptions {
  /** Name of the preset in effect (top-level `active`, or the deprecated `default`). */
  readonly active: string;
  readonly presets: Readonly<Record<string, ResolvedPreset>>;
  /** Deprecation note about the top-level `default` alias, when it was present. */
  readonly note?: string;
}

export interface PluginOptions {
  /** Preset file; relative paths resolve against the config root. */
  readonly file: string;
}

/** Validation error with the key path of the offending value. */
export class PresetError extends Error {
  constructor(
    message: string,
    readonly path: readonly (string | number)[] = [],
  ) {
    super(`${PREFIX}: ${message}`);
    this.name = "PresetError";
  }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VARIANT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOP_KEYS = new Set(["active", "default", "presets"]);
const PRESET_KEYS = new Set(["tiers", "default", "agents", "model"]);
const PLUGIN_KEYS = new Set(["file"]);

type Path = readonly (string | number)[];

function fail(message: string, path: Path = []): never {
  throw new PresetError(message, path);
}

function label(path: Path, fallback = "model"): string {
  return path.length ? path.join(".") : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse `provider/model[#variant]`. The model part may itself contain `/`
 * (e.g. `openrouter/anthropic/claude-x`); only the first `/` splits.
 */
export function parseModelString(input: unknown, path: Path = []): ModelRef {
  const where = label(path);
  if (typeof input !== "string") fail(`${where} must be a string`, path);
  const raw = input.trim();
  if (raw !== input || raw.length === 0 || /\s/.test(raw)) {
    fail(`${where} '${input}' is malformed (expected provider/model[#variant], no whitespace)`, path);
  }
  const hash = raw.indexOf("#");
  const base = hash === -1 ? raw : raw.slice(0, hash);
  const variant = hash === -1 ? undefined : raw.slice(hash + 1);
  const slash = base.indexOf("/");
  if (slash <= 0 || slash === base.length - 1) {
    fail(`${where} '${input}' is malformed (expected provider/model[#variant])`, path);
  }
  const providerID = base.slice(0, slash);
  const id = base.slice(slash + 1);
  if (!PROVIDER_RE.test(providerID)) fail(`${where} '${input}' has an invalid provider '${providerID}'`, path);
  if (id.startsWith("/") || id.endsWith("/") || id.includes("//")) {
    fail(`${where} '${input}' has an invalid model id '${id}'`, path);
  }
  if (variant !== undefined && !VARIANT_RE.test(variant)) {
    fail(`${where} '${input}' has an invalid variant '${variant}'`, path);
  }
  return variant === undefined ? { providerID, id } : { providerID, id, variant };
}

export function formatModel(ref: ModelRef | undefined): string {
  if (!ref) return "(unset)";
  return `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`;
}

export function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  if (!a || !b) return a === b;
  return a.providerID === b.providerID && a.id === b.id && (a.variant ?? undefined) === (b.variant ?? undefined);
}

/** Resolve a model string or `@tier` reference against the preset's tiers. */
export function resolveModelRef(value: unknown, tiers: Readonly<Record<string, ModelRef>>, path: Path = []): ModelRef {
  const where = label(path);
  if (typeof value !== "string") fail(`${where} must be a string`, path);
  if (value.startsWith("@")) {
    const tier = value.slice(1);
    const hit = Object.hasOwn(tiers, tier) ? tiers[tier] : undefined;
    if (!hit) {
      const known = Object.keys(tiers);
      fail(
        `${where} references unknown tier '@${tier}'` +
          (known.length ? ` (known tiers: ${known.map((t) => `@${t}`).join(", ")})` : " (preset defines no tiers)"),
        path,
      );
    }
    return hit;
  }
  return parseModelString(value, path);
}

function resolvePreset(name: string, raw: unknown): ResolvedPreset {
  const base = ["presets", name];
  const where = base.join(".");
  // `name: {}` and a bare `name:` (YAML null) both mean "no overrides".
  if (raw === null || raw === undefined) return { name, agents: {} };
  if (!isRecord(raw)) fail(`${where} must be a mapping`, base);
  for (const key of Object.keys(raw)) {
    if (!PRESET_KEYS.has(key)) {
      fail(`${where}: unknown key '${key}' (expected ${[...PRESET_KEYS].join(", ")})`, [...base, key]);
    }
  }

  const tiers: Record<string, ModelRef> = {};
  if (raw.tiers !== undefined && raw.tiers !== null) {
    if (!isRecord(raw.tiers)) fail(`${where}.tiers must be a mapping`, [...base, "tiers"]);
    for (const [tier, value] of Object.entries(raw.tiers)) {
      const path = [...base, "tiers", tier];
      if (!NAME_RE.test(tier)) fail(`${where}.tiers: invalid tier name '${tier}'`, path);
      if (typeof value === "string" && value.startsWith("@")) {
        fail(`${path.join(".")} must be a model string, not a tier reference`, path);
      }
      tiers[tier] = parseModelString(value, path);
    }
  }

  const defaultModel =
    raw.default === undefined || raw.default === null
      ? undefined
      : resolveModelRef(raw.default, tiers, [...base, "default"]);

  let model: ModelRef | undefined;
  if (raw.model !== undefined && raw.model !== null) {
    model = resolveModelRef(raw.model, tiers, [...base, "model"]);
    if (model.variant !== undefined) {
      fail(
        `${where}.model '${formatModel(model)}' must not carry a #variant (the global default model has none)`,
        [...base, "model"],
      );
    }
  }

  const agents: Record<string, ModelRef> = {};
  if (raw.agents !== undefined && raw.agents !== null) {
    if (!isRecord(raw.agents)) fail(`${where}.agents must be a mapping`, [...base, "agents"]);
    for (const [agent, value] of Object.entries(raw.agents)) {
      agents[agent] = resolveModelRef(value, tiers, [...base, "agents", agent]);
    }
  }

  return { name, agents, ...(defaultModel ? { defaultModel } : {}), ...(model ? { model } : {}) };
}

/** Validate the parsed preset file content. */
export function validatePresets(raw: unknown): PresetOptions {
  if (!isRecord(raw)) fail("preset file must be a mapping with 'active' and 'presets'");
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) fail(`unknown top-level key '${key}' (expected active, presets)`, [key]);
  }
  if (!isRecord(raw.presets)) fail("'presets' must be a mapping of preset name -> preset", ["presets"]);
  const names = Object.keys(raw.presets);
  if (names.length === 0) fail("'presets' must define at least one preset", ["presets"]);

  const presets: Record<string, ResolvedPreset> = {};
  for (const name of names) {
    if (!NAME_RE.test(name)) {
      fail(`invalid preset name '${name}' (letters, digits, '.', '_', '-'; must start alphanumeric)`, [
        "presets",
        name,
      ]);
    }
    presets[name] = resolvePreset(name, raw.presets[name]);
  }

  // `active` selects the preset; the top-level `default` is its deprecated
  // alias and is ignored (not validated) when `active` is also present.
  const hasActive = raw.active !== undefined && raw.active !== null;
  const hasDefault = raw.default !== undefined && raw.default !== null;
  const key = hasActive || !hasDefault ? "active" : "default";
  const selected = raw[key];
  if (typeof selected !== "string") fail(`'${key}' must name a preset (known: ${names.join(", ")})`, [key]);
  if (!Object.hasOwn(presets, selected)) {
    fail(`${key} '${selected}' is not a preset (known: ${names.join(", ")})`, [key]);
  }
  const note = !hasDefault
    ? undefined
    : hasActive
      ? `both 'active' and the deprecated top-level 'default' are set; using active '${selected}' (remove 'default')`
      : `top-level 'default' is deprecated; rename it to 'active'`;
  return { active: selected, presets, ...(note ? { note } : {}) };
}

/** Validate the opencode.json plugin options. Fails fast. */
export function validatePluginOptions(raw: unknown): PluginOptions {
  if (raw === undefined || raw === null) return { file: DEFAULT_FILE };
  if (!isRecord(raw)) fail("options must be an object");
  for (const key of Object.keys(raw)) {
    if (!PLUGIN_KEYS.has(key)) {
      fail(
        `unknown option '${key}' (expected ${[...PLUGIN_KEYS].join(", ")}; presets live in the preset file)`,
      );
    }
  }
  const file = raw.file ?? DEFAULT_FILE;
  if (typeof file !== "string" || file.trim().length === 0) fail("options.file must be a non-empty string");
  return { file };
}
