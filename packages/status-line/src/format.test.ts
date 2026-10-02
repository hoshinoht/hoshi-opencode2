import { describe, expect, test } from "bun:test";
import { cacheShare, compact, contextUsed, diffTotals, duration } from "./format.ts";

describe("compact", () => {
  test("whole numbers below a thousand, one decimal above", () => {
    expect(compact(0)).toBe("0");
    expect(compact(999.4)).toBe("999");
    expect(compact(1_000)).toBe("1.0K");
    expect(compact(572_700)).toBe("572.7K");
    expect(compact(1_200_000)).toBe("1.2M");
  });
});

describe("duration", () => {
  test("seconds, minutes and hours", () => {
    expect(duration(45_000)).toBe("45s");
    expect(duration(724_000)).toBe("12m04s");
    expect(duration(7_620_000)).toBe("2h07m");
  });

  test("clamps negative spans", () => {
    expect(duration(-5_000)).toBe("0s");
  });
});

describe("token readings", () => {
  test("context sums every side of the window", () => {
    expect(contextUsed({ input: 900, output: 600, reasoning: 100, cache: { read: 571_800, write: 400 } })).toBe(573_800);
    expect(contextUsed(undefined)).toBe(0);
  });

  test("cache share is the read side over everything used", () => {
    expect(cacheShare({ input: 900, cache: { read: 571_800 } })).toBeCloseTo(0.998, 3);
    expect(cacheShare({})).toBeUndefined();
    expect(cacheShare(undefined)).toBeUndefined();
  });
});

describe("diffTotals", () => {
  test("sums additions and deletions across files", () => {
    expect(diffTotals([{ additions: 12, deletions: 3 }, { additions: 1, deletions: 0 }])).toEqual({ added: 13, deleted: 3 });
  });

  test("a missing list or an unmeasured file counts nothing", () => {
    expect(diffTotals(undefined)).toEqual({ added: 0, deleted: 0 });
    expect(diffTotals([{ additions: Number.NaN, deletions: Number.POSITIVE_INFINITY }])).toEqual({ added: 0, deleted: 0 });
    expect(diffTotals([{ additions: 2 }])).toEqual({ added: 2, deleted: 0 });
  });
});
