import { Rpc } from "@opencode/plugin/rpc";
import { formatIdleMinutes } from "./policy";

export const CacheGuardRpc = Rpc.define({
  id: "cache-guard",
  methods: {},
  events: {
    warning: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" }, model: { type: "string" }, idleMinutes: { type: "number" }, cacheReadTokens: { type: "number" }, mode: { type: "string" },
        },
        required: ["sessionID", "model", "idleMinutes", "cacheReadTokens", "mode"],
        additionalProperties: false,
      },
    },
  },
});

export interface WarningEventInput {
  sessionID: string;
  model: string;
  idleMinutes: number;
  cacheReadTokens: number;
  mode: string;
}
export interface WarningEvent extends WarningEventInput {
  [key: string]: unknown;
}
export function toWarningEvent(diagnostic: WarningEventInput): WarningEvent {
  return {
    sessionID: diagnostic.sessionID,
    model: diagnostic.model,
    idleMinutes: diagnostic.idleMinutes,
    cacheReadTokens: diagnostic.cacheReadTokens,
    mode: diagnostic.mode,
  };
}
export function formatWarningToast(event: WarningEvent): string {
  return `${event.model}: ${formatIdleMinutes(event.idleMinutes)} idle; ${event.cacheReadTokens.toLocaleString("en-US")} demonstrated cache-read tokens. Reuse is at risk, not expired.`;
}
