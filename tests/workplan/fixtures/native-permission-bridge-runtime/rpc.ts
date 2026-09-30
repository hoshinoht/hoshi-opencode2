import { Rpc } from "../../../../packages/workplan-tools/src/rpc";

export const NativePermissionBridgeRuntimeRpc = Rpc.define({
  id: "hoshi-workplan-permission-bridge-runtime-test",
  methods: {
    authorize: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          agent: { type: "string" },
          messageID: { type: "string" },
          toolCallID: { type: "string" },
          resources: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["sessionID", "agent", "messageID", "toolCallID", "resources"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          decision: { type: "string", enum: ["allow"] },
          via: { type: "string", enum: ["runtime-policy", "user-reply"] },
          continuations: { type: "integer", minimum: 0 },
        },
        required: ["decision", "via", "continuations"],
        additionalProperties: false,
      },
    },
    status: {
      input: {
        type: "object",
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          continuations: { type: "integer", minimum: 0 },
          clientVersion: { type: "string" },
          runtimeVersion: { type: "string" },
          rpcRegistration: { type: "string" },
          hostBinding: { type: "string" },
          eventStream: { type: "string" },
          permissionDecision: { type: "string" },
        },
        required: [
          "continuations",
          "clientVersion",
          "runtimeVersion",
          "rpcRegistration",
          "hostBinding",
          "eventStream",
          "permissionDecision",
        ],
        additionalProperties: false,
      },
    },
  },
  events: {},
});
