import { describe, expect, test } from "bun:test";
import {
  bar,
  cacheSegment,
  contextColor,
  contextSegment,
  cutRuns,
  diffSegment,
  fitLine,
  joinSegments,
  runsWidth,
  SEPARATOR,
  speedSegment,
  timeSegment,
  type Run,
  type Segment,
} from "./line.ts";
import { PALETTE } from "./palette.ts";

const text = (runs: readonly Run[]): string => runs.map((run) => run.text).join("");
const seg = (id: Segment["id"], body: string): Segment => ({ id, runs: [{ text: body, fg: PALETTE.label }] });

describe("bar", () => {
  test("whole-cell line gauge, rule-coloured track", () => {
    expect(text(bar(0.5, 10, PALETTE.context))).toBe("━━━━━─────");
    const runs = bar(0.9, 4, PALETTE.contextCritical);
    expect(runs[0]).toEqual({ text: "━━━━", fg: PALETTE.contextCritical });
    expect(bar(0.25, 4, PALETTE.context)[1]).toEqual({ text: "───", fg: PALETTE.rule });
  });

  test("one cell shows as soon as anything is used; stays within its width", () => {
    expect(text(bar(0.01, 12, PALETTE.context))).toBe("━" + "─".repeat(11));
    expect(text(bar(2, 8, PALETTE.context))).toBe("━".repeat(8));
    expect(bar(0, 4, PALETTE.context)).toEqual([{ text: "────", fg: PALETTE.rule }]);
  });
});

describe("context segment", () => {
  test("pink, then warning yellow at 70%, critical red at 90%", () => {
    expect(contextColor(0.5)).toBe(PALETTE.context);
    expect(contextColor(0.7)).toBe(PALETTE.contextWarning);
    expect(contextColor(0.9)).toBe(PALETTE.contextCritical);
  });

  test("the gauge alone: the footer already prints count and percentage", () => {
    const segment = contextSegment({ input: 57_000 }, 100_000)!;
    expect(text(segment.runs)).toBe("━━━━━━━─────");
    expect(segment.runs[0]!.fg).toBe(PALETTE.context);
  });

  test("hidden without a declared window or without usage", () => {
    expect(contextSegment({ input: 1_500 }, undefined)).toBeUndefined();
    expect(contextSegment(undefined, 100_000)).toBeUndefined();
  });
});

test("cache segment: muted word label, lavender value", () => {
  const segment = cacheSegment({ input: 900, cache: { read: 571_800 } })!;
  expect(text(segment.runs)).toBe("cache 99.8%");
  expect(segment.runs[0]!.fg).toBe(PALETTE.label);
  expect(segment.runs[1]!.fg).toBe(PALETTE.cache);
  expect(cacheSegment(undefined)).toBeUndefined();
});

describe("speed segment", () => {
  test("live sliding is teal when fast, peach when slow; live average subtext0", () => {
    const fast = speedSegment({ sliding: { tps: 261, live: true }, average: { tps: 159, live: true } })!;
    expect(text(fast.runs)).toBe("↯ 261 μ 159 tok/s");
    expect(fast.runs[1]!.fg).toBe(PALETTE.speedFast);
    expect(fast.runs[4]!.fg).toBe(PALETTE.average);
    const slow = speedSegment({ sliding: { tps: 12, live: true } })!;
    expect(slow.runs[1]!.fg).toBe(PALETTE.speedSlow);
  });

  test("a stopped stream drops ↯ and dims the held average", () => {
    const held = speedSegment({ sliding: { tps: 40, live: false }, average: { tps: 30, live: false } })!;
    expect(text(held.runs)).toBe("μ 30 tok/s");
    expect(held.runs[1]!.fg).toBe(PALETTE.held);
    expect(held.runs.at(-1)).toEqual({ text: " tok/s", fg: PALETTE.label });
  });

  test("hidden with nothing to show", () => {
    expect(speedSegment(undefined)).toBeUndefined();
    expect(speedSegment({})).toBeUndefined();
    expect(speedSegment({ sliding: { tps: 0, live: false } })).toBeUndefined();
  });
});

test("diff segment is sky on both sides and drops a zero side", () => {
  expect(diffSegment({ added: 12, deleted: 3 })?.runs).toEqual([{ text: "+12 −3", fg: PALETTE.vcs }]);
  expect(text(diffSegment({ added: 0, deleted: 2_000_000 })!.runs)).toBe("−2.0M");
  expect(diffSegment({ added: 0, deleted: 0 })).toBeUndefined();
  expect(diffSegment(undefined)).toBeUndefined();
});

test("time segment wears overlay1", () => {
  expect(timeSegment(7_620_000)?.runs).toEqual([{ text: "2h07m", fg: PALETTE.elapsed }]);
  expect(timeSegment(undefined)).toBeUndefined();
});

describe("layout", () => {
  const all = [seg("context", "cccc"), seg("cache", "kkkk"), seg("speed", "ssss"), seg("diff", "dddd"), seg("time", "tttt")];

  test("separators are label-coloured and only sit between segments", () => {
    const runs = joinSegments([seg("context", "a"), { id: "cache", runs: [] }, seg("time", "b")]);
    expect(text(runs)).toBe(`a${SEPARATOR}b`);
    expect(runs[1]!.fg).toBe(PALETTE.label);
  });

  test("everything fits on a wide line", () => {
    expect(runsWidth(fitLine(all, 200))).toBe(5 * 4 + 4 * SEPARATOR.length);
  });

  test("narrow lines drop time, then cache, then diff", () => {
    expect(text(fitLine(all, 4 * 4 + 3 * 3))).toBe("cccc · kkkk · ssss · dddd");
    expect(text(fitLine(all, 3 * 4 + 2 * 3))).toBe("cccc · ssss · dddd");
    expect(text(fitLine(all, 2 * 4 + 3))).toBe("cccc · ssss");
  });

  test("cuts only as a last resort", () => {
    expect(text(fitLine(all, 8))).toBe("cccc · …");
  });

  test("cutRuns keeps colours and ends in an ellipsis", () => {
    const runs: Run[] = [{ text: "abc", fg: "#1" }, { text: "def", fg: "#2" }];
    expect(cutRuns(runs, 6)).toEqual(runs);
    expect(cutRuns(runs, 5)).toEqual([{ text: "abc", fg: "#1" }, { text: "d…", fg: "#2" }]);
    expect(cutRuns(runs, 0)).toEqual([]);
  });
});
