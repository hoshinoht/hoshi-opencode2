# Plugins

Local plugins live in `packages/`. Each is an `@hoshi-opencode2/*` package built on the OpenCode 2 plugin API (`@opencode/plugin`), licensed GPL-3.0-or-later, with its own `bun test src/` script. They do not work with OpenCode 1.

## Status

| Package | Registered in `opencode.json` | Summary |
|---|---|---|
| `reasoning-router` | yes | maps a subagent's requested effort class to provider reasoning effort |
| `openai-long-context` | yes | adds 1M-context `-1m` variants of OpenAI models |
| `usage-tracker` | yes | GitHub Copilot and OpenAI/Codex quota windows in the TUI |
| `shiori` adapter (`vendor/shiori/adapter/opencode`) | yes | durable workplan lifecycle tools (Go core) |
| `workplan-tools` | no (rollback) | previous TypeScript engine |
| `cache-guard` | yes | advisory warning when an OpenAI prompt cache is likely going cold |
| `quota-fallback` | no | model failover on quota or rate-limit errors |
| `docs` | yes | pandoc document generation behind the `docs_*` tools |

`opencode.json` also registers one third-party plugin, `@ex-machina/opencode-anthropic-auth@next`, and disables the built-in plan reminder with `"-opencode.plan"` (see [agents.md](agents.md#the-built-in-plan-reminder)).

## reasoning-router

A parent starts a child task with a marker such as `[reasoning:fast]`; the classes are `fast`, `balanced` and `deep`, with `auto` as the default. The plugin translates the class into OpenAI `reasoningEffort` or Anthropic `effort` just before each model call. The per-agent policy in `opencode.json` clamps the result, so a request can never exceed an agent's cap. Only child sessions are routed. Keep the policy in step with each agent's `#variant` ([agents.md](agents.md#reasoning-router-policy)).

## openai-long-context

Adds an `<id>-1m` variant for OpenAI `gpt-5.6-*` and `gpt-6*` models, with a 1,000,000-token context window (872,000 input, 128,000 output). This is where the `-1m` model IDs in `agents/` come from.

## usage-tracker

A server plugin plus a `./tui` companion. `/usage`, or the command palette, shows GitHub Copilot and OpenAI/Codex quota windows fetched over V2 RPC; access tokens stay on the server and never reach the client. The provider endpoints it calls are undocumented and may change without notice.

## workplan-tools

Native V2 tools for durable workplans: `workplan_create`, `workplan_inspect`, `workplan_list`, `workplan_read`, `workplan_update`, `workplan_patch`, `workplan_checkpoint`, `workplan_resume`, `workplan_compact_preview`, `workplan_compact`, `workplan_reset`, `workplan_validate` and `workplan_doctor`.

- **Concurrency:** writes carry an `expectedHash`; a write against a stale hash is rejected instead of overwriting someone else's change.
- **Durability:** writes are atomic and journalled, so an interrupted write can be recovered.
- **Compaction:** `workplan_compact_preview` shows exactly what would be removed. Applying `workplan_compact` needs a fresh checkpoint and an explicit confirmation, and it archives the originals under `.opencode/workplan/archive/<id>/` first.
- **Resuming:** `workplan_resume` returns a bounded continuation packet for picking work back up in a new session.
- **Authorship:** only `plan` and `orchestrator` may create or change plans.

A read-only structural checker is also available. It checks shape, not acceptance:

```sh
bun ~/.config/opencode/scripts/check-workplan.ts <absolute-project-root> <workplan-id>
```

**Replaced by Shiori.** Since 2026-09-30 the `workplan_*` tools are served by [Shiori](https://github.com/hoshinoht/shiori), vendored as the `vendor/shiori` submodule: same 13 tools, arguments, file formats and hashes, with a Go core (`shiori serve --stdio`) behind a small adapter. Registration in `opencode.json`:

```jsonc
{ "package": "./vendor/shiori/adapter/opencode",
  "options": { "bin": "{env:HOME}/.config/opencode/vendor/shiori/shiori" } }
```

Build the binary with `(cd vendor/shiori && CGO_ENABLED=0 go build -trimpath -o shiori ./cmd/shiori)`. The adapter only accepts OpenCode versions it has been verified against; after an OpenCode upgrade, update Shiori first.

**Rollback:** run `workplan_doctor` (or `vendor/shiori/shiori doctor --root <project>`) and confirm there are no pending transactions, then swap the entry back to `{ "package": "./packages/workplan-tools" }`. Never register both.

## cache-guard

Registered with `mode: "advisory"`, `riskAfterMinutes: 30` and `minCacheReadTokens: 10000`. When a session that earlier had a real OpenAI prompt-cache hit (at least `minCacheReadTokens` cached tokens) has been idle long enough that reuse is at risk, it warns. It is a heuristic: it does not detect actual expiry and gives no cost estimate. It also provides a `cache_guard_status` diagnostics tool and a `./tui` toast.

## quota-fallback (not registered)

On a quota or rate-limit error it moves the session to a fallback model and retries there. Each agent can name its preferred target with a `# fallback-model:` line under `model:`. A per-session circuit breaker stops failover loops, and it never switches back on its own. Add it to `plugins` in `opencode.json` to turn it on.

## docs

The pandoc-based document generator that provides the `docs_*` tools used by `document-writer` and the `docs-workflow` skill. It is registered in `opencode.json` and exposes: `docs_draft`, `docs_list_drafts`, `docs_delete_draft`, `docs_compile`, `docs_create`, `docs_compile_latex`, `docs_convert`, `docs_presets_list`, `docs_presets_show`, `docs_templates_list` and `docs_templates_install`.

- Drafts live in `.opencode/docs/<id>/` with a `refs.bib` sidecar for references.
- Presets: `school-report`, `eisvogel`; add your own as YAML presets in the user pandoc dir.
- Venue papers are **not** a docs-plugin job: `scholar` writes them in native LaTeX with the official class (`IEEEtran`, `acmart`, ...).
- Citation handling is chosen with `citation_style`.
- Templates and logos ship inside the package: `packages/docs/pandoc/templates/{sit-uofg,eisvogel}` and `packages/docs/pandoc/assets/`. `~/.config/opencode/pandoc/` is an optional user override.

## Related projects

- [gofetch-mcp](https://github.com/hoshinoht/gofetch-mcp) and [researcher-mcp](https://github.com/hoshinoht/researcher-mcp): MCP servers vendored as submodules under `mcps/`.
- [ats-tailor](https://github.com/hoshinoht/ats-tailor): resume-tailoring MCP used by the hidden `ats-tailor` agent; disabled by default (see [install](install.md)).
- [Shiori](https://github.com/hoshinoht/shiori): the workplan engine behind the `workplan_*` tools, vendored at `vendor/shiori`.
