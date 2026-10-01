import { summarizeActivity, type Activity, type CacheTTLMinutes } from "./activity";

export const LIST_TOOL = "subagent_list";

export const LIST_DESCRIPTION = [
  "Lists the subagents (direct child sessions) this session started, running first then newest, with each one's sessionID, agent, title, whether it is running now, and for idle ones how and when the last turn ended.",
  "A running child shows what it is doing now (a tool such as shell, or a model response) and its last activity. An idle child whose work is unfinished (for example one that ended its turn waiting on a background command) will not wake on its own; resume it with the subagent tool.",
  "Idle children also show whether their prompt cache has probably expired. Resuming a cold child re-writes its whole context to the cache at the write price; that is usually still cheaper than a fresh child redoing the work, so it informs the choice rather than ruling resumption out.",
  "Check it before subagent_stop so you stop the right child. It reports state only; it is not a reason to poll background children.",
].join("\n");

export const LIST_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    running_only: { type: "boolean", description: "Only list children that are running now. Default false." },
  },
  required: [],
} as const;

export interface ChildInfo {
  id: string;
  parentID?: string;
  agent?: string;
  title?: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  /** `idle` is when the last turn ended; `updated` tracks metadata edits only, not activity. */
  time: { created: number; updated: number; idle?: number; archived?: number };
}

/** Read access to the session store, from the discovered local service. */
export interface ListPort {
  /** Proves the store holds the caller, so an empty list is not a wrong-server false negative. */
  get(sessionID: string, signal?: AbortSignal): Promise<{ id: string }>;
  children(parentID: string, signal?: AbortSignal): Promise<ChildInfo[]>;
  active(signal?: AbortSignal): Promise<ReadonlySet<string>>;
  /** A child's message history, for activity and cache timing. Optional: without it those lines are omitted. */
  context?(sessionID: string, signal?: AbortSignal): Promise<readonly unknown[]>;
}

export interface ListOptions {
  cacheTTLMinutes: CacheTTLMinutes;
}

export interface ListCaller {
  sessionID: string;
  signal?: AbortSignal;
  now?: number;
}

function parseInput(value: unknown): { runningOnly: boolean } {
  if (value === undefined || value === null) return { runningOnly: false };
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${LIST_TOOL} input: expected an object`);
  const { running_only, ...rest } = value as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length > 0) throw new Error(`Invalid ${LIST_TOOL} input: unknown field(s) ${unknown.join(", ")}`);
  if (running_only !== undefined && typeof running_only !== "boolean") {
    throw new Error(`Invalid ${LIST_TOOL} input: running_only must be a boolean`);
  }
  return { runningOnly: running_only === true };
}

function age(from: number, now: number): string {
  return duration(now - from);
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function tokens(count: number): string {
  return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
}

function cacheLine(activity: Activity, now: number): string | undefined {
  const cache = activity.cache;
  if (!cache) return undefined;
  const lifetime = `${cache.providerID}, ${cache.ttlMinutes}m lifetime`;
  if (!cache.cold) {
    return `cache: likely warm for ~${duration(cache.lastCallAt + cache.ttlMinutes * 60_000 - now)} more (${lifetime})`;
  }
  const reread = cache.contextTokens !== undefined ? `; resuming re-writes ~${tokens(cache.contextTokens)} context tokens at the cache-write price` : "";
  return `cache: likely cold, last model call ${age(cache.lastCallAt, now)} ago (${lifetime})${reread}`;
}

export async function listSubagents(
  port: ListPort,
  rawInput: unknown,
  caller: ListCaller,
  options: ListOptions = { cacheTTLMinutes: {} },
): Promise<string> {
  const { runningOnly } = parseInput(rawInput);
  const now = caller.now ?? Date.now();
  try {
    await port.get(caller.sessionID, caller.signal);
  } catch {
    throw new Error(`${LIST_TOOL}: the discovered OpenCode service does not hold this session, so its subagents cannot be listed.`);
  }
  const [children, active] = await Promise.all([port.children(caller.sessionID, caller.signal), port.active(caller.signal)]);
  // The store filter is trusted only as far as parentID re-checks out.
  const own = children
    .filter((child) => child.parentID === caller.sessionID)
    .map((child) => ({ child, running: active.has(child.id) }))
    .filter((entry) => !runningOnly || entry.running)
    .sort((a, b) => Number(b.running) - Number(a.running) || b.child.time.created - a.child.time.created);

  if (own.length === 0) return runningOnly ? "No subagents of this session are running." : "This session has not started any subagents.";
  const running = own.filter((entry) => entry.running).length;
  const activities = await Promise.all(
    own.map(async ({ child }): Promise<Activity | undefined> => {
      if (!port.context) return undefined;
      try {
        return summarizeActivity(await port.context(child.id, caller.signal), now, options.cacheTTLMinutes);
      } catch {
        return undefined;
      }
    }),
  );
  const lines = [`${own.length} subagent(s) of this session, ${running} running:`];
  for (const [index, { child, running: isRunning }] of own.entries()) {
    const activity = activities[index];
    let state: string;
    if (isRunning) {
      // Session metadata has no activity time; the message history supplies it when readable.
      const doing = activity?.current ? ` ${activity.current.what} for ${age(activity.current.since, now)}` : "";
      const last = activity?.lastActivityAt !== undefined ? `, last activity ${age(activity.lastActivityAt, now)} ago` : "";
      state = `running${doing}${last}`;
    } else {
      state = `idle, last turn ${child.outcome ?? "unknown"}${child.time.idle ? ` and ended ${age(child.time.idle, now)} ago` : ""}`;
    }
    const parts = [`- ${child.id}`, child.agent ?? "unknown agent", state, `created ${age(child.time.created, now)} ago`];
    if (child.time.archived) parts.push("archived");
    lines.push(parts.join(" | "));
    if (child.title) lines.push(`  ${child.title}`);
    // A running child refreshes its own cache, so only idle ones get a cache line.
    const cache = !isRunning && activity ? cacheLine(activity, now) : undefined;
    if (cache) lines.push(`  ${cache}`);
    if (port.context && !activity) lines.push("  activity unavailable: its message history could not be read");
  }
  return lines.join("\n");
}
