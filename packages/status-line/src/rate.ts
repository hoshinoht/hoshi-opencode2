/**
 * The speed meter's maths, ported from opencode-status-line (MIT, Rashid
 * Razak): a sliding window for what is happening right now, a cumulative
 * average since the turn began, and the exact figures finished steps settle
 * with. A turn's steps fold into one weighted figure, so a tool-heavy turn
 * reports one number rather than a row of per-step figures. A finished turn's
 * figure can also be rebuilt from stored messages for a process that never saw
 * its events (a resume or a TUI restart).
 *
 * Pure and free of OpenCode imports so it can be tested directly. Unlike
 * upstream there are no options: turn folding and holding the last sliding
 * reading are always on, and the tuning constants are fixed.
 */

export const RATE = {
  /** How much streamed output the sliding estimate looks back over. */
  windowMs: 3_000,
  /** Shortest span trusted for a live figure, so the first second does not swing wildly. */
  minSpanMs: 800,
  /** Below this the meter is noise: a stray delta, or a model that has all but stalled. */
  minTps: 0.5,
  /** Character samples land in buckets of this size. */
  bucketMs: 100,
  /** Seed characters-per-token ratio, used until calibration has something to say. */
  charsPerToken: 4,
  /** Bounds for a calibration sample; one outside them is discarded. */
  ratioMin: 2.5,
  ratioMax: 7,
} as const;

/** Shortest decode span trusted: even a two-word answer deserves its figure. */
const MIN_STEP_MS = 50;
/** Longest decode span trusted; beyond this a clock is lying. */
const MAX_STEP_MS = 3_600_000;
/** A step needs this much streamed text before its ratio is worth calibrating from. */
const RATIO_MIN_CHARS = 40;
/** Exponential moving average weight given to a fresh ratio. */
const RATIO_WEIGHT = 0.3;

export interface Sample {
  /** Bucket start, aligned to RATE.bucketMs. */
  at: number;
  chars: number;
}

export interface Step {
  assistantMessageID: string;
  chars: number;
  /** Step start on the event clock. */
  at: number;
  /** Step start on the local clock, for when the event clock is unusable. */
  arrivedAt: number;
  /** First token-bearing chunk on the event clock; the decode span runs from here, so TTFT is not speed. */
  tokenAt?: number;
  /** First token-bearing chunk on the local clock, for the fallback span. */
  tokenArrivedAt?: number;
}

export interface Meter {
  /** Bucketed streamed characters, oldest first. */
  samples: Sample[];
  /** Start of the current run of activity; a pause longer than the window ends it. */
  streakStart: number;
  /** Arrival of the newest delta, so a stalled stream goes quiet. */
  lastDeltaAt: number;
  /** The step currently streaming, once `session.step.started` was seen. */
  step?: Step;
  /** Exact decode totals of the turn in flight: finished steps only. */
  turn: { tokens: number; ms: number };
  /** Estimated characters per token, calibrated from finished steps. */
  charsPerToken: number;
  /** Last settled turn figure, shown until something newer replaces it. */
  final?: { tps: number; at: number };
  /** Last live sliding reading, held (dimmed) after the stream stops. */
  sliding?: { tps: number; at: number };
}

export function createMeter(): Meter {
  return { samples: [], streakStart: 0, lastDeltaAt: 0, turn: { tokens: 0, ms: 0 }, charsPerToken: RATE.charsPerToken };
}

function prune(meter: Meter, now: number): void {
  const cutoff = now - RATE.windowMs;
  while (meter.samples.length > 0 && meter.samples[0]!.at < cutoff) meter.samples.shift();
}

/** Records `chars` of streamed output arriving at `now` (event clock optional). */
export function observe(meter: Meter, now: number, chars: number, eventNow?: number): void {
  if (chars <= 0) return;
  const at = Math.floor(now / RATE.bucketMs) * RATE.bucketMs;
  // A delta after silence starts a new streak: its rate is measured over what
  // has streamed since, never over the session's whole history.
  if (meter.lastDeltaAt === 0 || now - meter.lastDeltaAt > RATE.windowMs) meter.streakStart = at;
  const last = meter.samples[meter.samples.length - 1];
  if (last && last.at === at) last.chars += chars;
  else meter.samples.push({ at, chars });
  if (meter.step) {
    meter.step.chars += chars;
    meter.step.tokenAt ??= eventNow ?? now;
    meter.step.tokenArrivedAt ??= now;
  }
  meter.lastDeltaAt = now;
  prune(meter, now);
  // Snapshot the live reading while it is fresh: it is what the sliding figure
  // shows once the stream stops.
  const tps = liveRate(meter, now);
  if (tps !== undefined) meter.sliding = { tps, at: now };
}

/** Streamed characters over the window at the calibrated ratio; undefined once quiet for a window. */
export function liveRate(meter: Meter, now: number): number | undefined {
  prune(meter, now);
  if (now - meter.lastDeltaAt > RATE.windowMs || meter.samples.length === 0) return undefined;
  let chars = 0;
  for (const sample of meter.samples) chars += sample.chars;
  // A streak younger than the window is measured over its own age (with a
  // floor); an older one covers exactly one window.
  const span = Math.min(Math.max(now - meter.streakStart, RATE.minSpanMs), RATE.windowMs);
  const tps = chars / meter.charsPerToken / (span / 1000);
  return tps >= RATE.minTps ? tps : undefined;
}

/**
 * The turn average: exact tokens of this turn's finished steps plus the
 * estimated tokens of the step in flight, over the decode time they took.
 * Live only: it needs a step in flight.
 */
export function cumulativeRate(meter: Meter, now: number): number | undefined {
  const step = meter.step;
  if (!step) return undefined;
  // Tool-argument steps may expose no deltas, so the first-token marker never
  // lands; fall back to the step's arrival so the average stays on screen.
  const startedAt = step.tokenArrivedAt ?? step.arrivedAt;
  const tokens = meter.turn.tokens + step.chars / meter.charsPerToken;
  const ms = meter.turn.ms + Math.max(0, now - startedAt);
  if (ms < RATE.minSpanMs || tokens <= 0) return undefined;
  const tps = tokens / (ms / 1000);
  return tps >= RATE.minTps ? tps : undefined;
}

/** A step began streaming. The previous figure stays on screen until this one streams. */
export function beginStep(meter: Meter, assistantMessageID: string, at: number, arrivedAt: number): void {
  meter.step = { assistantMessageID, chars: 0, at, arrivedAt };
}

/**
 * A step finished with exact `tokens` of output (output + reasoning). Folds it
 * into the turn and returns the turn's weighted figure, or undefined when the
 * step is unknown or its span is nonsense.
 */
export function endStep(meter: Meter, assistantMessageID: string, tokens: number, endedAt: number, now: number): number | undefined {
  const step = meter.step;
  meter.step = undefined;
  if (!step || step.assistantMessageID !== assistantMessageID || tokens <= 0) return undefined;
  // Prefer the server clock for both ends; if those stamps are unusable, fall
  // back to arrival times — never mixed. The span starts at the first token.
  const eventMs = endedAt - (step.tokenAt ?? step.at);
  const arrivalMs = now - (step.tokenArrivedAt ?? step.arrivedAt);
  const ms = eventMs >= MIN_STEP_MS && eventMs <= MAX_STEP_MS ? eventMs : arrivalMs;
  if (ms < MIN_STEP_MS || ms > MAX_STEP_MS) return undefined;
  meter.turn.tokens += tokens;
  meter.turn.ms += ms;
  const tps = meter.turn.tokens / (meter.turn.ms / 1000);
  meter.final = { tps, at: now };
  if (step.chars >= RATIO_MIN_CHARS) {
    const ratio = step.chars / tokens;
    if (ratio >= RATE.ratioMin && ratio <= RATE.ratioMax) {
      meter.charsPerToken = meter.charsPerToken * (1 - RATIO_WEIGHT) + ratio * RATIO_WEIGHT;
    }
  }
  return tps;
}

/** A step failed: it will never settle, so stop counting it as in flight. */
export function dropStep(meter: Meter, assistantMessageID: string): void {
  if (meter.step?.assistantMessageID === assistantMessageID) meter.step = undefined;
}

/** A turn began: start a fresh fold, closing a turn whose end was missed. */
export function beginTurn(meter: Meter, now: number): void {
  if (meter.turn.ms > 0) endTurn(meter, now);
  meter.turn = { tokens: 0, ms: 0 };
  meter.step = undefined;
}

/** A turn ended: keep its figure. A second close finds an empty fold and does nothing. */
export function endTurn(meter: Meter, now: number): void {
  if (meter.turn.ms > 0) meter.final = { tps: meter.turn.tokens / (meter.turn.ms / 1000), at: now };
  meter.turn = { tokens: 0, ms: 0 };
  meter.step = undefined;
}

/** A completed step as the session record kept it. */
export interface RecordedStep {
  tokens: number;
  at: number;
  endedAt: number;
}

/** The bits of a stored session message the reconstruction reads. */
export interface RecordedMessage {
  type?: string;
  time?: { created?: number; streamed?: number; completed?: number };
  tokens?: { output?: number; reasoning?: number };
  content?: readonly { type?: string; time?: { created?: number; completed?: number } }[];
}

/**
 * The earliest point the record can place a step's first token: its first
 * reasoning timestamp. `time.streamed` is a finalisation stamp, text parts
 * carry no timing, and a tool part is stamped after its arguments streamed.
 */
export function firstTokenAt(message: RecordedMessage): number | undefined {
  let first: number | undefined;
  for (const part of message.content ?? []) {
    if (part?.type !== "reasoning") continue;
    const at = part.time?.created;
    if (typeof at === "number" && (first === undefined || at < first)) first = at;
  }
  return first;
}

/**
 * The last turn's completed steps, oldest first. Returns undefined when there
 * is no user message: the cache may hold only the newest page of a long
 * session, and folding its tail would report a figure no process measured.
 */
export function recordedSteps(messages: readonly RecordedMessage[]): RecordedStep[] | undefined {
  const steps: RecordedStep[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.type === "user") return steps.reverse();
    if (message?.type !== "assistant") continue;
    const started = firstTokenAt(message) ?? message.time?.created;
    const ended = message.time?.completed;
    const tokens = (message.tokens?.output ?? 0) + (message.tokens?.reasoning ?? 0);
    if (typeof started !== "number" || typeof ended !== "number" || tokens <= 0) continue;
    steps.push({ tokens, at: started, endedAt: ended });
  }
  return undefined;
}

/**
 * Rebuild a finished turn's settled figure from its recorded steps. The
 * sliding reading rests at zero: its samples are delta arrival times no record
 * keeps. The live fold stays empty so a later step cannot absorb a stale turn.
 */
export function restoreFinal(meter: Meter, steps: readonly RecordedStep[], now: number): number | undefined {
  let tokens = 0;
  let ms = 0;
  for (const step of steps) {
    const span = step.endedAt - step.at;
    if (step.tokens <= 0 || span < MIN_STEP_MS || span > MAX_STEP_MS) continue;
    tokens += step.tokens;
    ms += span;
  }
  if (tokens <= 0 || ms <= 0) return undefined;
  const tps = tokens / (ms / 1000);
  meter.final = { tps, at: now };
  meter.sliding = { tps: 0, at: now };
  return tps;
}

/** Whether the live window still has something worth redrawing. */
export function active(meter: Meter, now: number): boolean {
  return now - meter.lastDeltaAt <= RATE.windowMs;
}

export interface Reading {
  tps: number;
  /** False for a held or settled figure; the line dims those. */
  live: boolean;
}

/** What the speed segment shows: `↯` sliding and `μ` turn average, each live or held. */
export interface SpeedView {
  sliding?: Reading;
  average?: Reading;
}

/**
 * Sliding is live while the window has deltas, then the last reading is held.
 * The average is live while a step is in flight, then the settled turn figure.
 */
export function speedView(meter: Meter, now: number): SpeedView | undefined {
  const view: SpeedView = {};
  const live = liveRate(meter, now);
  if (live !== undefined) view.sliding = { tps: live, live: true };
  else if (meter.sliding) view.sliding = { tps: meter.sliding.tps, live: false };
  const average = cumulativeRate(meter, now);
  if (average !== undefined) view.average = { tps: average, live: true };
  else if (meter.final) view.average = { tps: meter.final.tps, live: false };
  return view.sliding || view.average ? view : undefined;
}

/**
 * `8.3`, ` 47`, `198`: a fixed three-character field, so the line never shifts
 * as the figure moves between digits.
 */
export function formatRate(tps: number): string {
  const tenths = Math.round(tps * 10) / 10;
  if (tenths < 10) return tenths.toFixed(1);
  const whole = Math.round(tenths);
  if (whole < 1_000) return String(whole).padStart(3, " ");
  return `${Math.round(whole / 1_000)}K`.padStart(3, " ");
}
