import { Plugin } from "@opencode/plugin";
import type { Info as NativeToolInfo } from "@opencode/plugin/promise/tool";
import { validateCacheTTL } from "./activity";
import { LIST_DESCRIPTION, LIST_INPUT, LIST_TOOL, listSubagents } from "./list";
import { discoveredListPort } from "./service";
import { PLUGIN_ID, STOP_DESCRIPTION, STOP_INPUT, STOP_TOOL, stopSubagent, type SessionPort } from "./stop";

function validateOptions(raw: unknown): { cacheTTLMinutes: ReturnType<typeof validateCacheTTL> } {
  if (raw === undefined || raw === null) return { cacheTTLMinutes: validateCacheTTL(undefined) };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("[subagent-control] options must be an object");
  const { cacheTTLMinutes, ...rest } = raw as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length > 0) throw new Error(`[subagent-control] unknown option(s) ${unknown.join(", ")}`);
  return { cacheTTLMinutes: validateCacheTTL(cacheTTLMinutes) };
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const config = validateOptions(ctx.options);
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
          content: await listSubagents(
            {
              ...discoveredListPort(),
              // History comes from the host itself, like cache-guard reads it.
              context: (sessionID, signal) => ctx.session.context({ sessionID }, signal ? { signal } : undefined),
            },
            input,
            { sessionID: toolContext.sessionID, signal: toolContext.signal },
            config,
          ),
        }),
      });
    });
    return () => registration.dispose();
  },
});
