export interface UsageBarSegments {
  readonly filled: string;
  readonly empty: string;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function formatUsagePercent(value: number): string {
  return `${Math.round(clampPercent(value))}% used`;
}

export function usageBarSegments(value: number, width: number): UsageBarSegments {
  const safeWidth = Math.max(1, Math.floor(width));
  const filledCount = Math.round((clampPercent(value) / 100) * safeWidth);
  return {
    filled: "█".repeat(filledCount),
    empty: "░".repeat(safeWidth - filledCount),
  };
}

/** Keep quota labels and percentages readable before allocating columns to the bar. */
export function usageBarWidth(terminalWidth: number): number {
  if (terminalWidth < 64) return 8;
  if (terminalWidth < 84) return 12;
  if (terminalWidth < 112) return 18;
  return 26;
}

export function usageDialogSize(terminalWidth: number): "medium" | "large" | "xlarge" {
  if (terminalWidth >= 128) return "xlarge";
  if (terminalWidth >= 92) return "large";
  return "medium";
}
