import { Plugin } from "@opencode/plugin";
import { PLUGIN_ID, pruneAll, pruneRequest, SessionPrunes, validateOptions, type RequestEvent } from "./budget";

const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const options = validateOptions(ctx.options);
    const state = new SessionPrunes();
    const onRequest = (event: RequestEvent & { readonly agent: string }): void => {
      const outcome = pruneRequest(state, event, options);
      if (outcome.changed) {
        console.warn(
          `[${PLUGIN_ID}] ${event.sessionID} (${event.agent}): request now omits ${outcome.images} image(s), ${mb(outcome.bytes)} MB`,
        );
      }
    };
    // Unscoped hooks run for every provider; the budget is picked per provider inside.
    const registrations = [
      await ctx.session.hook("context", (event) => onRequest(event as unknown as RequestEvent & { agent: string })),
      await ctx.session.hook("generate", (event) => onRequest(event as unknown as RequestEvent & { agent: string })),
      await ctx.session.hook("compaction", (event) => {
        pruneAll(event.messages as unknown[]);
      }),
    ];
    return async () => {
      await Promise.all(registrations.map((registration) => registration.dispose()));
    };
  },
});
