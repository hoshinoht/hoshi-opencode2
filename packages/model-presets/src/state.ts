/**
 * Runtime state: last good presets and the file reload policy (keep the last
 * good presets on error). The preset in effect is chosen by the file's
 * top-level `active` key; there is no other selection state.
 */

import { createApplyMemory, type ApplyMemory } from "./apply";
import { loadPresetFile, type LoadResult } from "./file";
import { formatModel, PREFIX, type PresetOptions, type ResolvedPreset } from "./options";

export interface PresetState {
  readonly path: string;
  /** Last successfully validated presets; undefined until the file first loads. */
  options?: PresetOptions;
  /** Error from the most recent load, cleared on success. */
  lastError?: string;
  /** Last error that was logged; a repeat of it is not logged again until a load succeeds. */
  loggedError?: string;
  /** Fingerprint of the preset the agent transform last applied. */
  appliedAgents?: string;
  /** Global default model the model transform last applied ("" = none). */
  appliedModel?: string;
  memory: ApplyMemory;
  /** Notes (deprecations) already logged, so each is logged once. */
  noted: Set<string>;
  load: (path: string) => LoadResult;
  warn: (message: string) => void;
}

export function createPresetState(
  path: string,
  deps: { load?: (path: string) => LoadResult; warn?: (message: string) => void } = {},
): PresetState {
  return {
    path,
    memory: createApplyMemory(),
    noted: new Set(),
    load: deps.load ?? ((p) => loadPresetFile(p)),
    warn: deps.warn ?? ((m) => console.warn(m)),
  };
}

export type ReloadResult = { ok: true } | { ok: false; error: string };

/**
 * Re-read the preset file. On error, keep the last good presets, record the
 * error and log it (once per distinct error until the next good load).
 */
export function reloadPresets(state: PresetState): ReloadResult {
  const result = state.load(state.path);
  if (result.ok) {
    state.options = result.options;
    state.lastError = undefined;
    state.loggedError = undefined;
    const note = result.options.note;
    if (note && !state.noted.has(note)) {
      state.noted.add(note);
      state.warn(`[${PREFIX}] ${state.path}: ${note}`);
    }
    return { ok: true };
  }
  state.lastError = result.error + (state.options ? " (keeping the last good presets)" : "");
  if (state.loggedError !== state.lastError) {
    state.loggedError = state.lastError;
    state.warn(`[${PREFIX}] ${state.lastError}`);
  }
  return { ok: false, error: state.lastError };
}

/** Name of the preset in effect (the file's `active`), or undefined before the first good load. */
export function activeName(state: PresetState): string | undefined {
  return state.options?.active;
}

const NO_PRESET: ResolvedPreset = { name: "(none)", agents: {} };

/** The preset to apply; an empty preset (config models) when nothing has loaded. */
export function activePreset(state: PresetState): ResolvedPreset {
  const name = activeName(state);
  return (name && state.options?.presets[name]) || NO_PRESET;
}

/** Stable identity of what the agent transform writes for `preset`. */
export function agentFingerprint(preset: ResolvedPreset): string {
  const agents = Object.keys(preset.agents)
    .sort()
    .map((id) => `${id}=${formatModel(preset.agents[id])}`);
  return JSON.stringify([preset.name, preset.defaultModel ? formatModel(preset.defaultModel) : "", agents]);
}

/** Identity of the global default model `preset` sets ("" = leaves the config default). */
export function modelFingerprint(preset: ResolvedPreset): string {
  return preset.model ? formatModel(preset.model) : "";
}

export interface PendingReloads {
  /** The active preset's agent models differ from what the agent transform last applied. */
  agents: boolean;
  /** The active preset's global default model differs from what was last applied. */
  model: boolean;
}

/** What must be reloaded for the host to reflect the current active preset. */
export function pendingReloads(state: PresetState): PendingReloads {
  const preset = activePreset(state);
  return {
    agents: state.appliedAgents !== agentFingerprint(preset),
    model: (state.appliedModel ?? "") !== modelFingerprint(preset),
  };
}
