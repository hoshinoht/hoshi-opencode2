/**
 * reasoning-router TUI companion (V2-only).
 *
 * Subscribes to the server's `rpc.reasoning-router.routed` events and shows
 * a toast such as `explore gpt-6-luna-1m#low applied` whenever a subagent's
 * first model call resolves an effort override. No prompt content is read or
 * displayed — only routing metadata the server already logs.
 *
 * Event subscriptions are live-only: toasts appear while the TUI is
 * connected; missed events while disconnected are still visible via
 * `reasoning_router_status` and the server log.
 */

import { Plugin } from "@opencode/plugin/tui";
import { formatToastMessage, ReasoningRouterRpc } from "./rpc";

export const TUI_PLUGIN_ID = "reasoning-router-tui";

const TOAST_DURATION_MS = 4000;

export default Plugin.define({
  id: TUI_PLUGIN_ID,
  async setup(ctx) {
    let unsubscribe: (() => void) | undefined;
    try {
      const rpc = ctx.client.rpc(ReasoningRouterRpc);
      unsubscribe = rpc.events.on("routed", (event) => {
        try {
          const data = event.data as unknown as {
            sessionID: string;
            agent: string;
            model: string;
            display: string;
            requested: string;
            escalate: boolean;
            resolved: string;
          };
          if (!data || typeof data.display !== "string" || typeof data.agent !== "string") return;
          ctx.ui.toast.show({
            title: "reasoning-router",
            message: formatToastMessage(data),
            variant: "info",
            duration: TOAST_DURATION_MS,
          });
        } catch (error) {
          console.warn(`[reasoning-router] toast skipped: ${String(error)}`);
        }
      });
    } catch (error) {
      console.warn(`[reasoning-router] toast subscription skipped: ${String(error)}`);
    }

    return () => {
      try {
        unsubscribe?.();
      } catch {
        // TUI teardown is best-effort.
      }
    };
  },
});
