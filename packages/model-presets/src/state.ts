/**
 * Runtime state: last good presets, the stored preset name, and the file
 * reload policy (keep the last good presets on error).
 */

import { createApplyMemory, type ApplyMemory } from "./apply";
import { loadPresetFile, type LoadResult } from "./file";
import { PREFIX, type PresetOptions, type ResolvedPreset } from "./options";

export const STORAGE_KEY = "active";

export interface PresetState {
  readonly path: string;
  /** Last successfully validated presets; undefined until the file first loads. */
  options?: PresetOptions;
  /** Error from the most recent load, cleared on success. */
  lastError?: string;
  /** Preset name from storage (may be stale after a file edit). */
  stored?: string;
  memory: ApplyMemory;
  /** Warnings already logged, to avoid repeating them on every reload. */
  warned: Set<string>;
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
    warned: new Set(),
    load: deps.load ?? ((p) => loadPresetFile(p)),
    warn: deps.warn ?? ((m) => console.warn(m)),
  };
}

function warnOnce(state: PresetState, message: string): void {
  if (state.warned.has(message)) return;
  state.warned.add(message);
  state.warn(message);
}

/** Re-read the preset file. On error, keep the last good presets and record the error. */
export function reloadPresets(state: PresetState): void {
  const result = state.load(state.path);
  if (result.ok) {
    state.options = result.options;
    state.lastError = undefined;
    return;
  }
  state.lastError = result.error + (state.options ? " (keeping the last good presets)" : "");
  warnOnce(state, `[${PREFIX}] ${state.lastError}`);
}

/** Name of the preset in effect: the stored one if it still exists, else the file default. */
export function activeName(state: PresetState): string | undefined {
  const options = state.options;
  if (!options) return undefined;
  if (state.stored !== undefined) {
    if (Object.hasOwn(options.presets, state.stored)) return state.stored;
    warnOnce(state, `[${PREFIX}] stored preset '${state.stored}' no longer exists; using default '${options.default}'`);
  }
  return options.default;
}

const NO_PRESET: ResolvedPreset = { name: "(none)", agents: {} };

/** The preset to apply; an empty preset (config models) when nothing has loaded. */
export function activePreset(state: PresetState): ResolvedPreset {
  const name = activeName(state);
  return (name && state.options?.presets[name]) || NO_PRESET;
}

export interface StorageLike {
  get(key: string): Promise<unknown>;
}

/** Read the stored preset name; non-strings and storage failures count as unset. */
export async function loadStoredName(storage: StorageLike, warn: (message: string) => void): Promise<string | undefined> {
  try {
    const stored = await storage.get(STORAGE_KEY);
    if (stored === undefined || stored === null) return undefined;
    if (typeof stored === "string") return stored;
    warn(`[${PREFIX}] ignoring non-string stored preset ${JSON.stringify(stored)}`);
  } catch (error) {
    warn(`[${PREFIX}] storage read failed; using the file default: ${String(error)}`);
  }
  return undefined;
}
