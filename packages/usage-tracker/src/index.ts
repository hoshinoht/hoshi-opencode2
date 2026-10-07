import { Plugin } from "@opencode/plugin";
import { mergeRuntimeOpenAI, normalizeAnthropicCredential, normalizeOpenAICredential, readAuthTokens } from "./auth.ts";
import { isProviderName, PLUGIN_ID } from "./constants.ts";
import { UsageTrackerRpc } from "./rpc.ts";
import { fetchUsageResult } from "./usage.ts";
import { fetchOpenAIUsage } from "./providers/openai.ts";
import { fetchAnthropicUsage } from "./providers/anthropic.ts";
import { createQuotaReminder, reminderThresholds } from "./reminder.ts";

export { PLUGIN_ID } from "./constants.ts";

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const readAuth = async () => {
      let stored = await readAuthTokens();
      // Resolve independently so one unavailable integration cannot hide another.
      const [openai, anthropic] = await Promise.allSettled(
        ["openai", "anthropic"].map(async (provider) => {
          const connection = await ctx.integration.connection.active(provider);
          return connection ? ctx.integration.connection.resolve(connection) : undefined;
        }),
      );
      if (openai?.status === "fulfilled") stored = mergeRuntimeOpenAI(stored, openai.value);
      if (anthropic?.status === "fulfilled") {
        const credential = normalizeAnthropicCredential(anthropic.value);
        if (credential) stored = { ...stored, anthropic: credential };
      }
      return stored;
    };

    const registration = await ctx.rpc.register(UsageTrackerRpc, {
      fetch: async (input, context) => {
        const provider = (input as { provider?: unknown }).provider;
        if (!isProviderName(provider)) {
          return { kind: "error", provider: "all", message: "Unknown usage provider." };
        }
        return fetchUsageResult(provider, { signal: context.signal, readAuth });
      },
    });

    const thresholds = reminderThresholds(ctx.options);
    const remind = createQuotaReminder(thresholds, async (provider) => {
      const connection = await ctx.integration.connection.active(provider);
      if (!connection || !("id" in connection)) return;
      return {
        key: connection.id,
        fetch: async () => {
          const credential = await ctx.integration.connection.resolve(connection);
          if (!credential || credential.type !== "oauth") {
            return { provider, windows: [], error: "Subscription OAuth connection required" };
          }
          const options = { timeoutMs: 3_000 };
          if (provider === "anthropic") return fetchAnthropicUsage(credential.access, options);
          const auth = normalizeOpenAICredential(credential);
          if (!auth) return { provider, windows: [], error: "Missing OAuth credential" };
          return fetchOpenAIUsage(auth.accessToken, auth.accountId, options);
        },
      };
    });
    const hooks = await Promise.all(Object.keys(thresholds).map((providerID) =>
      ctx.session.hook("context", remind, { providerID }),
    ));

    return async () => {
      await Promise.all([registration.dispose(), ...hooks.map((hook) => hook.dispose())]);
    };
  },
});
