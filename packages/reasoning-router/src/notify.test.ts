import { describe, expect, it } from "bun:test";
import {
  createRouterState,
  handleModelContext,
  type ContextEvent,
} from "./index";
import { validateOptions } from "./policy";
import {
  formatEffortDisplay,
  formatToastMessage,
  ReasoningRouterRpc,
  toRoutedEvent,
} from "./rpc";

function textEvent(sessionID: string, agent: string, text: string): ContextEvent {
  return {
    sessionID,
    agent,
    model: { providerID: "openai", id: "gpt-6-luna-1m", variant: "high" },
    messages: [{ role: "user", parts: [{ type: "text", text }] }],
    providerOptions: {},
  };
}

describe("effort display", () => {
  it("formats model id and effort", () => {
    expect(formatEffortDisplay({ providerID: "openai", id: "gpt-6-luna-1m" }, "low")).toBe(
      "gpt-6-luna-1m#low",
    );
  });

  it("falls back to provider or generic name when the id is missing", () => {
    expect(formatEffortDisplay({ providerID: "openai" }, "high")).toBe("openai#high");
    expect(formatEffortDisplay(undefined, "medium")).toBe("model#medium");
  });

  it("formats a toast message with agent, display, and requested class", () => {
    const message = formatToastMessage({
      sessionID: "ses_a",
      agent: "explore",
      model: "openai/gpt-6-luna-1m#high",
      display: "gpt-6-luna-1m#xhigh",
      requested: "fast",
      escalate: false,
      resolved: "low",
    });
    expect(message).toBe("explore gpt-6-luna-1m#xhigh applied (requested fast)");
  });

  it("marks escalation in the toast message", () => {
    const message = formatToastMessage({
      sessionID: "ses_a",
      agent: "oracle",
      model: "openai/gpt-6-astra-1m#low",
      display: "gpt-6-astra-1m#low",
      requested: "deep",
      escalate: true,
      resolved: "low",
    });
    expect(message).toBe("oracle gpt-6-astra-1m#low applied (requested deep+escalate)");
  });
});

describe("routed RPC contract", () => {
  it("exposes a routed event with the expected schema", () => {
    expect(ReasoningRouterRpc.id).toBe("reasoning-router");
    const schema = (
      ReasoningRouterRpc as unknown as {
        events: { routed: { schema: Record<string, unknown> } };
      }
    ).events.routed.schema as {
      type: string;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    for (const field of ["sessionID", "agent", "model", "display", "requested", "escalate", "resolved"]) {
      expect(schema.required).toContain(field);
    }
  });

  it("builds event data from applied records and skips fallbacks", () => {
    expect(
      toRoutedEvent({
        sessionID: "ses_a",
        agent: "explore",
        model: "openai/gpt-6-luna-1m#high",
        display: "gpt-6-luna-1m#xhigh",
        requested: "fast",
        escalate: false,
        resolved: "low",
      }),
    ).toEqual({
      sessionID: "ses_a",
      agent: "explore",
      model: "openai/gpt-6-luna-1m#high",
      display: "gpt-6-luna-1m#xhigh",
      requested: "fast",
      escalate: false,
      resolved: "low",
    });
    expect(
      toRoutedEvent({
        sessionID: "ses_a",
        agent: "explore",
        model: "openai/gpt-6-luna-1m#high",
        display: "",
        requested: "auto",
        escalate: false,
        resolved: null,
      }),
    ).toBeUndefined();
  });
});

describe("routing records for notifications", () => {
  it("returns a record with display on first resolution", () => {
    const state = createRouterState(undefined);
    const event = textEvent("ses_a", "explore", "[reasoning:fast] Find configs");
    const record = handleModelContext(state, event, "openai");
    expect(record?.display).toBe("gpt-6-luna-1m#low");
    expect(record?.resolved).toBe("low");
  });

  it("returns undefined on continuations so toasts fire once", () => {
    const state = createRouterState(undefined);
    const first = textEvent("ses_a", "explore", "[reasoning:fast] Find configs");
    expect(handleModelContext(state, first, "openai")?.display).toBe("gpt-6-luna-1m#low");
    const continuation = textEvent("ses_a", "explore", "follow-up without marker");
    expect(handleModelContext(state, continuation, "openai")).toBeUndefined();
  });

  it("leaves display empty when no override applies", () => {
    const state = createRouterState({ supportedEfforts: ["low"] });
    const event = textEvent("ses_a", "code-checker", "[reasoning:deep] Review this");
    const record = handleModelContext(state, event, "openai");
    expect(record?.resolved).toBeNull();
    expect(record?.display).toBe("");
  });
});

describe("notify option", () => {
  it("defaults to true", () => {
    expect(validateOptions(undefined).notify).toBe(true);
  });

  it("accepts false to silence event emission", () => {
    expect(validateOptions({ notify: false }).notify).toBe(false);
  });

  it("rejects non-boolean values", () => {
    expect(() => validateOptions({ notify: "yes" })).toThrow(/notify/);
  });
});
