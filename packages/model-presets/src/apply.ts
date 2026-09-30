/**
 * Agent and default-model transforms for model-presets.
 *
 * The host rebuilds agent and model state from scratch on every reload and
 * replays all transforms in registration order (verified against the 2.0.20
 * server: each rebuild starts from `initial()`). The model an agent carries
 * when this transform runs is therefore always its config/frontmatter model,
 * so the transform is idempotent and switching to a preset that does not
 * override an agent restores its original model exactly. No state from
 * earlier passes is used to decide what to write.
 */

import { PREFIX, sameModel, type ModelRef, type ResolvedPreset } from "./options";

/** Structural subset of `@opencode/plugin` AgentEditor used here. */
export interface AgentLike {
  readonly id: string;
  model?: ModelRef | undefined;
}

export interface AgentEditorLike {
  list(): readonly AgentLike[];
  update(id: string, update: (agent: AgentLike) => void): void;
}

/** Structural subset of `@opencode/plugin` ModelEditor.default. */
export interface DefaultModelEditorLike {
  readonly default: {
    get(): { providerID: string; modelID: string } | undefined;
    set(providerID: string, modelID: string): void;
  };
}

export interface ApplyMemory {
  /** Unknown agent ids already warned about, keyed `preset:agent`. */
  warned: Set<string>;
}

export function createApplyMemory(): ApplyMemory {
  return { warned: new Set() };
}

function copyRef(ref: ModelRef | undefined): ModelRef | undefined {
  if (!ref) return undefined;
  return ref.variant !== undefined
    ? { providerID: String(ref.providerID), id: String(ref.id), variant: String(ref.variant) }
    : { providerID: String(ref.providerID), id: String(ref.id) };
}

/** The model the preset wants for `agentID`, or undefined when it leaves the agent alone. */
export function presetModelFor(preset: ResolvedPreset, agentID: string): ModelRef | undefined {
  return Object.hasOwn(preset.agents, agentID) ? preset.agents[agentID] : preset.defaultModel;
}

export interface ApplyResult {
  changed: string[];
  unknown: string[];
}

/**
 * Apply `preset` to every agent in the editor. Never throws for unknown agent
 * ids: they are reported, and warned once when `warn` is given (omit it while
 * the agent list is known to be incomplete).
 */
export function applyPresetToAgents(
  editor: AgentEditorLike,
  preset: ResolvedPreset,
  memory: ApplyMemory,
  warn?: (message: string) => void,
): ApplyResult {
  const agents = editor.list();
  const seen = new Set<string>();
  const changed: string[] = [];

  for (const agent of agents) {
    const id = String(agent.id);
    seen.add(id);
    const original = copyRef(agent.model);
    const wanted = presetModelFor(preset, id);

    if (wanted && !sameModel(original, wanted)) {
      editor.update(id, (draft) => {
        const next: { providerID: string; id: string; variant?: string } = { providerID: wanted.providerID, id: wanted.id };
        if (wanted.variant !== undefined) next.variant = wanted.variant;
        draft.model = next as ModelRef;
      });
      changed.push(id);
    }
  }

  const unknown = Object.keys(preset.agents).filter((id) => !seen.has(id));
  for (const id of unknown) {
    if (!warn) break;
    const key = `${preset.name}:${id}`;
    if (memory.warned.has(key)) continue;
    memory.warned.add(key);
    warn(`[${PREFIX}] preset '${preset.name}' names unknown agent '${id}'; skipped`);
  }
  return { changed, unknown };
}

/**
 * Apply the preset's global default model (root `model`). Presets without a
 * `model` leave the config default untouched. Returns true when it wrote.
 */
export function applyPresetDefaultModel(editor: DefaultModelEditorLike, preset: ResolvedPreset): boolean {
  if (!preset.model) return false;
  const raw = editor.default.get();
  const current = raw ? { providerID: String(raw.providerID), id: String(raw.modelID) } : undefined;
  if (sameModel(current, preset.model)) return false;
  editor.default.set(preset.model.providerID, preset.model.id);
  return true;
}
