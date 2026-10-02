/** Number formatting and token-record readings for the status line. Pure, so it can be tested directly. */

/** `572.7K`, `1.2M`: compact counts, cased like OpenCode's footer, with one decimal past a thousand. */
export function compact(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** `45s`, `12m04s`, `2h07m`: coarse by design; it is a glance, not a stopwatch. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** A message's token record, read defensively. */
export interface TokenRecord {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/** Everything the model reads back: prompt, generated, and both cache sides (OpenCode's own sum). */
export function contextUsed(tokens?: TokenRecord): number {
  if (!tokens) return 0;
  return (
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.reasoning ?? 0) +
    (tokens.cache?.read ?? 0) +
    (tokens.cache?.write ?? 0)
  );
}

/** How much of the window came from cache, or undefined when nothing was read. */
export function cacheShare(tokens?: TokenRecord): number | undefined {
  const used = contextUsed(tokens);
  return used > 0 ? (tokens?.cache?.read ?? 0) / used : undefined;
}

export interface DiffStat {
  added: number;
  deleted: number;
}

/**
 * Fold the host's per-file VCS status figures. A file it could not measure
 * (binary, past a read cap) arrives absent or non-finite and counts nothing.
 */
export function diffTotals(files: readonly { additions?: number; deletions?: number }[] | undefined): DiffStat {
  let added = 0;
  let deleted = 0;
  for (const file of files ?? []) {
    if (typeof file?.additions === "number" && Number.isFinite(file.additions)) added += file.additions;
    if (typeof file?.deletions === "number" && Number.isFinite(file.deletions)) deleted += file.deletions;
  }
  return { added, deleted };
}
