# status-line (OpenCode V2)

A one-row status line under the native OpenCode footer, continuing its ` · `
grammar in the Dusk Darker semantic colours:

```
━━━━━━━───── · cache 99.8% · ↯ 261 μ 159 tok/s · +42 −7 · 2h07m
```

From left to right:

- **Context window**: a line gauge only, since the footer above already prints
  the count and percentage. Pink normally, warning yellow at 70%, red at 90%.
- **Cache**: share of the window read from cache (lavender).
- **Speed**: `↯` is the live sliding-window rate (teal, or peach below
  20 tok/s), drawn only while a stream is live; `μ` is the turn's average,
  dimmed once the stream stops. On a resumed session, the last turn's average
  is rebuilt from the stored messages.
- **Uncommitted changes**: `+added −deleted` lines from OpenCode's VCS status
  (sky). No `git` command is run.
- **Elapsed time** since the session was created (overlay1).

Segments with nothing to show are hidden. On a narrow terminal, whole segments
are dropped in the order time, cache, then changes; the line never wraps.

## Install and configure

This is a TUI-only plugin, so it is loaded from `cli.json`, not
`opencode.json(c)`:

```jsonc
// cli.json
{
  "plugins": ["./packages/status-line"],
}
```

The host resolves `<package>/tui`, which re-exports `src/tui.tsx`. Options,
config files and palettes are deliberately absent; the thresholds and colours
are constants in `src/line.ts` and `src/palette.ts`. The speed meter
duplicates OpenCode's built-in `session.tps` display, so you may want to set
that to `false` in `cli.json`.

## Attribution and license

A lightweight port of the MIT-licensed `opencode-status-line` by Rashid Razak
(https://github.com/rashidrazak/opencode-status-line). The speed-meter logic
is adapted from it; its MIT notice is kept in `LICENSE.upstream`. Cost, the
running-shell count, configuration, palettes, multi-slot placement and the
statistics dialog were dropped. Licensed under GPL-3.0-or-later.
