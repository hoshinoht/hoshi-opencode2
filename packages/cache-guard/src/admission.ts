import { evaluateCacheRisk, formatWarning, validateOptions, type CacheGuardOptions, type CacheRisk } from "./policy";

export interface WarningDiagnostic {
  sessionID: string;
  model: string;
  idleMinutes: number;
  cacheReadTokens: number;
  mode: string;
  at: string;
  action: "advisory" | "blocked";
}

export interface CacheGuardState {
  options: CacheGuardOptions;
  warned: Set<string>;
  diagnostics: WarningDiagnostic[];
}

export function createCacheGuardState(rawOptions?: unknown): CacheGuardState {
  return { options: validateOptions(rawOptions), warned: new Set(), diagnostics: [] };
}

function addDiagnostic(state: CacheGuardState, risk: CacheRisk, sessionID: string, action: WarningDiagnostic["action"]): WarningDiagnostic {
  const diagnostic: WarningDiagnostic = { sessionID, model: `${risk.response.providerID}/${risk.response.model}`, idleMinutes: risk.idleMinutes, cacheReadTokens: risk.response.cacheReadTokens, mode: state.options.mode, action, at: new Date().toISOString() };
  state.diagnostics.push(diagnostic);
  while (state.diagnostics.length > state.options.diagnosticsLimit) state.diagnostics.shift();
  return diagnostic;
}

export function getDiagnostics(state: CacheGuardState, sessionID?: string): WarningDiagnostic[] {
  return state.diagnostics.filter((entry) => !sessionID || entry.sessionID === sessionID).map((entry) => ({ ...entry }));
}

export interface PromptAdmission { sessionID: string; }

/** Warn once per prior response; confirm mode blocks only that first admission. */
export function handlePromptAdmission(state: CacheGuardState, event: PromptAdmission, messages: readonly unknown[], now = Date.now()): { diagnostic: WarningDiagnostic; block: boolean; message: string } | undefined {
  const risk = evaluateCacheRisk(event.sessionID, messages, state.options, now);
  if (!risk || state.warned.has(risk.fingerprint)) return undefined;
  state.warned.add(risk.fingerprint);
  const block = state.options.mode === "confirm";
  const diagnostic = addDiagnostic(state, risk, event.sessionID, block ? "blocked" : "advisory");
  return { diagnostic, block, message: block ? `${formatWarning(risk)} Retry the same prompt to confirm sending.` : formatWarning(risk) };
}
