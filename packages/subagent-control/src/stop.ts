export const PLUGIN_ID = "subagent-control";
export const STOP_TOOL = "subagent_stop";

export const STOP_DESCRIPTION = [
  "Stops a running subagent that this session started, by interrupting its child session. Check subagent_list first to confirm which child to stop.",
  "Pass the sessionID the subagent tool returned. Only direct children of the calling session can be stopped.",
  "The child's current turn is aborted and its session is kept: pass the same sessionID to the subagent tool to continue it later.",
  "Use it when a child's brief is superseded, it has drifted out of scope, or the user asked to stop it. Do not use it to poll progress.",
].join("\n");

export const STOP_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionID: { type: "string", description: "Child session ID returned by the subagent tool." },
    reason: { type: "string", description: "Why the child is being stopped; echoed in the result for the record." },
  },
  required: ["sessionID"],
} as const;

export interface ChildSession {
  id: string;
  parentID?: string;
  agent?: string;
  title?: string;
}

/** Slice of the host session API this tool relies on. */
export interface SessionPort {
  get(input: { sessionID: string }, options?: { signal?: AbortSignal }): Promise<ChildSession>;
  interrupt(input: { sessionID: string }, options?: { signal?: AbortSignal }): Promise<{ interrupted: boolean }>;
}

export interface StopCaller {
  sessionID: string;
  signal?: AbortSignal;
}

function parseInput(value: unknown): { sessionID: string; reason?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${STOP_TOOL} input: expected an object`);
  }
  const { sessionID, reason, ...rest } = value as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length > 0) throw new Error(`Invalid ${STOP_TOOL} input: unknown field(s) ${unknown.join(", ")}`);
  if (typeof sessionID !== "string" || sessionID.trim() === "") {
    throw new Error(`Invalid ${STOP_TOOL} input: sessionID must be a non-empty string`);
  }
  if (reason !== undefined && typeof reason !== "string") {
    throw new Error(`Invalid ${STOP_TOOL} input: reason must be a string`);
  }
  return { sessionID: sessionID.trim(), ...(reason ? { reason } : {}) };
}

export async function stopSubagent(session: SessionPort, rawInput: unknown, caller: StopCaller): Promise<string> {
  const { sessionID, reason } = parseInput(rawInput);
  const options = caller.signal ? { signal: caller.signal } : {};
  if (sessionID === caller.sessionID) throw new Error(`${STOP_TOOL} cannot stop the calling session itself.`);

  let child: ChildSession;
  try {
    child = await session.get({ sessionID }, options);
  } catch (error) {
    throw new Error(`${STOP_TOOL}: session ${sessionID} could not be read (${error instanceof Error ? error.message : String(error)}).`);
  }
  // Ownership: a parent may only stop the children it started.
  if (child.parentID !== caller.sessionID) {
    throw new Error(`${STOP_TOOL}: session ${sessionID} is not a child of this session; only your own subagents can be stopped.`);
  }

  const { interrupted } = await session.interrupt({ sessionID }, options);
  const label = `${sessionID}${child.agent ? ` (${child.agent})` : ""}`;
  const lines = interrupted
    ? [
        `Stopped subagent ${label}: its current turn was interrupted.`,
        "Its session and any edits it already made are kept. Treat its work as incomplete and do not wait for a completion receipt from it.",
        `To continue it later, call the subagent tool with sessionID ${sessionID}.`,
      ]
    : [`Subagent ${label} was not running, so nothing was interrupted. Its last result stands.`];
  if (reason) lines.push(`Reason: ${reason}`);
  return lines.join("\n");
}
