/**
 * openai-long-context — V2-only OpenCode plugin.
 *
 * A model transform clones every configured OpenAI model (by default
 * `gpt-5.6-*`, `gpt-6-*`, and `gpt-6.*` for dotted releases like `gpt-6.1-sol`) into a `<id>-1m` variant with a 1M-token context window
 * (context 1,000,000 / input 872,000 / output 128,000). Variants inherit all
 * base-model fields (capabilities, cost, compatibility, transport settings)
 * and only override identity, display name, and limits.
 *
 * The transform is idempotent and replays cleanly: re-registration derives
 * the same variant set from the same base models and refreshes existing
 * variants in place.
 */

import { Plugin } from "@opencode/plugin";
import {
  applyLongContextModels,
  validateOptions,
  type LongContextOptions,
} from "./policy";

export const PLUGIN_ID = "openai-long-context";

export interface LongContextState {
  options: LongContextOptions;
}

export function createLongContextState(rawOptions?: unknown): LongContextState {
  return { options: validateOptions(rawOptions) };
}

type ModelTransform = (
  callback: (
    editor: Parameters<typeof applyLongContextModels>[0],
  ) => void,
) => Promise<void> | void;

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const state = createLongContextState(ctx.options);
    if (!state.options.enabled) return;

    const run = (editor: Parameters<typeof applyLongContextModels>[0]) => {
      const created = applyLongContextModels(editor, state.options);
      if (created.length > 0) {
        console.info(
          `[openai-long-context] registered ${created.length} variant(s) on '${state.options.providerID}': ${created.join(", ")}`,
        );
      }
    };

    // Current V2 API (`@opencode/plugin@2.0.8`): `ctx.model.transform`.
    const model = (
      ctx as unknown as { model?: { transform?: ModelTransform } }
    ).model;
    if (typeof model?.transform === "function") {
      await model.transform(run);
      return;
    }

    // Backward compatibility: `@opencode/plugin@2.0.3` exposed the same
    // editor as `ctx.catalog.transform`. Kept so older servers still work.
    const catalog = (
      ctx as unknown as { catalog?: { transform?: ModelTransform } }
    ).catalog;
    if (typeof catalog?.transform === "function") {
      await catalog.transform(run);
      return;
    }

    console.warn(
      "[openai-long-context] model transforms are unavailable; plugin disabled",
    );
  },
});
