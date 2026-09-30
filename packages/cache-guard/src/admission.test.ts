import { describe, expect, it } from "bun:test";
import { createCacheGuardState, getDiagnostics, handlePromptAdmission } from "./admission";

const now = 1_800_000;
const response = (id = "msg_1", completed = 0) => ({
  type: "assistant",
  id,
  model: { providerID: "openai", id: "gpt-5.6" },
  time: { completed },
  tokens: { cache: { read: 10_000 } },
});

describe("prompt admission", () => {
  it("warns once in advisory mode, then allows unchanged admissions silently", () => {
    const state = createCacheGuardState(undefined);
    expect(handlePromptAdmission(state, { sessionID: "ses_1" }, [response()], now)).toMatchObject({ block: false, diagnostic: { action: "advisory" } });
    expect(handlePromptAdmission(state, { sessionID: "ses_1" }, [response()], now)).toBeUndefined();
    expect(getDiagnostics(state)).toHaveLength(1);
  });

  it("blocks once in confirm mode, then allows the immediate retry silently", () => {
    const state = createCacheGuardState({ mode: "confirm" });
    expect(handlePromptAdmission(state, { sessionID: "ses_1" }, [response()], now)).toMatchObject({ block: true, diagnostic: { action: "blocked" } });
    expect(handlePromptAdmission(state, { sessionID: "ses_1" }, [response()], now)).toBeUndefined();
    expect(getDiagnostics(state)).toHaveLength(1);
  });

  it("warns again for a new completed-response fingerprint", () => {
    const state = createCacheGuardState(undefined);
    expect(handlePromptAdmission(state, { sessionID: "ses_1" }, [response()], now + 60)).toBeDefined();
    expect(handlePromptAdmission(state, { sessionID: "ses_1" }, [response("msg_2", 60)], now + 60)).toBeDefined();
    expect(getDiagnostics(state)).toHaveLength(2);
  });
});
