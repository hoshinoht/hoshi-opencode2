/**
 * model-presets — V2-only OpenCode plugin.
 *
 * Switches every agent's model (including the built-in general, compaction,
 * summary and title roles) between named, provider-agnostic presets. Presets
 * live in a YAML file (default `model-presets.yaml` in the config root) whose
 * top-level `active` key selects the preset in effect; `default` is accepted
 * as a deprecated alias.
 *
 * The file is re-read on every agent reload and watched: a valid edit reloads
 * agents (and the global default model when the preset's `model` changes)
 * without a restart; a broken edit keeps the last good presets and logs the
 * error with its file:line:col. Log lines also go to a log file (default
 * `$XDG_STATE_HOME/opencode/model-presets.log`, option `logFile`), since the
 * console is invisible when OpenCode runs as a background service.
 */

import { Plugin } from "@opencode/plugin";
import {
  applyPresetDefaultModel,
  applyPresetToAgents,
  presetModelFor,
  type AgentEditorLike,
  type DefaultModelEditorLike,
} from "./apply";
import { configAgentIds, resolvePresetPath } from "./file";
import { createLogger, resolveLogPath } from "./log";
import { formatModel, PREFIX, sameModel, validatePluginOptions, type ModelRef, type ResolvedPreset } from "./options";
import {
  activePreset,
  agentFingerprint,
  createPresetState,
  modelFingerprint,
  pendingReloads,
  reloadPresets,
  type PresetState,
} from "./state";
import { watchPresetFile, type PresetWatcher } from "./watch";

export const PLUGIN_ID = "model-presets";

type Transform<E> = (callback: (editor: E) => void) => Promise<unknown>;
interface ModelDomainLike {
  transform?: Transform<unknown>;
  reload?: () => Promise<void>;
}

/**
 * Global-default-model editor across API revisions: `@opencode/plugin@2.0.20`
 * types expose `ctx.model` with `editor.default`; the 2.0.20 server still
 * provides `ctx.catalog` with `editor.model.default`.
 */
function modelDomain(ctx: unknown): ModelDomainLike | undefined {
  const c = ctx as { model?: ModelDomainLike; catalog?: ModelDomainLike };
  if (typeof c.model?.transform === "function") return c.model;
  if (typeof c.catalog?.transform === "function") return c.catalog;
  return undefined;
}

function defaultEditor(editor: unknown): DefaultModelEditorLike | undefined {
  const e = editor as { default?: DefaultModelEditorLike["default"]; model?: { default?: DefaultModelEditorLike["default"] } };
  const d = e?.default ?? e?.model?.default;
  return d && typeof d.get === "function" && typeof d.set === "function" ? { default: d } : undefined;
}

interface Registration {
  dispose(): Promise<void>;
}

/** Host plugins whose agent/model transforms must run before ours. */
export const CONFIG_PLUGINS = ["opencode.config.agent", "opencode.config.provider"] as const;

/**
 * Poll the plugin list until every id in `ids` is listed (active or failed).
 * Returns false on timeout or when `stop()` turns true.
 */
export async function waitForPlugins(
  ctx: { plugin: { list: () => Promise<{ data: readonly { id?: string }[] }> } },
  ids: readonly string[],
  stop: () => boolean,
  { intervalMs = 200, timeoutMs = 60_000 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!stop() && Date.now() < deadline) {
    try {
      const listed = new Set((await ctx.plugin.list()).data.map((p) => p.id));
      if (ids.every((id) => listed.has(id))) return true;
    } catch {
      // The server may not answer until startup finishes; retry.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/** Agents whose effective model differs from what `preset` asks for. */
export function findPresetMismatches(
  agents: readonly { id?: unknown; model?: ModelRef }[],
  preset: ResolvedPreset,
): string[] {
  const out: string[] = [];
  for (const agent of agents) {
    const id = String(agent.id);
    const wanted = presetModelFor(preset, id);
    if (wanted && !sameModel(agent.model, wanted)) out.push(id);
  }
  return out;
}

export interface EnsureAppliedDeps {
  listAgents(): Promise<readonly { id?: unknown; model?: ModelRef }[]>;
  preset(): ResolvedPreset;
  /** Move our transform after any transforms registered since (e.g. a config reload), then rebuild. */
  reapply(): Promise<void>;
  stop(): boolean;
  warn(message: string): void;
  info(message: string): void;
  delaysMs?: readonly number[];
}

/**
 * Read the effective agent models back and re-apply until they match the
 * preset. A host reload (e.g. a hot-reloaded plugin or config change) can
 * re-register the config layer's transforms after ours, so config models
 * would win; re-registering puts the preset last again.
 */
export async function ensurePresetApplied(deps: EnsureAppliedDeps): Promise<boolean> {
  const delays = deps.delaysMs ?? [300, 600, 1200, 2500, 5000];
  let reapplied = false;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (deps.stop()) return false;
    let mismatched: string[];
    try {
      mismatched = findPresetMismatches(await deps.listAgents(), deps.preset());
    } catch {
      mismatched = ["?"]; // agent list unavailable yet; retry
    }
    if (mismatched.length === 0) {
      if (reapplied) deps.info(`[${PREFIX}] model preset: ${deps.preset().name} re-applied after the host reloaded agents`);
      return true;
    }
    if (attempt === delays.length) {
      deps.warn(`[${PREFIX}] preset '${deps.preset().name}' not in effect for: ${mismatched.join(", ")}; restart OpenCode or re-save model-presets.yaml`);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    if (deps.stop()) return false;
    await deps.reapply();
    reapplied = true;
  }
  return false;
}

export interface LiveApplyDeps {
  readonly state: PresetState;
  reloadAgents(): Promise<void>;
  /** Reloads the global default model; omitted when model transforms are unavailable. */
  reloadModels?: () => Promise<void>;
  info?: (message: string) => void;
}

/**
 * Handle a preset file change: re-read it and, when it is valid and the
 * active preset's effective models differ from what was last applied, reload
 * agents (and the global default model if the preset's `model` changed).
 * An invalid file keeps the last good presets; the error is logged by
 * `reloadPresets`. Returns what was reloaded.
 */
export async function applyFileChange(deps: LiveApplyDeps): Promise<{ ok: boolean; agents: boolean; model: boolean }> {
  const { state } = deps;
  const info = deps.info ?? ((m: string) => console.info(m));
  const loaded = reloadPresets(state);
  if (!loaded.ok) return { ok: false, agents: false, model: false };
  const pending = pendingReloads(state);
  const model = pending.model && deps.reloadModels !== undefined;
  if (pending.agents) await deps.reloadAgents();
  if (model) await deps.reloadModels!();
  if (pending.agents || model) {
    const preset = activePreset(state);
    info(`[${PREFIX}] model preset: ${preset.name}${preset.model ? ` (default model ${formatModel(preset.model)})` : ""}`);
  }
  return { ok: true, agents: pending.agents, model };
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const pluginOptions = validatePluginOptions(ctx.options);
    const log = createLogger({ path: resolveLogPath(pluginOptions.logFile) });
    const state = createPresetState(resolvePresetPath(pluginOptions.file), {
      warn: log.warn,
      error: log.error,
      info: log.info,
    });
    reloadPresets(state);

    // True while a watcher-triggered apply runs; it logs the switch itself.
    let applyingFileChange = false;

    let configReady = false;
    const configAgents = configAgentIds();
    const agentTransform = (editor: unknown) => {
      reloadPresets(state);
      const preset = activePreset(state);
      // Before the config layer is active only built-in agents exist, so
      // unknown-agent warnings would be spurious.
      const result = applyPresetToAgents(editor as AgentEditorLike, preset, state.memory, configReady ? state.warn : undefined);
      // Once the config layer is active, unknown agents mean this rebuild ran
      // our transform before the config transforms (a host reload re-registered
      // them after us), so config models would win. Move ours last and rebuild.
      if (configReady && result.unknown.some((id) => configAgents.has(id))) scheduleOrderFix();
      const fingerprint = agentFingerprint(preset);
      // Log to the file only when a different preset takes effect (startup or
      // a reload that picked up an edit the watcher missed), not every reload.
      if (fingerprint !== state.appliedAgents && state.options && !applyingFileChange) {
        log.info(`[${PREFIX}] model preset: ${preset.name}`);
      }
      state.appliedAgents = fingerprint;
      if (result.changed.length > 0) {
        console.info(`[${PREFIX}] preset '${preset.name}' set ${result.changed.length} agent model(s)`);
      }
    };
    const models = modelDomain(ctx);
    const modelTransform = (editor: unknown) => {
      const target = defaultEditor(editor);
      const preset = activePreset(state);
      if (target) applyPresetDefaultModel(target, preset);
      state.appliedModel = modelFingerprint(preset);
    };

    const register = async () => {
      const handles: Registration[] = [await ctx.agent.transform(agentTransform)];
      if (models?.transform) handles.push((await models.transform(modelTransform)) as Registration);
      return handles;
    };
    let handles = await register();
    const reregister = async () => {
      const previous = handles;
      handles = await register();
      for (const handle of previous) await handle.dispose();
    };
    let orderFixes = 0;
    let orderFixPending = false;
    const scheduleOrderFix = () => {
      if (orderFixPending || disposed || orderFixes > 5) return;
      if (orderFixes === 5) {
        orderFixes++;
        log.warn(`[${PREFIX}] preset still overridden after repeated re-registration; restart OpenCode or re-save model-presets.yaml`);
        return;
      }
      orderFixes++;
      orderFixPending = true;
      setTimeout(() => {
        void (async () => {
          try {
            if (disposed) return;
            await reregister();
            await ctx.agent.reload();
            log.info(`[${PREFIX}] model preset: ${activePreset(state).name} re-applied after the host reloaded agents`);
          } catch (error) {
            log.warn(`[${PREFIX}] re-applying preset failed: ${String(error)}`);
          } finally {
            orderFixPending = false;
          }
        })();
      }, 250);
    };
    const listAgents = async () => {
      const out = (await (ctx.agent as unknown as { list: () => Promise<unknown> }).list()) as unknown;
      const data = Array.isArray(out) ? out : ((out as { data?: unknown })?.data ?? []);
      return data as readonly { id?: unknown; model?: ModelRef }[];
    };
    let ensuring: Promise<unknown> = Promise.resolve();
    const canList = typeof (ctx.agent as unknown as { list?: unknown }).list === "function";
    const scheduleEnsure = () => {
      if (!canList) return;
      ensuring = ensuring
        .then(() =>
          ensurePresetApplied({
            listAgents,
            preset: () => activePreset(state),
            reapply: async () => {
              await reregister();
              await ctx.agent.reload();
            },
            stop: () => disposed,
            warn: log.warn,
            info: log.info,
          }),
        )
        .catch((error) => log.warn(`[${PREFIX}] checking preset models failed: ${String(error)}`));
    };
    if (!models?.transform) {
      log.warn(`[${PREFIX}] model transforms unavailable; preset 'model' (global default) is ignored`);
    }

    // The host replays transforms in registration order on every rebuild, and
    // the config layer (`opencode.config.agent` applies opencode.json and
    // agents/*.md models, `opencode.config.provider` the root `model`)
    // activates after user plugins. Re-register once those are active so the
    // preset is applied last; until then only built-in agents are visible.
    let disposed = false;
    void (async () => {
      const ready = await waitForPlugins(ctx, CONFIG_PLUGINS, () => disposed);
      if (!ready || disposed) {
        if (!disposed) log.warn(`[${PREFIX}] config plugins not seen; presets may be overridden by config models`);
        return;
      }
      configReady = true;
      await reregister();
      scheduleEnsure();
    })().catch((error) => log.warn(`[${PREFIX}] transform re-registration failed: ${String(error)}`));

    // Live apply: file edits are serialised so overlapping changes never
    // interleave their reloads.
    let queue: Promise<unknown> = Promise.resolve();
    const onFileChange = () => {
      queue = queue
        .then(async () => {
          if (disposed) return;
          applyingFileChange = true;
          try {
            return await applyFileChange({
              state,
              reloadAgents: () => ctx.agent.reload(),
              ...(models?.reload ? { reloadModels: () => models.reload!() } : {}),
              info: log.info,
            });
          } finally {
            applyingFileChange = false;
          }
        })
        .then(() => scheduleEnsure())
        .catch((error) => log.warn(`[${PREFIX}] applying preset file change failed: ${String(error)}`));
    };
    const watcher: PresetWatcher | undefined = watchPresetFile(state.path, onFileChange, { warn: log.warn });

    return () => {
      disposed = true;
      watcher?.close();
    };
  },
});
