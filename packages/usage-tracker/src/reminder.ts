import type { UsageData } from "./format.ts";

type Provider = "openai" | "anthropic";
export type ReminderThresholds = Partial<Record<Provider, number>>;
type UsageSource = { key: string; fetch: () => Promise<UsageData> };
type ContextEvent = {
  model: { providerID: string; id: string };
  system: Array<{ type: "text"; text: string }>;
};
const CACHE_MS = 5 * 60_000;
const MARKER = "<system-reminder source=\"usage-tracker\">";

export function reminderThresholds(options: Record<string, unknown>): ReminderThresholds {
  const raw = options.quotaReminderRemainingPercent;
  if (!raw || typeof raw !== "object") return {};
  const result: ReminderThresholds = {};
  for (const provider of ["openai", "anthropic"] as const) {
    const value = (raw as Record<string, unknown>)[provider];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100) result[provider] = value;
  }
  return result;
}

export function quotaReminder(data: UsageData, modelID: string, remainingPercent: number): string | undefined {
  if (data.error) return;
  const low = data.windows.filter((window) => {
    if (window.label === "Weekly Opus" && !modelID.toLowerCase().includes("opus")) return false;
    if (window.label === "Weekly Sonnet" && !modelID.toLowerCase().includes("sonnet")) return false;
    return Number.isFinite(window.usedPercent) && window.usedPercent >= 100 - remainingPercent && window.usedPercent <= 100;
  });
  if (!low.length) return;
  // Keep the injected instruction stable while the threshold is exceeded.
  return `${MARKER}\n${data.provider} quota has ${remainingPercent}% or less remaining in: ${low.map((w) => w.label).join(", ")}. ` +
    "Prioritise finishing the user's agreed work and essential verification. Avoid expanding scope or starting optional investigations. " +
    "Do not skip required checks or claim unfinished work is complete. If completion is not feasible before quota runs out, " +
    "leave a concise handoff with completed work, remaining work, and exact next steps.\n</system-reminder>";
}

/** Shared across sessions/subagents, isolated by provider and active connection. */
export function createQuotaReminder(
  thresholds: ReminderThresholds,
  resolve: (provider: Provider) => Promise<UsageSource | undefined>,
  now = Date.now,
) {
  const cache = new Map<Provider, { key: string; expires: number; pending: Promise<UsageData | undefined> }>();
  return async (event: ContextEvent): Promise<void> => {
    const provider = event.model.providerID;
    if (provider !== "openai" && provider !== "anthropic") return;
    const threshold = thresholds[provider];
    if (threshold === undefined) return;
    // Context can be reused by the host: replace only our own previous reminder.
    event.system = event.system.filter((part) => !part.text.startsWith(MARKER));
    try {
      const source = await resolve(provider);
      if (!source) return;
      let entry = cache.get(provider);
      if (!entry || entry.key !== source.key || now() >= entry.expires) {
        entry = {
          key: source.key,
          expires: Infinity,
          pending: Promise.resolve().then(source.fetch).catch(() => undefined),
        };
        cache.set(provider, entry);
        const current = entry;
        void entry.pending.then(() => { current.expires = now() + CACHE_MS; });
      }
      const data = await entry.pending;
      const text = data && quotaReminder(data, event.model.id, threshold);
      if (text) event.system.push({ type: "text", text });
    } catch {
      // Usage availability must never prevent an agent from working.
    }
  };
}
