import { registerNativePermissionBridge, type NativePermissionBridgeContext, type NativePermissionIntent } from "../../../../packages/workplan-tools/src/permission-bridge";
import { NativePermissionBridgeRuntimeRpc } from "./rpc";

function parseIntent(value: unknown): NativePermissionIntent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Runtime test input must be an object");
  const input = value as Record<string, unknown>;
  const resources = input.resources;
  if (typeof input.sessionID !== "string" || typeof input.agent !== "string" ||
    typeof input.messageID !== "string" || typeof input.toolCallID !== "string" ||
    !Array.isArray(resources) || !resources.every((resource) => typeof resource === "string")) {
    throw new Error("Runtime test input must contain a complete exact intent");
  }
  return {
    sessionID: input.sessionID,
    agent: input.agent,
    messageID: input.messageID,
    toolCallID: input.toolCallID,
    resources,
  };
}

export default {
  id: "native-permission-bridge-runtime-harness",
  async setup(context: NativePermissionBridgeContext) {
    const bridge = await registerNativePermissionBridge(context);
    let continuations = 0;
    const control = await context.rpc.register(NativePermissionBridgeRuntimeRpc, {
      async authorize(input, rpcContext) {
        const receipt = await bridge.authorizeEdit(parseIntent(input), { signal: rpcContext.signal });
        continuations++;
        return { decision: receipt.decision, via: receipt.via, continuations };
      },
      async status() {
        const facts = bridge.diagnostics();
        return {
          continuations,
          clientVersion: facts.clientVersion,
          runtimeVersion: facts.runtimeVersion ?? "unknown",
          rpcRegistration: facts.rpcRegistration,
          hostBinding: facts.hostBinding,
          eventStream: facts.eventStream,
          permissionDecision: facts.permissionDecision,
        };
      },
    });
    return async () => {
      await control.dispose();
      await bridge.dispose();
    };
  },
};
