import { Plugin } from "@opencode/plugin/tui";
import { CacheGuardRpc, formatWarningToast } from "./rpc";

export default Plugin.define({
  id: "cache-guard-tui",
  setup(ctx) {
    try {
      const rpc = ctx.client.rpc(CacheGuardRpc);
      return rpc.events.on("warning", (event) => {
        const data = event.data as unknown as { sessionID?: string; model?: string; idleMinutes?: number; cacheReadTokens?: number; mode?: string };
        if (typeof data?.model !== "string" || typeof data.idleMinutes !== "number" || typeof data.cacheReadTokens !== "number" || typeof data.mode !== "string") return;
        ctx.ui.toast.show({ title: "cache-guard", message: formatWarningToast({ sessionID: data.sessionID ?? "", model: data.model, idleMinutes: data.idleMinutes, cacheReadTokens: data.cacheReadTokens, mode: data.mode }), variant: "warning", duration: 6000 });
      });
    } catch (error) { console.warn(`[cache-guard] toast subscription skipped: ${String(error)}`); }
  },
});
