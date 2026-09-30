/**
 * model-presets — V2-only OpenCode plugin.
 *
 * Switches every agent's model (including the built-in general, compaction,
 * summary and title roles) between named, provider-agnostic presets at
 * runtime. Presets live in a YAML file (default `model-presets.yaml` in the
 * config root) that is re-read on every agent reload and `/preset`
 * invocation. The active preset name is kept in plugin storage.
 *
 * `/preset` lists presets and the effective per-agent models; `/preset <name>`
 * switches and reloads agents. Replies are written into the session as
 * synthetic messages with `resume: false`, so no model call is triggered.
 */

import { Plugin } from "@opencode/plugin";
import {
  applyPresetDefaultModel,
  applyPresetToAgents,
  type AgentEditorLike,
  type DefaultModelEditorLike,
} from "./apply";
import { COMMAND_NAME, runPresetCommand } from "./command";
import { resolvePresetPath } from "./file";
import { PREFIX, validatePluginOptions } from "./options";
import { activePreset, createPresetState, loadStoredName, reloadPresets, STORAGE_KEY } from "./state";

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

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const pluginOptions = validatePluginOptions(ctx.options);
    const state = createPresetState(resolvePresetPath(pluginOptions.file));
    reloadPresets(state);
    state.stored = await loadStoredName(ctx.storage, state.warn);

    let configReady = false;
    const agentTransform = (editor: unknown) => {
      reloadPresets(state);
      const preset = activePreset(state);
      // Before the config layer is active only built-in agents exist, so
      // unknown-agent warnings would be spurious.
      const result = applyPresetToAgents(editor as AgentEditorLike, preset, state.memory, configReady ? state.warn : undefined);
      if (result.changed.length > 0) {
        console.info(`[${PREFIX}] preset '${preset.name}' set ${result.changed.length} agent model(s)`);
      }
    };
    const models = modelDomain(ctx);
    const modelTransform = (editor: unknown) => {
      const target = defaultEditor(editor);
      if (target) applyPresetDefaultModel(target, activePreset(state));
    };

    const register = async () => {
      const handles: Registration[] = [await ctx.agent.transform(agentTransform)];
      if (models?.transform) handles.push((await models.transform(modelTransform)) as Registration);
      return handles;
    };
    let handles = await register();
    if (!models?.transform) {
      console.warn(`[${PREFIX}] model transforms unavailable; preset 'model' (global default) is ignored`);
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
        if (!disposed) console.warn(`[${PREFIX}] config plugins not seen; presets may be overridden by config models`);
        return;
      }
      const previous = handles;
      configReady = true;
      handles = await register();
      for (const handle of previous) await handle.dispose();
    })().catch((error) => console.warn(`[${PREFIX}] transform re-registration failed: ${String(error)}`));

    const activate = async (name: string) => {
      const before = activePreset(state);
      await ctx.storage.set(STORAGE_KEY, name);
      state.stored = name;
      await ctx.agent.reload();
      const after = activePreset(state);
      if (models?.reload && (before.model || after.model)) await models.reload();
    };

    await ctx.command.transform((editor) => {
      editor.add({
        name: COMMAND_NAME,
        description: "Model presets: /preset lists them, /preset <name> switches every agent's model",
        execute: async (input) => {
          let reply: string;
          try {
            reply = await runPresetCommand(input.prompt?.text, {
              state,
              activate,
              refresh: () => ctx.agent.reload(),
            });
          } catch (error) {
            reply = `[${PREFIX}] /${COMMAND_NAME} failed: ${String(error)}`;
          }
          try {
            await ctx.session.synthetic({
              sessionID: input.sessionID,
              text: reply,
              description: `/${COMMAND_NAME}`,
              metadata: { plugin: PLUGIN_ID },
              delivery: input.delivery,
              resume: false,
            });
          } catch (error) {
            console.warn(`[${PREFIX}] could not reply into session ${input.sessionID}: ${String(error)}`);
            console.info(reply);
          }
        },
      });
    });

    return () => {
      disposed = true;
    };
  },
});
