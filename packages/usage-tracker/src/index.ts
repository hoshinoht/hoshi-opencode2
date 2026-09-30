import { Plugin } from "@opencode/plugin";
import { mergeRuntimeOpenAI, readAuthTokens } from "./auth.ts";
import { PLUGIN_ID } from "./constants.ts";
import { UsageTrackerRpc } from "./rpc.ts";
import { fetchUsageResult } from "./usage.ts";

export { PLUGIN_ID } from "./constants.ts";

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const readAuth = async () => {
      const stored = await readAuthTokens();
      try {
        const connection = await ctx.integration.connection.active("openai");
        if (!connection) return stored;
        const credential = await ctx.integration.connection.resolve(connection);
        return mergeRuntimeOpenAI(stored, credential);
      } catch {
        // The legacy auth file remains a best-effort fallback for installations
        // whose integration API is unavailable.
        return stored;
      }
    };

    const registration = await ctx.rpc.register(UsageTrackerRpc, {
      fetch: async (input, context) => {
        const provider = (input as { provider?: unknown }).provider;
        if (provider !== "all" && provider !== "copilot" && provider !== "openai") {
          return { kind: "error", provider: "all", message: "Unknown usage provider." };
        }
        return fetchUsageResult(provider, { signal: context.signal, readAuth });
      },
    });

    return () => registration.dispose();
  },
});
