import { Rpc } from "../../../../packages/workplan-tools/src/rpc";

export const NATIVE_LIFECYCLE_TOOL_NAMES = [
  "workplan_create",
  "workplan_update",
  "workplan_inspect",
  "workplan_validate",
  "workplan_read",
  "workplan_list",
  "workplan_patch",
  "workplan_reset",
  "workplan_resume",
  "workplan_checkpoint",
  "workplan_compact",
  "workplan_doctor",
  "workplan_compact_preview",
] as const;

export const NativeLifecycleRuntimeRpc = Rpc.define({
  id: "hoshi-workplan-native-lifecycle-runtime-test",
  methods: {
    run: {
      input: {
        type: "object",
        properties: {
          toolName: { type: "string", enum: [...NATIVE_LIFECYCLE_TOOL_NAMES] },
          args: { type: "object", additionalProperties: true },
          sessionID: { type: "string" },
          agent: { type: "string" },
          messageID: { type: "string" },
          toolCallID: { type: "string" },
        },
        required: ["toolName", "args", "sessionID", "agent", "messageID", "toolCallID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          content: { type: "string" },
          completed: { type: "integer", minimum: 0 },
        },
        required: ["content", "completed"],
        additionalProperties: false,
      },
    },
    status: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          completed: { type: "integer", minimum: 0 },
          nativeTools: { type: "array", items: { type: "string" } },
        },
        required: ["completed", "nativeTools"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});
