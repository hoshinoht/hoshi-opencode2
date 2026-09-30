import { Rpc } from "@opencode/plugin/rpc";
import { PROVIDER_NAMES, type ProviderName } from "./constants.ts";

export const USAGE_RPC_ID = "usage-tracker";

const usageWindowSchema = {
  type: "object",
  properties: {
    label: { type: "string" },
    usedPercent: { type: "number" },
    resetTime: { type: "string" },
  },
  required: ["label", "usedPercent"],
  additionalProperties: false,
} as const;

const usageDataSchema = {
  type: "object",
  properties: {
    provider: { type: "string" },
    planType: { type: "string" },
    windows: { type: "array", items: usageWindowSchema },
    extra: { type: "object", additionalProperties: { type: "string" } },
    error: { type: "string" },
  },
  required: ["provider", "windows"],
  additionalProperties: false,
} as const;

export const UsageTrackerRpc = Rpc.define({
  id: USAGE_RPC_ID,
  methods: {
    fetch: {
      input: {
        type: "object",
        properties: {
          provider: { type: "string", enum: [...PROVIDER_NAMES] },
        },
        required: ["provider"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["ok", "empty", "error"] },
          provider: { type: "string", enum: [...PROVIDER_NAMES] },
          providers: { type: "array", items: usageDataSchema },
          message: { type: "string" },
        },
        required: ["kind", "provider"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});

export interface UsageRpcInput {
  provider: ProviderName;
}
