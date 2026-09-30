# Plugins

Local plugins live in `packages/`. Each is an `@hoshi-opencode2/*` package built on the OpenCode 2 plugin API (`@opencode/plugin`), licensed GPL-3.0-or-later, with its own `bun test src/` script. They do not work with OpenCode 1.

## Status

| Package | Registered in `opencode.json` | Summary |
|---|---|---|
| `reasoning-router` | yes | maps a subagent's requested effort class to provider reasoning effort |
| `model-presets` | yes | switches every agent's model between named presets; `active:` in `model-presets.yaml` selects one, applied live on save |
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

## model-presets

Switches every agent's model, including the built-in `general`, `compaction`, `summary` and `title` roles, between named presets. The preset in effect is chosen in the preset file itself (`active:`); there is no command and no hidden state. A preset can mix providers freely (local/ollama, qwen, openai, anthropic, opencode zen, openrouter, ...).

The presets live in `model-presets.yaml` at the config root, not in `opencode.json`. The registration only names the file, and the default is shown here:

```jsonc
{ "package": "./packages/model-presets", "options": { "file": "model-presets.yaml" } }
```

A relative `file` resolves against the config root, which is the directory that holds `packages/` (two levels above the package). Absolute and `~/` paths also work.

```yaml
active: openai             # the preset in effect; edit and save to switch
presets:
  openai: {}               # empty: agent frontmatter and opencode.json models unchanged
  anthropic:
    tiers:                 # optional aliases
      heavy: anthropic/claude-opus-5-5#high
      fast: anthropic/claude-haiku-4-5#low
    default: "@heavy"      # optional: agents not listed below; omit to leave them unchanged
    model: anthropic/claude-opus-5-5   # optional: global default model (root "model"); no #variant
    agents:
      explore: "@fast"
      code-writer: anthropic/claude-opus-5-5#medium
```

- **Model strings** are `provider/model` with an optional `#variant`. Only the first `/` splits, so `openrouter/anthropic/claude-x` works. `@name` refers to the preset's `tiers`. YAML needs quotes around `@` values (`"@heavy"`).
- **Selecting a preset:** set the top-level `active:` to a preset name and save. The old top-level `default:` is still accepted as a deprecated alias; if both are present, `active` wins (and `default` is not validated). Either case logs a one-time note.
- **Validation:** unknown keys and tiers, malformed model strings and an unknown `active` are all rejected with the file path, line and key path. Agent ids the server does not know are skipped with a warning.
- **Live apply:** the plugin watches the file's directory (so editors that save by renaming a temp file over it still trigger), debounces changes by about 300 ms, and ignores saves that do not change the content. On a valid change that affects the active preset it calls `ctx.agent.reload()`, plus the default-model reload when the preset's `model` changed; no restart is needed. The file is also re-read on every agent reload. If an edit is broken, the last good presets stay in effect and the error is logged with its `file:line:col` (in the opencode server log, prefixed `[model-presets]`). If the file has never loaded, agents keep their config models. The watcher is closed when the plugin unloads.
- **Feedback:** each applied switch logs `[model-presets] model preset: <name>`. The server plugin API (`@opencode/plugin` 2.0.20) has no session-less toast or notification (toasts exist only for TUI plugins), so there is no in-UI notice. `opencode api GET /api/agent` shows the effective per-agent models.
- **Scope:** a preset changes agent definitions. A session that has an explicit per-session model (set with a model switch) keeps that model.
- **Ordering:** the host applies `opencode.json` and `agents/*.md` models after user plugins. For its preset to win, the plugin registers its transforms again once `opencode.config.agent` and `opencode.config.provider` are active.
- **reasoning-router interplay:** the router overrides reasoning effort for the providers it has rules for (`openai`, `anthropic`), in child sessions of agents that have a policy. A preset's `#variant` is authoritative only for providers the router does not manage, and for agents without a router policy.

The seeded `anthropic` preset mirrors the commented `# model:` lines in `agents/*.md` and the commented `// "model":` lines in `opencode.json`. The seeded `opencode` preset mirrors the `# fallback-model:` lines.

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
