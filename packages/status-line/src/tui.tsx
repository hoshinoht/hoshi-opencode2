/** @jsxImportSource @opentui/solid */
/**
 * A one-row status line under the composer: context window, cache hit, live
 * streaming speed, uncommitted changes and elapsed time, in Dusk Darker roles.
 *
 * OpenCode learns exact token counts only when a step ends, so the live speed
 * figures are estimated from streamed deltas and calibrated against the exact
 * counts on `session.step.ended` (see rate.ts):
 *
 *   ↯  sliding window: what the last few seconds look like, held dimmed when the stream stops
 *   μ  turn average: exact tokens of finished steps plus the step in flight
 */
import { Plugin } from "@opencode/plugin/tui";
import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, Show } from "solid-js";
import { diffTotals, contextUsed, type DiffStat, type TokenRecord } from "./format.ts";
import { cacheSegment, contextSegment, diffSegment, fitLine, speedSegment, timeSegment, type Segment } from "./line.ts";
import {
  active,
  beginStep,
  beginTurn,
  createMeter,
  dropStep,
  endStep,
  endTurn,
  observe,
  recordedSteps,
  restoreFinal,
  speedView,
  type Meter,
  type RecordedMessage,
} from "./rate.ts";

export const TUI_PLUGIN_ID = "status-line";

/** Redraw cadence while a stream is live. */
const TICK_MS = 250;
/** Repaint cadence otherwise: elapsed time and held figures. */
const HEARTBEAT_MS = 1_000;
/** How long a working-tree reading is trusted before the host is asked again. */
const DIFF_REFRESH_MS = 5_000;
/** The `app` slot draws at the window's bottom: match the composer's indent and keep clear of the last rows. */
const PADDING = { left: 2, right: 2, bottom: 1 } as const;

/**
 * Meters live on `globalThis`: OpenCode hot-reloads a plugin when one of its
 * files is saved, re-running `setup` with fresh module state, and readings and
 * calibration should survive that rather than blank the line mid-turn.
 */
const METERS_KEY = "__hoshiOpencodeStatusLineMeters";

function sharedMeters(): Map<string, Meter> {
  const shared = globalThis as Record<string, unknown>;
  const existing = shared[METERS_KEY];
  if (existing instanceof Map) return existing as Map<string, Meter>;
  const meters = new Map<string, Meter>();
  shared[METERS_KEY] = meters;
  return meters;
}

type ModelRef = { id?: string; providerID?: string };
type LocationLike = { directory?: string; workspaceID?: string };

/** The bits of an event this plugin reads, structurally, so a payload change degrades instead of throwing. */
type EventLike = {
  created?: number;
  data?: { sessionID?: unknown; assistantMessageID?: unknown; delta?: unknown; tokens?: { output?: number; reasoning?: number } };
};

const sessionOf = (event: EventLike): string | undefined =>
  typeof event?.data?.sessionID === "string" ? event.data.sessionID : undefined;

const eventTime = (event: EventLike): number =>
  typeof event?.created === "number" && event.created > 0 ? event.created : Date.now();

function setup(context: Plugin.Context) {
  const meters = sharedMeters();
  const [version, setVersion] = createSignal(0, { equals: false });
  const bump = () => setVersion((value) => value + 1);
  const warned = new Set<string>();
  const warn = (what: string, error: unknown) => {
    if (warned.has(what)) return;
    warned.add(what);
    console.warn(`status-line: ${what}`, error);
  };

  const meter = (sessionID: string): Meter => {
    let found = meters.get(sessionID);
    if (!found) {
      found = createMeter();
      meters.set(sessionID, found);
    }
    return found;
  };

  /** Fast redraws while any stream is live, then stop; the next delta restarts them. */
  let ticker: ReturnType<typeof setInterval> | undefined;
  const tick = () => {
    if (ticker) return;
    ticker = setInterval(() => {
      bump();
      const now = Date.now();
      for (const each of meters.values()) if (active(each, now)) return;
      clearInterval(ticker);
      ticker = undefined;
    }, TICK_MS);
  };
  const heartbeat = setInterval(bump, HEARTBEAT_MS);

  /** A plugin bug must never take the TUI down: handlers report once and carry on. */
  const safely =
    <E,>(name: string, handler: (event: E) => void) =>
    (event: E) => {
      try {
        handler(event);
      } catch (error) {
        warn(`${name} handler failed`, error);
      }
    };

  const sessionLocation = (sessionID: string): LocationLike =>
    context.data.session.get(sessionID)?.location ?? context.location ?? context.data.location.default();

  // ── Uncommitted changes, from the host's VCS status (no git subprocess) ──
  const diffs = new Map<string, { stat: DiffStat; at: number }>();
  const diffing = new Set<string>();
  const refreshDiff = (directory: string) => {
    if (diffing.has(directory)) return;
    diffing.add(directory);
    const settle = (stat: DiffStat) => diffs.set(directory, { stat, at: Date.now() });
    try {
      void context.client.vcs
        .status({ location: { directory } })
        .then(
          (result) => settle(diffTotals(result?.data)),
          // No repository or provider: read as a clean tree until the next interval.
          () => settle({ added: 0, deleted: 0 }),
        )
        .finally(() => {
          diffing.delete(directory);
          bump();
        });
    } catch (error) {
      diffing.delete(directory);
      settle({ added: 0, deleted: 0 });
      warn("vcs status unavailable", error);
    }
  };
  const diffStat = (sessionID: string, now: number): DiffStat | undefined => {
    const directory = sessionLocation(sessionID).directory;
    if (!directory) return undefined;
    const reading = diffs.get(directory);
    if (!reading || now - reading.at >= DIFF_REFRESH_MS) refreshDiff(directory);
    return reading?.stat;
  };

  // ── Turn boundaries and streaming ──
  const onTurnEnd = (event: EventLike) => {
    const sessionID = sessionOf(event);
    if (!sessionID) return;
    endTurn(meter(sessionID), Date.now());
    // The turn has just written to the working tree: re-ask on the next paint.
    const directory = sessionLocation(sessionID).directory;
    const reading = directory ? diffs.get(directory) : undefined;
    if (reading) reading.at = 0;
    bump();
  };

  const onDelta = (event: EventLike) => {
    const sessionID = sessionOf(event);
    const delta = event?.data?.delta;
    if (!sessionID || typeof delta !== "string" || delta.length === 0) return;
    // The event's own clock marks the first token, so the exact span starts when the model began emitting.
    observe(meter(sessionID), Date.now(), delta.length, event.created);
    tick();
  };

  const stops = [
    context.data.on("session.text.delta", safely("delta", onDelta)),
    context.data.on("session.reasoning.delta", safely("delta", onDelta)),
    // Tool arguments stream as output tokens too.
    context.data.on("session.tool.input.delta", safely("delta", onDelta)),
    context.data.on(
      "session.step.started",
      safely("step.started", (event: EventLike) => {
        const sessionID = sessionOf(event);
        const messageID = event?.data?.assistantMessageID;
        if (!sessionID || typeof messageID !== "string") return;
        beginStep(meter(sessionID), messageID, eventTime(event), Date.now());
      }),
    ),
    context.data.on(
      "session.step.ended",
      safely("step.ended", (event: EventLike) => {
        const sessionID = sessionOf(event);
        const messageID = event?.data?.assistantMessageID;
        const tokens = event?.data?.tokens;
        if (!sessionID || typeof messageID !== "string" || !tokens) return;
        endStep(meter(sessionID), messageID, (tokens.output ?? 0) + (tokens.reasoning ?? 0), eventTime(event), Date.now());
        bump();
      }),
    ),
    context.data.on(
      "session.step.failed",
      safely("step.failed", (event: EventLike) => {
        const sessionID = sessionOf(event);
        const messageID = event?.data?.assistantMessageID;
        if (sessionID && typeof messageID === "string") dropStep(meter(sessionID), messageID);
      }),
    ),
    // A prompt starts an execution and its settlement ends it; the fold resets only here.
    context.data.on(
      "session.execution.started",
      safely("execution.started", (event: EventLike) => {
        const sessionID = sessionOf(event);
        if (sessionID) beginTurn(meter(sessionID), Date.now());
      }),
    ),
    context.data.on("session.execution.succeeded", safely("execution.succeeded", onTurnEnd)),
    context.data.on("session.execution.failed", safely("execution.failed", onTurnEnd)),
    context.data.on("session.execution.interrupted", safely("execution.interrupted", onTurnEnd)),
    // Late belt for a turn whose settlement never arrived; a second close is a no-op.
    context.data.on("session.idle", safely("idle", onTurnEnd)),
    context.data.on("session.usage.updated", safely("usage", bump)),
    context.data.on("session.model.selected", safely("model", bump)),
  ];

  // ── Resume: rebuild the last turn's settled figure for a session met without a meter ──
  const seeded = new Set<string>();
  const seed = async (sessionID: string) => {
    if (seeded.has(sessionID)) return;
    seeded.add(sessionID);
    try {
      void context.data.session.sync(sessionID).catch(() => {});
      await context.data.session.message.sync(sessionID);
      // Live events got here first: they are newer than the record.
      if (meters.has(sessionID)) return;
      const steps = recordedSteps(context.data.session.message.list(sessionID) as RecordedMessage[]);
      if (!steps) return;
      const restored = createMeter();
      if (restoreFinal(restored, steps, Date.now()) === undefined || meters.has(sessionID)) return;
      meters.set(sessionID, restored);
      bump();
    } catch (error) {
      warn("could not seed the speed meter", error);
    }
  };

  // ── Context window: the newest assistant message that reported usage ──
  const windowInfo = (sessionID: string): { tokens?: TokenRecord; model?: ModelRef } => {
    let found: { tokens?: TokenRecord; model?: ModelRef } = {};
    for (const message of context.data.session.message.list(sessionID) ?? []) {
      if (message?.type !== "assistant" || !message.tokens) continue;
      if (contextUsed(message.tokens) > 0) found = { tokens: message.tokens, model: message.model };
    }
    return found;
  };

  const modelSynced = new Set<string>();
  const contextLimit = (model: ModelRef | undefined, location: LocationLike): number | undefined => {
    if (!model?.id || !model.providerID) return undefined;
    const ref = location.directory ? { directory: location.directory, workspaceID: location.workspaceID } : undefined;
    const models = context.data.location.model.list(ref);
    if (!models) {
      const key = ref?.directory ?? "";
      if (!modelSynced.has(key)) {
        modelSynced.add(key);
        void context.data.location.model.sync(ref).then(bump, () => {});
      }
      return undefined;
    }
    const info = models.find((entry) => entry?.providerID === model.providerID && (entry.id === model.id || entry.modelID === model.id));
    const limit = info?.limit?.context;
    return typeof limit === "number" && limit > 0 ? limit : undefined;
  };

  const segments = (sessionID: string, now: number): Segment[] => {
    const session = context.data.session.get(sessionID);
    const window = windowInfo(sessionID);
    const found = meters.get(sessionID);
    if (!found) void seed(sessionID);
    const created = session?.time?.created;
    const parts = [
      contextSegment(window.tokens, contextLimit(window.model ?? session?.model, sessionLocation(sessionID))),
      cacheSegment(window.tokens),
      speedSegment(found ? speedView(found, now) : undefined),
      diffSegment(diffStat(sessionID, now)),
      timeSegment(typeof created === "number" && created > 0 ? now - created : undefined),
    ];
    return parts.filter((part): part is Segment => part !== undefined);
  };

  const currentSession = (): string | undefined => {
    const route = context.ui.router.current();
    return route.type === "session" ? route.sessionID : undefined;
  };

  const StatusLine = () => {
    const dimensions = useTerminalDimensions();
    const runs = createMemo(() => {
      try {
        version();
        const sessionID = currentSession();
        if (!sessionID) return [];
        const width = Math.max(1, dimensions().width - PADDING.left - PADDING.right);
        return fitLine(segments(sessionID, Date.now()), width);
      } catch (error) {
        // Same insurance as `safely`: a bug here hides the line, never the session.
        warn("render failed", error);
        return [];
      }
    });
    // A span takes its colour through `style`: @opentui/solid drops a bare `fg` prop on spans.
    return (
      <Show when={runs().length > 0}>
        <box
          flexDirection="row"
          flexShrink={0}
          minHeight={1 + PADDING.bottom}
          paddingLeft={PADDING.left}
          paddingRight={PADDING.right}
          paddingBottom={PADDING.bottom}
        >
          <text wrapMode="none">
            {runs().map((run) => (
              <span style={{ fg: run.fg }}>{run.text}</span>
            ))}
          </text>
        </box>
      </Show>
    );
  };

  const disposeSlot = context.ui.slot({ append: "app", render: () => <StatusLine /> });

  return () => {
    disposeSlot();
    for (const stop of stops) stop();
    if (ticker) clearInterval(ticker);
    clearInterval(heartbeat);
  };
}

export default Plugin.define({ id: TUI_PLUGIN_ID, setup });
