export const LIST_TOOL = "subagent_list";

export const LIST_DESCRIPTION = [
  "Lists the subagents (direct child sessions) this session started, running first then newest, with each one's sessionID, agent, title, whether it is running now, and for idle ones how and when the last turn ended.",
  "There is no last-activity time: a running child shows only when it was created. An idle child whose work is unfinished (for example one that ended its turn waiting on a background command) will not wake on its own; resume it with the subagent tool.",
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
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export async function listSubagents(port: ListPort, rawInput: unknown, caller: ListCaller): Promise<string> {
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
  const lines = [`${own.length} subagent(s) of this session, ${running} running:`];
  for (const { child, running: isRunning } of own) {
    // Sessions expose no last-activity time, so a running child only reports when it was started.
    const state = isRunning
      ? "running"
      : `idle, last turn ${child.outcome ?? "unknown"}${child.time.idle ? ` and ended ${age(child.time.idle, now)} ago` : ""}`;
    const parts = [`- ${child.id}`, child.agent ?? "unknown agent", state, `created ${age(child.time.created, now)} ago`];
    if (child.time.archived) parts.push("archived");
    lines.push(`${parts.join(" | ")}${child.title ? `\n  ${child.title}` : ""}`);
  }
  return lines.join("\n");
}
