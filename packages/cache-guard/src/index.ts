import { Plugin } from "@opencode/plugin";
import { createCacheGuardState, getDiagnostics, handlePromptAdmission } from "./admission";
import { CacheGuardRpc, toWarningEvent, type WarningEventInput } from "./rpc";

export const PLUGIN_ID = "cache-guard";
export { createCacheGuardState, getDiagnostics, handlePromptAdmission } from "./admission";
export type { CacheGuardState, PromptAdmission, WarningDiagnostic } from "./admission";

const STATUS_TOOL_INPUT = { type: "object", additionalProperties: false, properties: { sessionID: { type: "string", description: "Filter diagnostics to one session." }, limit: { type: "number", description: "Maximum entries to return." } } } as const;

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const state = createCacheGuardState(ctx.options);
    if (!state.options.enabled) return;
    let emitWarning: ((warning: WarningEventInput) => Promise<void>) | undefined;
    try {
      const registration = await ctx.rpc.register(CacheGuardRpc, {});
      emitWarning = async (warning) => {
        try { await registration.events.emit("warning", toWarningEvent(warning)); }
        catch (error) { console.warn(`[cache-guard] toast notification skipped: ${String(error)}`); }
      };
    } catch (error) { console.warn(`[cache-guard] rpc unavailable; toast notification disabled: ${String(error)}`); }

    // Prompt hooks cannot be provider-scoped in V2; durable history is filtered instead.
    await ctx.session.hook("prompt", async (event) => {
      try {
        const messages = await ctx.session.context({ sessionID: event.sessionID });
        const result = handlePromptAdmission(state, { sessionID: event.sessionID }, messages);
        if (!result) return;
        if (emitWarning) await emitWarning(result.diagnostic);
        console.warn(`[cache-guard] ${result.message}`);
        if (result.block) throw new Error(`[cache-guard] ${result.message}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("[cache-guard]")) throw error;
        console.warn(`[cache-guard] prompt check skipped: ${String(error)}`);
      }
    });

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "cache_guard_status",
        description: "Show cache-reuse risk diagnostics. No prompt text or secrets are stored.",
        input: STATUS_TOOL_INPUT,
        execute: async (input) => {
          const args = input && typeof input === "object" ? input as { sessionID?: unknown; limit?: unknown } : {};
          const sessionID = typeof args.sessionID === "string" ? args.sessionID : undefined;
          const limit = typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0 ? Math.min(Math.floor(args.limit), state.options.diagnosticsLimit) : state.options.diagnosticsLimit;
          return { content: JSON.stringify({ plugin: PLUGIN_ID, entries: getDiagnostics(state, sessionID).slice(-limit) }, null, 2) };
        },
      });
    });
  },
});
