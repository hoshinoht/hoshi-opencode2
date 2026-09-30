import type { NativePermissionBridgeContext } from "../../../../packages/workplan-tools/src/permission-bridge";
import { NATIVE_LIFECYCLE_TOOL_NAMES, NativeLifecycleRuntimeRpc } from "./rpc";

type HarnessToolContext = {
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
  readonly signal: AbortSignal;
  readonly progress: (update: Record<string, unknown>) => Promise<void>;
};

type HarnessTool = {
  readonly id: string;
  readonly execute: (input: unknown, context: HarnessToolContext) => Promise<unknown>;
};

type HarnessContext = NativePermissionBridgeContext & {
  readonly tool: { readonly list: () => Promise<readonly HarnessTool[]> };
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Runtime harness input must be an object");
  return value as Record<string, unknown>;
}

export default {
  id: "native-workplan-lifecycle-runtime-harness",
  async setup(context: HarnessContext) {
    let completed = 0;
    const registration = await context.rpc.register(NativeLifecycleRuntimeRpc, {
      async run(input, rpcContext) {
        const request = record(input);
        if (typeof request.toolName !== "string" || !(NATIVE_LIFECYCLE_TOOL_NAMES as readonly string[]).includes(request.toolName)) {
          throw new Error("Runtime harness accepts only the native workplan catalog");
        }
        const args = record(request.args);
        for (const key of ["sessionID", "agent", "messageID", "toolCallID"] as const) {
          if (typeof request[key] !== "string") throw new Error(`Runtime harness requires ${key}`);
        }
        const nativeTool = (await context.tool.list()).find((tool) => tool.id === request.toolName);
        if (!nativeTool) throw new Error(`Native tool is not effectively registered: ${request.toolName}`);
        // This scratch-only relay supplies test identity; cancellation uses the host RPC call's AbortSignal.
        const result = await nativeTool.execute(args, {
          sessionID: request.sessionID as string,
          agent: request.agent as string,
          messageID: request.messageID as string,
          id: request.toolCallID as string,
          signal: rpcContext.signal,
          async progress() {},
        });
        completed++;
        const content = typeof result === "string"
          ? result
          : typeof result === "object" && result !== null && "content" in result && typeof result.content === "string"
            ? result.content
            : JSON.stringify(result) ?? String(result);
        return { content, completed };
      },
      async status() {
        const nativeTools = (await context.tool.list()).map((tool) => tool.id)
          .filter((name) => (NATIVE_LIFECYCLE_TOOL_NAMES as readonly string[]).includes(name))
          .sort();
        return { completed, nativeTools };
      },
    });
    return () => registration.dispose();
  },
};
