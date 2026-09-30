/**
 * Shared RPC contract for the reasoning-router plugin (V2-only).
 *
 * The server emits one `routed` event per first-call routing decision that
 * applies an override. The TUI companion subscribes and shows a toast such as
 * `explore gpt-6-luna-1m#low applied`. Event data carries no prompt content
 * — only routing metadata already present in diagnostics.
 */

import { Rpc } from "@opencode/plugin/rpc";

export const ROUTER_RPC_ID = "reasoning-router";

export const ReasoningRouterRpc = Rpc.define({
  id: ROUTER_RPC_ID,
  methods: {},
  events: {
    routed: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          agent: { type: "string" },
          /** Configured model label, e.g. `openai/gpt-6-luna-1m#high`. */
          model: { type: "string" },
          /** Effective effort display, e.g. `gpt-6-luna-1m#low`. */
          display: { type: "string" },
          requested: { type: "string" },
          escalate: { type: "boolean" },
          resolved: { type: "string" },
        },
        required: [
          "sessionID",
          "agent",
          "model",
          "display",
          "requested",
          "escalate",
          "resolved",
        ],
        additionalProperties: false,
      },
    },
  },
});

export interface RoutedEventData {
  sessionID: string;
  agent: string;
  model: string;
  display: string;
  requested: string;
  escalate: boolean;
  resolved: string;
}

/**
 * Effective-effort display for a model, e.g. `gpt-6-luna-1m#low`.
 * Falls back to the provider ID (or `"model"`) when the model ID is missing.
 */
export function formatEffortDisplay(
  model: { providerID?: string; id?: string } | undefined,
  effort: string,
): string {
  const name =
    (typeof model?.id === "string" && model.id.length > 0
      ? model.id
      : typeof model?.providerID === "string" && model.providerID.length > 0
        ? model.providerID
        : "model");
  return `${name}#${effort}`;
}

/** Toast body for a routing decision, e.g. `explore gpt-6-luna#low applied (requested fast)`. */
export function formatToastMessage(data: RoutedEventData): string {
  const suffix = data.escalate ? "+escalate" : "";
  return `${data.agent} ${data.display} applied (requested ${data.requested}${suffix})`;
}

/** Build RPC event data from a routing record. Pure and total. */
export function toRoutedEvent(record: {
  sessionID: string;
  agent: string;
  model: string;
  display: string;
  requested: string;
  escalate: boolean;
  resolved: string | null;
}): RoutedEventData | undefined {
  if (!record.resolved) return undefined;
  return {
    sessionID: record.sessionID,
    agent: record.agent,
    model: record.model,
    display: record.display,
    requested: record.requested,
    escalate: record.escalate,
    resolved: record.resolved,
  };
}
