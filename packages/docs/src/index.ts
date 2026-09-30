import { Plugin } from "@opencode/plugin";
import type { Info as NativeToolInfo } from "@opencode/plugin/promise/tool";
import { PLUGIN_ID, setupDocsPlugin, type DocsPluginContext } from "./register";

export { PLUGIN_ID, TOOL_NAMES } from "./register";

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    // Adapt the host's tool editor to the plain JSON-schema registration used by setupDocsPlugin.
    const adapted: DocsPluginContext = {
      location: ctx.location,
      tool: {
        transform: (edit) =>
          ctx.tool.transform((editor) =>
            edit({
              add: (tool) =>
                editor.add({
                  name: tool.name,
                  description: tool.description,
                  input: tool.input as unknown as NativeToolInfo["input"],
                  ...(tool.options ? { options: tool.options } : {}),
                  execute: (input, toolContext) => {
                    // `signal` is present at runtime on OpenCode 2 tool contexts but not in every typings release.
                    const signal = (toolContext as { signal?: AbortSignal }).signal;
                    return tool.execute(input, signal ? { signal } : {});
                  },
                }),
            }),
          ),
      },
    };
    const { dispose } = await setupDocsPlugin(adapted);
    return dispose;
  },
});
