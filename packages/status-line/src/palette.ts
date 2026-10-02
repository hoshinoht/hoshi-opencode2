/**
 * Dusk Darker semantic roles for the status line. Hexes come from the
 * `dusk-darker` palette in the dotfiles' Starship config; the keys name what a
 * colour means on this line, not the swatch, so the mapping lives in one place.
 */
export const PALETTE = {
  /** Context window: bar fill, percentage and token count. Pink is primary. */
  context: "#FFB8D1",
  /** Context window at or above the warning threshold (yellow). */
  contextWarning: "#F4DA86",
  /** Context window at or above the critical threshold (red). */
  contextCritical: "#FF8F9A",
  /** Cache-hit percentage and cached tokens (lavender). */
  cache: "#B0BCE8",
  /** Live sliding speed at or above the slow threshold (teal). */
  speedFast: "#78E1D0",
  /** Live sliding speed below the slow threshold (peach). */
  speedSlow: "#DDA05C",
  /** Live turn average (subtext0). */
  average: "#C9CAD6",
  /** A held or settled reading: history, not a live figure (overlay0). */
  held: "#6D707A",
  /** Uncommitted changes, both sides: sky is Git (never green/red). */
  vcs: "#8BD3FF",
  /** Elapsed session time, secondary timing (overlay1). */
  elapsed: "#898B95",
  /** Labels, glyphs, units and segment separators (overlay0). */
  label: "#6D707A",
  /** The context gauge's empty track (surface2). */
  rule: "#5D606A",
} as const;

export type Role = keyof typeof PALETTE;
