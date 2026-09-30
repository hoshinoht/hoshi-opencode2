/**
 * `/preset` command handling, kept free of host APIs so it is unit-testable.
 */

import type { ApplyMemory } from "./apply";
import { formatModel, type PresetOptions, type ResolvedPreset } from "./options";
import { activeName, reloadPresets, type PresetState } from "./state";

export const COMMAND_NAME = "preset";

export interface CommandDeps {
  readonly state: PresetState;
  /** Persist and activate `name`, then reload agents (which re-applies the preset). */
  activate(name: string): Promise<void>;
  /** Reload agents so file edits to the active preset take effect (listing only). */
  refresh?(): Promise<void>;
}

/** Extract the preset argument from the command prompt text. */
export function parsePresetArgs(text: string | undefined): { name?: string; error?: string } {
  const tokens = (text ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens[0] === `/${COMMAND_NAME}`) tokens.shift();
  if (tokens.length === 0) return {};
  if (tokens.length > 1) return { error: `expected at most one preset name, got: ${tokens.join(" ")}` };
  return { name: tokens[0] };
}

function describePreset(preset: ResolvedPreset): string {
  const listed = Object.keys(preset.agents).length;
  if (listed === 0 && !preset.defaultModel && !preset.model) return "config models (no overrides)";
  const parts: string[] = [];
  if (listed) parts.push(`${listed} agent override${listed === 1 ? "" : "s"}`);
  if (preset.defaultModel) parts.push(`others -> ${formatModel(preset.defaultModel)}`);
  if (preset.model) parts.push(`global default ${formatModel(preset.model)}`);
  return parts.join(", ");
}

export function formatPresetList(options: PresetOptions, active: string | undefined): string {
  const names = Object.keys(options.presets);
  const width = Math.max(...names.map((n) => n.length));
  return names
    .map((name) => `${name === active ? "*" : " "} ${name.padEnd(width)}  ${describePreset(options.presets[name]!)}`)
    .join("\n");
}

export function formatEffectiveTable(memory: ApplyMemory): string {
  const rows = [...memory.effective.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0) return "(agent list not loaded yet)";
  const width = Math.max(5, ...rows.map(([id]) => id.length));
  const lines = [`${"agent".padEnd(width)}  model`];
  for (const [id, { model, overridden }] of rows) {
    lines.push(`${id.padEnd(width)}  ${formatModel(model)}${overridden ? "  (preset)" : ""}`);
  }
  return lines.join("\n");
}

function statusText(state: PresetState, options: PresetOptions): string {
  const active = activeName(state);
  return [
    `Model presets from ${state.path} (* = active):`,
    "```",
    formatPresetList(options, active),
    "```",
    `Effective agent models for '${active}':`,
    "```",
    formatEffectiveTable(state.memory),
    "```",
  ].join("\n");
}

/** Run `/preset [name]` and return the reply text. Re-reads the preset file first. */
export async function runPresetCommand(text: string | undefined, deps: CommandDeps): Promise<string> {
  const { state } = deps;
  reloadPresets(state);
  const errorNote = state.lastError ? `Preset file error: ${state.lastError}` : undefined;
  const options = state.options;
  if (!options) {
    return [errorNote ?? `No presets loaded from ${state.path}.`, `Fix ${state.path} and run /${COMMAND_NAME} again.`].join(
      "\n",
    );
  }
  const withNote = (body: string) => (errorNote ? `${errorNote}\n\n${body}` : body);

  const names = Object.keys(options.presets);
  const args = parsePresetArgs(text);
  if (args.error) return withNote(`Usage: /${COMMAND_NAME} [name] (${args.error}). Presets: ${names.join(", ")}`);
  if (!args.name) {
    if (deps.refresh) await deps.refresh();
    return withNote(statusText(state, state.options ?? options));
  }

  if (!Object.hasOwn(options.presets, args.name)) {
    return withNote(`Unknown model preset '${args.name}'. Valid presets: ${names.join(", ")}`);
  }
  const previous = activeName(state);
  await deps.activate(args.name);
  const head =
    previous === args.name
      ? `Model preset '${args.name}' is already active (re-applied).`
      : `Switched model preset: ${previous} -> ${args.name}.`;
  return withNote(
    [
      head,
      "Sessions with an explicit per-session model keep it; everything else uses the new agent models from the next turn.",
      "",
      statusText(state, state.options ?? options),
    ].join("\n"),
  );
}
