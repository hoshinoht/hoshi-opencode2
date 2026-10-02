import { describe, expect, test } from "bun:test";
import {
  active,
  beginStep,
  beginTurn,
  createMeter,
  cumulativeRate,
  dropStep,
  endStep,
  endTurn,
  formatRate,
  liveRate,
  observe,
  RATE,
  recordedSteps,
  restoreFinal,
  speedView,
  type Meter,
  type RecordedMessage,
  type RecordedStep,
} from "./rate.ts";

const T0 = 1_000_000;
const WINDOW = RATE.windowMs;

/** Feed `charsPerSecond` for `durationMs`, in 100 ms deltas. */
function stream(meter: Meter, start: number, durationMs: number, charsPerSecond: number): number {
  let now = start;
  for (let elapsed = 0; elapsed < durationMs; elapsed += 100) {
    now = start + elapsed + 100;
    observe(meter, now, charsPerSecond / 10);
  }
  return now;
}

describe("sliding rate", () => {
  test("converts streamed characters at the seed ratio", () => {
    const meter = createMeter();
    const now = stream(meter, T0, 4_000, 100); // 100 chars/s = 25 tok/s
    expect(Math.abs(liveRate(meter, now)! - 25)).toBeLessThan(1.5);
  });

  test("goes quiet once the window is empty", () => {
    const meter = createMeter();
    const now = stream(meter, T0, 1_000, 400);
    expect(liveRate(meter, now)).toBeDefined();
    expect(liveRate(meter, now + WINDOW + 1)).toBeUndefined();
    expect(active(meter, now + WINDOW + 1)).toBe(false);
  });
});

describe("cumulative rate", () => {
  test("folds the turn's exact steps with the step in flight", () => {
    const meter = createMeter();
    beginTurn(meter, T0);
    beginStep(meter, "a", T0, T0);
    stream(meter, T0 + 1_000, 2_000, 200); // 400 chars, first token T0+1100
    endStep(meter, "a", 160, T0 + 3_100, T0 + 3_100); // 2 s decode → ratio 2.5 → 3.55
    beginStep(meter, "b", T0 + 3_200, T0 + 3_200);
    stream(meter, T0 + 3_300, 1_000, 200); // 200 chars, first token T0+3400
    // (160 exact + 200/3.55 estimated) / (2000 ms + 1000 ms) ≈ 72.1
    expect(Math.abs(cumulativeRate(meter, T0 + 4_400)! - 72.1)).toBeLessThan(1);
  });

  test("stays live through a step whose deltas are not observable", () => {
    const meter = createMeter();
    beginTurn(meter, T0);
    beginStep(meter, "a", T0, T0);
    stream(meter, T0 + 1_000, 1_000, 400);
    endStep(meter, "a", 100, T0 + 2_100, T0 + 2_100); // 100 tokens in 1 s
    beginStep(meter, "b", T0 + 2_200, T0 + 2_200); // tool step: no deltas arrive
    expect(cumulativeRate(meter, T0 + 3_200)).toBeCloseTo(50, 5);
  });

  test("stays silent without a step in flight", () => {
    expect(cumulativeRate(createMeter(), T0)).toBeUndefined();
  });
});

describe("step settlement", () => {
  test("yields the exact rate and steers the estimate", () => {
    const meter = createMeter();
    beginStep(meter, "msg", T0, T0);
    stream(meter, T0 + 1_000, 2_000, 200); // 400 chars, first token T0+1100
    expect(endStep(meter, "msg", 160, T0 + 3_100, T0 + 3_100)).toBeCloseTo(80, 5); // TTFT excluded
    expect(meter.charsPerToken).toBeCloseTo(3.55, 5); // 400/160 = 2.5; EMA from 4
  });

  test("the exact span starts at the first token, not the step", () => {
    const meter = createMeter();
    beginStep(meter, "msg", T0, T0);
    stream(meter, T0 + 5_000, 1_000, 100);
    expect(endStep(meter, "msg", 100, T0 + 6_100, T0 + 6_100)).toBeCloseTo(100, 5);
  });

  test("falls back to arrival times when the event clock is unusable", () => {
    const meter = createMeter();
    beginStep(meter, "msg", 0, T0);
    expect(endStep(meter, "msg", 100, 0, T0 + 2_000)).toBeCloseTo(50, 5);
  });

  test("settles a tiny step instead of discarding it", () => {
    const meter = createMeter();
    beginStep(meter, "msg", T0, T0);
    stream(meter, T0, 100, 40); // first token T0+100
    expect(endStep(meter, "msg", 5, T0 + 183, T0 + 183)).toBeCloseTo(60.24, 1);
  });

  test("ignores nonsense durations and missing steps", () => {
    const meter = createMeter();
    beginStep(meter, "msg", T0, T0);
    expect(endStep(meter, "msg", 100, T0 + 10, T0 + 10)).toBeUndefined();
    beginStep(meter, "msg", T0, T0);
    expect(endStep(meter, "msg", 100, T0 + 7_200_000, T0)).toBeUndefined();
    expect(endStep(meter, "other", 100, T0 + 2_000, T0)).toBeUndefined();
  });

  test("a failed step stops counting as in flight", () => {
    const meter = createMeter();
    beginStep(meter, "msg", T0, T0);
    dropStep(meter, "other");
    expect(meter.step).toBeDefined();
    dropStep(meter, "msg");
    expect(meter.step).toBeUndefined();
  });
});

describe("turn fold", () => {
  test("weights a turn's steps into one figure", () => {
    const meter = createMeter();
    beginTurn(meter, T0);
    beginStep(meter, "a", T0, T0);
    stream(meter, T0 + 1_000, 1_000, 400);
    endStep(meter, "a", 100, T0 + 2_100, T0 + 2_100); // 100 tokens in 1 s
    beginStep(meter, "b", T0 + 2_200, T0 + 2_200);
    stream(meter, T0 + 2_300, 1_000, 400);
    endStep(meter, "b", 200, T0 + 3_400, T0 + 3_400); // 200 tokens in 1 s
    expect(meter.final?.tps).toBeCloseTo(150, 5); // 300 tokens over 2 s
    endTurn(meter, T0 + 3_500);
    expect(meter.final?.tps).toBeCloseTo(150, 5);
    expect(meter.turn).toEqual({ tokens: 0, ms: 0 });
  });

  test("closing a turn twice keeps its figure", () => {
    const meter = createMeter();
    beginTurn(meter, T0);
    beginStep(meter, "a", T0, T0);
    stream(meter, T0 + 1_000, 1_000, 400);
    endStep(meter, "a", 100, T0 + 2_100, T0 + 2_100);
    endTurn(meter, T0 + 2_200); // execution.succeeded
    endTurn(meter, T0 + 2_300); // session.idle late belt
    expect(meter.final).toEqual({ tps: 100, at: T0 + 2_200 });
  });

  test("a missed turn end is closed when the next turn begins", () => {
    const meter = createMeter();
    beginTurn(meter, T0);
    beginStep(meter, "a", T0, T0);
    stream(meter, T0 + 1_000, 1_000, 400);
    endStep(meter, "a", 100, T0 + 2_100, T0 + 2_100);
    beginTurn(meter, T0 + 5_000);
    expect(meter.final?.at).toBe(T0 + 5_000);
    expect(meter.turn).toEqual({ tokens: 0, ms: 0 });
    // The next turn's average does not absorb the previous one.
    beginStep(meter, "b", T0 + 5_100, T0 + 5_100);
    stream(meter, T0 + 5_100, 1_000, 800);
    // 800 chars ÷ 4 = 200 tokens over the 0.9 s since the first token, nothing carried over.
    expect(cumulativeRate(meter, T0 + 6_100)).toBeCloseTo(222.2, 0);
  });
});

describe("resume seed", () => {
  const step = (tokens: number, at: number, endedAt: number): RecordedStep => ({ tokens, at, endedAt });
  const message = (over: Partial<RecordedMessage> = {}): RecordedMessage => ({
    type: "assistant",
    time: { created: T0, completed: T0 + 3_000 },
    tokens: { output: 100 },
    content: [{ type: "reasoning", time: { created: T0 + 1_000, completed: T0 + 2_900 } }],
    ...over,
  });

  test("reads only the last turn's completed messages, oldest first", () => {
    const messages: RecordedMessage[] = [
      { type: "user", time: { created: T0 - 100_000 } },
      message({ time: { created: T0 - 99_000, completed: T0 - 90_000 }, tokens: { output: 500 } }),
      { type: "user", time: { created: T0 } },
      message({ time: { created: T0 + 100, streamed: T0 + 2_950, completed: T0 + 3_000 } }),
      { type: "shell", time: { created: T0 + 3_050 } },
      message({
        time: { created: T0 + 3_100, completed: T0 + 4_100 },
        tokens: { output: 50, reasoning: 50 },
        content: [{ type: "reasoning", time: { created: T0 + 3_200, completed: T0 + 4_000 } }],
      }),
    ];
    expect(recordedSteps(messages)).toEqual([
      { tokens: 100, at: T0 + 1_000, endedAt: T0 + 3_000 },
      { tokens: 100, at: T0 + 3_200, endedAt: T0 + 4_100 },
    ]);
  });

  test("skips messages without a completion or output; falls back to the message start", () => {
    const messages: RecordedMessage[] = [
      { type: "user", time: { created: T0 } },
      message(),
      message({ tokens: { output: 0, reasoning: 0 } }),
      message({ time: { created: T0 } }), // still streaming
      { type: "assistant", tokens: { output: 40 } },
      { type: "assistant", time: { created: T0, completed: T0 + 1_000 }, tokens: { output: 100 } },
    ];
    expect(recordedSteps(messages)).toEqual([
      { tokens: 100, at: T0 + 1_000, endedAt: T0 + 3_000 },
      { tokens: 100, at: T0, endedAt: T0 + 1_000 },
    ]);
  });

  test("the earliest reasoning part starts the span, not a tool", () => {
    const messages: RecordedMessage[] = [
      { type: "user", time: { created: T0 - 1 } },
      message({
        content: [
          { type: "reasoning", time: { created: T0 + 1_400 } },
          { type: "reasoning", time: { created: T0 + 1_200 } },
          { type: "tool", time: { created: T0 + 2_500 } },
        ],
      }),
    ];
    expect(recordedSteps(messages)).toEqual([{ tokens: 100, at: T0 + 1_200, endedAt: T0 + 3_000 }]);
  });

  test("refuses a tail with no user boundary", () => {
    expect(recordedSteps([message(), message()])).toBeUndefined();
    expect(recordedSteps([])).toBeUndefined();
  });

  test("restores the folded turn figure over a resting sliding reading", () => {
    const meter = createMeter();
    const steps = [step(100, T0, T0 + 1_000), step(200, T0 + 1_100, T0 + 2_600)];
    expect(restoreFinal(meter, steps, T0 + 3_000)).toBeCloseTo(120, 5); // 300 tokens over 2.5 s
    expect(meter.turn).toEqual({ tokens: 0, ms: 0 });
    expect(speedView(meter, T0 + 4_000)).toEqual({
      sliding: { tps: 0, live: false },
      average: { tps: 120, live: false },
    });
  });

  test("yields nothing when every recorded step is nonsense", () => {
    const meter = createMeter();
    expect(restoreFinal(meter, [], T0)).toBeUndefined();
    expect(restoreFinal(meter, [step(100, T0, T0 + 10), step(100, T0, T0 + 7_200_000), step(0, T0, T0 + 1_000)], T0)).toBeUndefined();
    expect(meter.final).toBeUndefined();
    expect(meter.sliding).toBeUndefined();
  });
});

describe("speedView", () => {
  test("both readings live while streaming", () => {
    const meter = createMeter();
    beginTurn(meter, T0);
    beginStep(meter, "msg", T0, T0);
    const now = stream(meter, T0, 1_000, 400);
    const view = speedView(meter, now);
    expect(view?.sliding?.live).toBe(true);
    expect(view?.average?.live).toBe(true);
  });

  test("holds the sliding reading after the stream stops, and settles the average", () => {
    const meter = createMeter();
    beginTurn(meter, T0);
    beginStep(meter, "msg", T0, T0);
    const now = stream(meter, T0, 1_000, 400);
    const held = liveRate(meter, now)!;
    endStep(meter, "msg", 100, T0 + 1_100, T0 + 1_100); // 100 tokens in 1 s
    const view = speedView(meter, T0 + 1_100 + WINDOW + 100);
    expect(view?.sliding).toEqual({ tps: held, live: false });
    expect(view?.average?.live).toBe(false);
    expect(view?.average?.tps).toBeCloseTo(100, 5);
  });

  test("a new turn keeps both figures until something newer arrives", () => {
    const meter = createMeter();
    beginTurn(meter, T0);
    beginStep(meter, "msg", T0, T0);
    stream(meter, T0, 1_000, 400);
    endStep(meter, "msg", 100, T0 + 1_100, T0 + 1_100);
    const later = T0 + 1_100 + WINDOW + 100;
    beginTurn(meter, later);
    const before = speedView(meter, later + 10);
    expect(before?.sliding?.live).toBe(false);
    expect(before?.average?.live).toBe(false);
    beginStep(meter, "next", later + 20, later + 20);
    const streaming = stream(meter, later + 1_000, 1_500, 400);
    expect(speedView(meter, streaming)?.sliding?.live).toBe(true);
  });

  test("an untouched meter shows nothing", () => {
    expect(speedView(createMeter(), T0)).toBeUndefined();
  });
});

test("formatRate draws a fixed three-character field", () => {
  expect(formatRate(8.34)).toBe("8.3");
  expect(formatRate(9.96)).toBe(" 10");
  expect(formatRate(47.2)).toBe(" 47");
  expect(formatRate(132.6)).toBe("133");
  expect(formatRate(1_234)).toBe(" 1K");
  for (const value of [0, 5.2, 9.9, 47, 198, 999, 1_000, 25_000]) expect(formatRate(value)).toHaveLength(3);
});
