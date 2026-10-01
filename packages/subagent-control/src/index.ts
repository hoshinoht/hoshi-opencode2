import { Plugin } from "@opencode/plugin";
import type { Info as NativeToolInfo } from "@opencode/plugin/promise/tool";
import { LIST_DESCRIPTION, LIST_INPUT, LIST_TOOL, listSubagents } from "./list";
import { discoveredListPort } from "./service";
import { PLUGIN_ID, STOP_DESCRIPTION, STOP_INPUT, STOP_TOOL, stopSubagent, type SessionPort } from "./stop";

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const session: SessionPort = {
      get: (input, options) => ctx.session.get(input, options),
      interrupt: (input, options) => ctx.session.interrupt(input, options),
    };
    const registration = await ctx.tool.transform((editor) => {
      editor.add({
        name: STOP_TOOL,
        description: STOP_DESCRIPTION,
        input: STOP_INPUT as unknown as NativeToolInfo["input"],
        options: { codemode: false },
        execute: async (input, toolContext) => ({
          content: await stopSubagent(session, input, { sessionID: toolContext.sessionID, signal: toolContext.signal }),
        }),
      });
      editor.add({
        name: LIST_TOOL,
        description: LIST_DESCRIPTION,
        input: LIST_INPUT as unknown as NativeToolInfo["input"],
        options: { codemode: false },
        execute: async (input, toolContext) => ({
          content: await listSubagents(discoveredListPort(), input, { sessionID: toolContext.sessionID, signal: toolContext.signal }),
        }),
      });
    });
    return () => registration.dispose();
  },
});
