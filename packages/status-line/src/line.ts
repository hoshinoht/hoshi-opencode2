/**
 * The line's segments as coloured runs, and the narrow-width policy. Pure and
 * JSX-free so geometry and colour roles can be asserted without a terminal.
 */
import { cacheShare, compact, contextUsed, duration, type DiffStat, type TokenRecord } from "./format.ts";
import { PALETTE } from "./palette.ts";
import { formatRate, type SpeedView } from "./rate.ts";

export interface Run {
  text: string;
  fg: string;
}

export type SegmentID = "context" | "cache" | "speed" | "diff" | "time";

export interface Segment {
  id: SegmentID;
  runs: Run[];
}

/** Context-window share at which the bar turns warning yellow, then critical red. */
export const CONTEXT_WARN = 0.7;
export const CONTEXT_CRITICAL = 0.9;
/** Below this a live sliding figure reads slow (peach) rather than fast (teal). */
export const SLOW_TPS = 20;
/** Context bar cells: a thin line gauge, since the footer above already prints the numbers. */
export const BAR_WIDTH = 12;
/** OpenCode's footer separates its items with ` · `; the row continues that grammar. */
export const SEPARATOR = " · ";
/** Lowest priority first: what goes when the line does not fit. */
export const DROP_ORDER: readonly SegmentID[] = ["time", "cache", "diff"];

const FILL = "━";
const TRACK = "─";

const label = (text: string): Run => ({ text, fg: PALETTE.label });

/** `━━━━─────────`: whole cells, at least one filled once anything is used; the track wears the rule colour. */
export function bar(ratio: number, width: number, fg: string): Run[] {
  const clamped = Math.min(1, Math.max(0, ratio));
  const filled = clamped > 0 ? Math.min(width, Math.max(1, Math.round(clamped * width))) : 0;
  const runs: Run[] = [];
  if (filled > 0) runs.push({ text: FILL.repeat(filled), fg });
  if (filled < width) runs.push({ text: TRACK.repeat(width - filled), fg: PALETTE.rule });
  return runs;
}

/** Pink while there is room, yellow as it fills, red near the limit. */
export function contextColor(ratio: number): string {
  if (ratio >= CONTEXT_CRITICAL) return PALETTE.contextCritical;
  if (ratio >= CONTEXT_WARN) return PALETTE.contextWarning;
  return PALETTE.context;
}

/** The gauge alone: OpenCode's footer already shows the count and percentage. Hidden without a declared window. */
export function contextSegment(tokens: TokenRecord | undefined, limit: number | undefined): Segment | undefined {
  const used = contextUsed(tokens);
  if (used <= 0 || limit === undefined || limit <= 0) return undefined;
  const ratio = Math.min(1, used / limit);
  return { id: "context", runs: bar(ratio, BAR_WIDTH, contextColor(ratio)) };
}

/** `cache 99.8%`. */
export function cacheSegment(tokens: TokenRecord | undefined): Segment | undefined {
  const share = cacheShare(tokens);
  if (share === undefined) return undefined;
  return { id: "cache", runs: [label("cache "), { text: `${(share * 100).toFixed(1)}%`, fg: PALETTE.cache }] };
}

/**
 * `↯ 261 μ 159 tok/s` while streaming; `μ 159 tok/s` once it stops. The live
 * figure is teal (peach when slow) and only drawn while live; a held average is dimmed.
 */
export function speedSegment(view: SpeedView | undefined): Segment | undefined {
  const sliding = view?.sliding?.live ? view.sliding : undefined;
  const average = view?.average;
  if (!sliding && !average) return undefined;
  const runs: Run[] = [];
  if (sliding) {
    runs.push(label("↯ "), { text: formatRate(sliding.tps).trim(), fg: sliding.tps < SLOW_TPS ? PALETTE.speedSlow : PALETTE.speedFast });
  }
  if (average) {
    if (runs.length > 0) runs.push(label(" "));
    runs.push(label("μ "), { text: formatRate(average.tps).trim(), fg: average.live ? PALETTE.average : PALETTE.held });
  }
  runs.push(label(" tok/s"));
  return { id: "speed", runs };
}

/** `+12 −3` in sky; a zero side drops out and a clean tree draws nothing. */
export function diffSegment(stat: DiffStat | undefined): Segment | undefined {
  const parts: string[] = [];
  if (stat && stat.added > 0) parts.push(`+${compact(stat.added)}`);
  if (stat && stat.deleted > 0) parts.push(`−${compact(stat.deleted)}`);
  return parts.length > 0 ? { id: "diff", runs: [{ text: parts.join(" "), fg: PALETTE.vcs }] } : undefined;
}

/** `2h07m` since the session was created. */
export function timeSegment(elapsedMs: number | undefined): Segment | undefined {
  if (elapsedMs === undefined || !Number.isFinite(elapsedMs)) return undefined;
  return { id: "time", runs: [{ text: duration(elapsedMs), fg: PALETTE.elapsed }] };
}

export function runsWidth(runs: readonly Run[]): number {
  return runs.reduce((sum, run) => sum + run.text.length, 0);
}

/** The segments joined across one line with separators between. */
export function joinSegments(segments: readonly Segment[]): Run[] {
  const runs: Run[] = [];
  for (const segment of segments) {
    if (segment.runs.length === 0) continue;
    if (runs.length > 0) runs.push({ text: SEPARATOR, fg: PALETTE.label });
    runs.push(...segment.runs);
  }
  return runs;
}

/** Cut runs to `width` cells, ending in `…` when something had to go. */
export function cutRuns(runs: readonly Run[], width: number): Run[] {
  if (width <= 0) return [];
  const kept: Run[] = [];
  let used = 0;
  for (const run of runs) {
    const room = width - used;
    if (room <= 0) break;
    if (run.text.length <= room) {
      kept.push(run);
      used += run.text.length;
      continue;
    }
    kept.push({ ...run, text: room <= 1 ? "…" : `${run.text.slice(0, room - 1)}…` });
    break;
  }
  return kept;
}

/**
 * One row, never wrapped: drop whole low-priority segments (time, then cache,
 * then diff) until the rest fits, and cut only as a last resort.
 */
export function fitLine(segments: readonly Segment[], width: number): Run[] {
  let kept = segments.filter((segment) => segment.runs.length > 0);
  for (const id of DROP_ORDER) {
    if (runsWidth(joinSegments(kept)) <= width) break;
    kept = kept.filter((segment) => segment.id !== id);
  }
  return cutRuns(joinSegments(kept), width);
}
