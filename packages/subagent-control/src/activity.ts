/** Prompt-cache lifetime per provider ID, in minutes. Providers not listed get no cache note. */
export type CacheTTLMinutes = Record<string, number>;

// Anthropic: 5 minutes by default, measured from the start of the request that last used the
// cache (OpenCode's default anthropic policy sets no 1h TTL). OpenAI GPT-5.6+: at least 30 minutes
// after the most recent write or reuse. Both refresh on every use. GitHub Copilot does not document
// a lifetime, so it is left out.
export const DEFAULT_CACHE_TTL_MINUTES: CacheTTLMinutes = { anthropic: 5, openai: 30 };

export interface CacheNote {
  providerID: string;
  /** When the last model call started; providers time the cache from the request, not its response. */
  lastCallAt: number;
  ttlMinutes: number;
  cold: boolean;
  /** Prompt size of the last call (input + cache read + cache write): what a resume re-reads. */
  contextTokens?: number;
}

export interface Activity {
  /** Latest timestamp anywhere in the recent messages. */
  lastActivityAt?: number;
  /** What a running child is doing now, for example "shell" or "model response". */
  current?: { what: string; since: number };
  cache?: CacheNote;
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function times(value: unknown): number[] {
  const time = rec(value);
  return time ? Object.values(time).map(num).filter((t): t is number => t !== undefined) : [];
}

function contextTokens(tokens: unknown): number | undefined {
  const usage = rec(tokens);
  if (!usage) return undefined;
  const cache = rec(usage.cache);
  const total = (num(usage.input) ?? 0) + (num(cache?.read) ?? 0) + (num(cache?.write) ?? 0);
  return total > 0 ? total : undefined;
}

/** What the newest message says the child is doing. Only meaningful while it is running. */
function currentWork(last: Rec | undefined): Activity["current"] {
  if (!last) return undefined;
  const created = num(rec(last.time)?.created);
  if (last.type !== "assistant") return created === undefined ? undefined : { what: "waiting for the model", since: created };
  const parts = Array.isArray(last.content) ? last.content.map(rec) : [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part?.type !== "tool" || rec(part.state)?.status !== "running") continue;
    const since = num(rec(part.time)?.ran) ?? num(rec(part.time)?.created) ?? created;
    if (since !== undefined) return { what: typeof part.name === "string" ? part.name : "tool", since };
  }
  if (num(rec(last.time)?.completed) === undefined && created !== undefined) return { what: "model response", since: created };
  return undefined;
}

/**
 * Summarise a child's message history: latest activity, current work, and whether the
 * prompt cache from its last model call has probably expired.
 */
export function summarizeActivity(messages: readonly unknown[], now: number, ttl: CacheTTLMinutes): Activity {
  const items = messages.map(rec).filter((m): m is Rec => m !== undefined);
  const activity: Activity = {};

  // Only the tail matters; long histories stay cheap.
  let latest: number | undefined;
  for (const item of items.slice(-5)) {
    const stamps = [...times(item.time)];
    if (Array.isArray(item.content)) for (const part of item.content) stamps.push(...times(rec(part)?.time));
    for (const stamp of stamps) if (latest === undefined || stamp > latest) latest = stamp;
  }
  if (latest !== undefined) activity.lastActivityAt = latest;

  const current = currentWork(items.at(-1));
  if (current) activity.current = current;

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    const completed = num(rec(item.time)?.completed);
    if (item.type !== "assistant" || completed === undefined) continue;
    const started = num(rec(item.time)?.created) ?? completed;
    const providerID = rec(item.model)?.providerID;
    if (typeof providerID === "string" && ttl[providerID] !== undefined) {
      const ttlMinutes = ttl[providerID]!;
      const tokens = contextTokens(item.tokens);
      activity.cache = {
        providerID,
        lastCallAt: started,
        ttlMinutes,
        cold: now - started > ttlMinutes * 60_000,
        ...(tokens !== undefined ? { contextTokens: tokens } : {}),
      };
    }
    break;
  }
  return activity;
}

export function validateCacheTTL(raw: unknown): CacheTTLMinutes {
  if (raw === undefined) return { ...DEFAULT_CACHE_TTL_MINUTES };
  const input = rec(raw);
  if (!input) throw new Error("[subagent-control] cacheTTLMinutes must be an object of providerID -> minutes");
  const out: CacheTTLMinutes = {};
  for (const [provider, minutes] of Object.entries(input)) {
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
      throw new Error(`[subagent-control] cacheTTLMinutes.${provider} must be a positive number`);
    }
    out[provider] = minutes;
  }
  return out;
}
