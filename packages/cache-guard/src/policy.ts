export type GuardMode = "advisory" | "confirm";

export interface CacheGuardOptions {
  enabled: boolean;
  mode: GuardMode;
  riskAfterMinutes: number;
  minCacheReadTokens: number;
  providerIDs: string[];
  diagnosticsLimit: number;
}

export const DEFAULT_OPTIONS: CacheGuardOptions = {
  enabled: true,
  mode: "advisory",
  riskAfterMinutes: 30,
  minCacheReadTokens: 10_000,
  providerIDs: ["openai"],
  diagnosticsLimit: 20,
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positiveInteger(value: unknown, name: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) throw new Error(`[cache-guard] ${name} must be an integer >= ${minimum}`);
  return value;
}

export function validateOptions(raw?: unknown): CacheGuardOptions {
  if (raw === undefined) return { ...DEFAULT_OPTIONS, providerIDs: [...DEFAULT_OPTIONS.providerIDs] };
  const input = record(raw);
  if (!input) throw new Error("[cache-guard] options must be an object");
  const allowed = new Set(["enabled", "mode", "riskAfterMinutes", "minCacheReadTokens", "providerIDs", "diagnosticsLimit"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`[cache-guard] unknown option '${key}'`);
  const enabled = input.enabled === undefined ? DEFAULT_OPTIONS.enabled : input.enabled;
  if (typeof enabled !== "boolean") throw new Error("[cache-guard] enabled must be boolean");
  const mode = input.mode === undefined ? DEFAULT_OPTIONS.mode : input.mode;
  if (mode !== "advisory" && mode !== "confirm") throw new Error("[cache-guard] mode must be 'advisory' or 'confirm'");
  const providerIDs = input.providerIDs === undefined ? [...DEFAULT_OPTIONS.providerIDs] : input.providerIDs;
  if (!Array.isArray(providerIDs) || providerIDs.length === 0 || providerIDs.some((id) => typeof id !== "string" || id.length === 0)) throw new Error("[cache-guard] providerIDs must be a non-empty array of non-empty strings");
  return {
    enabled,
    mode,
    riskAfterMinutes: input.riskAfterMinutes === undefined ? DEFAULT_OPTIONS.riskAfterMinutes : positiveInteger(input.riskAfterMinutes, "riskAfterMinutes", 0),
    minCacheReadTokens: input.minCacheReadTokens === undefined ? DEFAULT_OPTIONS.minCacheReadTokens : positiveInteger(input.minCacheReadTokens, "minCacheReadTokens", 0),
    providerIDs: [...new Set(providerIDs)],
    diagnosticsLimit: input.diagnosticsLimit === undefined ? DEFAULT_OPTIONS.diagnosticsLimit : positiveInteger(input.diagnosticsLimit, "diagnosticsLimit", 1),
  };
}

export interface EligibleResponse { providerID: string; model: string; completedAt: number; cacheReadTokens: number; id?: string; }

function modelRef(value: unknown): { providerID: string; id: string; variant?: string } | undefined {
  const model = record(value);
  return typeof model?.providerID === "string" && typeof model.id === "string"
    ? { providerID: model.providerID, id: model.id, ...(typeof model.variant === "string" ? { variant: model.variant } : {}) }
    : undefined;
}

/**
 * Evaluate only the latest completed assistant response. An older cache hit
 * does not describe reuse after a later miss or provider/model change.
 */
export function selectEligibleResponse(messages: readonly unknown[], options: CacheGuardOptions): EligibleResponse | undefined {
  let latest: { item: Record<string, unknown>; completedAt: number; index: number } | undefined;
  for (const [index, message] of messages.entries()) {
    const item = record(message);
    if (!item || item.type !== "assistant") continue;
    const completedAt = record(item.time)?.completed;
    if (typeof completedAt === "number" && Number.isFinite(completedAt) && (!latest || completedAt >= latest.completedAt)) latest = { item, completedAt, index };
  }
  if (!latest) return undefined;
  const responseModel = modelRef(latest.item.model);
  if (!responseModel || !options.providerIDs.includes(responseModel.providerID)) return undefined;
  let selectedModel = responseModel;
  for (const message of messages.slice(latest.index + 1)) {
    const item = record(message);
    if (item?.type !== "model-switched") continue;
    const selected = modelRef(item.model);
    if (!selected) return undefined;
    selectedModel = selected;
  }
  if (selectedModel.providerID !== responseModel.providerID || selectedModel.id !== responseModel.id || selectedModel.variant !== responseModel.variant) return undefined;
  const tokens = record(latest.item.tokens); const cache = record(tokens?.cache);
  const cacheReadTokens = cache?.read;
  if (typeof cacheReadTokens !== "number" || !Number.isInteger(cacheReadTokens) || cacheReadTokens < options.minCacheReadTokens) return undefined;
  return { providerID: responseModel.providerID, model: `${responseModel.id}${responseModel.variant ? `#${responseModel.variant}` : ""}`, completedAt: latest.completedAt, cacheReadTokens, ...(typeof latest.item.id === "string" ? { id: latest.item.id } : {}) };
}

export interface CacheRisk { response: EligibleResponse; idleMinutes: number; fingerprint: string; }
export function responseFingerprint(sessionID: string, response: EligibleResponse): string {
  return [sessionID, response.id ?? "", response.providerID, response.model, response.completedAt, response.cacheReadTokens].join("|");
}

/** A risk means observed idle time is at or beyond the configured boundary. */
export function evaluateCacheRisk(sessionID: string, messages: readonly unknown[], options: CacheGuardOptions, now = Date.now()): CacheRisk | undefined {
  if (!options.enabled) return undefined;
  const response = selectEligibleResponse(messages, options);
  if (!response || !Number.isFinite(now) || now < response.completedAt) return undefined;
  const idleMinutes = (now - response.completedAt) / 60_000;
  if (idleMinutes < options.riskAfterMinutes) return undefined;
  return { response, idleMinutes, fingerprint: responseFingerprint(sessionID, response) };
}

export function formatIdleMinutes(minutes: number): string { return `${minutes.toFixed(minutes < 10 ? 1 : 0)} min`; }
export function formatWarning(risk: CacheRisk): string {
  return `Cache reuse is at risk after ${formatIdleMinutes(risk.idleMinutes)} idle; the prior ${risk.response.providerID}/${risk.response.model} response demonstrated ${risk.response.cacheReadTokens.toLocaleString("en-US")} cache-read tokens. Reuse is not guaranteed: matching prefix and routing can still miss at any age.`;
}
