import { describe, expect, it } from "bun:test";
import { formatUsagePercent, usageBarSegments, usageBarWidth, usageDialogSize } from "./dashboard.ts";

describe("usage dashboard helpers", () => {
  it("rounds and clamps the textual percentage", () => {
    expect(formatUsagePercent(74.6)).toBe("75% used");
    expect(formatUsagePercent(130)).toBe("100% used");
    expect(formatUsagePercent(Number.NaN)).toBe("0% used");
  });

  it("creates a complete bar without losing its percentage", () => {
    expect(usageBarSegments(50, 8)).toEqual({ filled: "████", empty: "░░░░" });
    expect(usageBarSegments(-2, 4)).toEqual({ filled: "", empty: "░░░░" });
    expect(usageBarSegments(101, 4)).toEqual({ filled: "████", empty: "" });
  });

  it("shortens bars and dialog sizes for narrow terminals", () => {
    expect(usageBarWidth(50)).toBe(8);
    expect(usageBarWidth(80)).toBe(12);
    expect(usageBarWidth(100)).toBe(18);
    expect(usageBarWidth(140)).toBe(26);
    expect(usageDialogSize(80)).toBe("medium");
    expect(usageDialogSize(100)).toBe("large");
    expect(usageDialogSize(140)).toBe("xlarge");
  });
});
