# Plugins

Local plugins live in `packages/`. Each is an `@hoshi-opencode2/*` package built on the OpenCode 2 plugin API (`@opencode/plugin`), licensed GPL-3.0-or-later, with its own `bun test src/` script. They do not work with OpenCode 1.

## Status

| Package | Registered in `opencode.json` | Summary |
|---|---|---|
| `reasoning-router` | yes | maps a subagent's requested effort class to provider reasoning effort |
| `openai-long-context` | yes | adds 1M-context `-1m` variants of OpenAI models |
| `usage-tracker` | yes | GitHub Copilot and OpenAI/Codex quota windows in the TUI |
| `shiori` adapter (`vendor/shiori/adapter/opencode`) | no (MCP used) | optional native adapter for the Go workplan core |
| `workplan-permissions` | yes | host role checks for Shiori MCP lifecycle calls |
| `workplan-tools` | no (rollback) | previous TypeScript engine |
| `cache-guard` | yes | advisory warning when an OpenAI prompt cache is likely going cold |
| `quota-fallback` | no | model failover on quota or rate-limit errors |
| `docs` | yes | pandoc document generation behind the `docs_*` tools |
| `subagent-control` | yes | `subagent_list` and `subagent_stop`, which let a parent see and interrupt its own child sessions |
| `image-budget` | no | keeps inline images in each model request under a count and byte budget |

`opencode.json` also registers third-party plugins (see [Third-party plugins](#third-party-plugins)) disables the built-in plan reminder with `"-opencode.plan"` (see [agents.md](agents.md#the-built-in-plan-reminder)), and turns off the built-in that adds skills from `~/.claude/skills` and `~/.agents/skills` with `"-opencode.config.compatibility"`. Claude syncs your claude.ai skills into `~/.claude/skills/synced/`; they are written for Claude's own tools and added 13 unusable entries (about 11 KB) to every agent's skill list. Only `skills/` in this directory is loaded.

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
- **Authorship:** OpenCode's agent permissions control tool access. `workplan-permissions` checks the trusted caller: only `plan` and `orchestrator` author plans, and only `orchestrator` writes checkpoints, applies compaction or recovers transactions.

A read-only structural checker is also available. It checks shape, not acceptance:

```sh
bun ~/.config/opencode/scripts/check-workplan.ts <absolute-project-root> <workplan-id>
```

**Replaced by Shiori.** The `workplan_*` tools are served by [Shiori](https://github.com/hoshinoht/shiori), vendored as `vendor/shiori`. Since 2026-10-07 this setup uses `shiori mcp` over stdio, with the same 13 tool names and compatible plan formats. Registration under `mcp.servers` in `opencode.json`:

```jsonc
"workplan": {
  "type": "local",
  "command": ["{env:HOME}/.config/opencode/vendor/shiori/shiori", "mcp", "--write-approval", "client"],
  "codemode": true,
  "disabled": false
}
```

Build the binary with `(cd vendor/shiori && CGO_ENABLED=0 go build -trimpath -o shiori ./cmd/shiori)`. OpenCode supplies each project's MCP root; no global project path is hard-coded. `codemode: true` makes the tools discoverable through Code Mode; `workplan-permissions` pins them so the direct `workplan_*` calls remain available too. The client authorizes tool calls; Shiori rechecks hashes and file preconditions under its locks. The native adapter is not registered.

The local `workplan-permissions` plugin wraps the existing MCP executors without registering additional tools. It restores role checks that the MCP server cannot perform because it receives no native agent identity, and limits the plan agent's new MCP resource read permission to server `workplan`.

**Switch back to the native adapter:** disable the `workplan` MCP server and register `{ "package": "./vendor/shiori/adapter/opencode", "options": { "bin": "{env:HOME}/.config/opencode/vendor/shiori/shiori" } }` in `plugins`, then restart OpenCode. Both interfaces use the same core and artifacts; register one at a time. To return to the older TypeScript engine, first resolve pending journals and move the evidence, lanes and links sidecars out of its plan directory; it does not understand those files. Its package is outside the root workspaces, so restoring it also requires adding the workspace and running `bun install`.

## cache-guard

Registered with `mode: "advisory"`, `riskAfterMinutes: 30` and `minCacheReadTokens: 10000`. When a session that earlier had a real OpenAI prompt-cache hit (at least `minCacheReadTokens` cached tokens) has been idle long enough that reuse is at risk, it warns. It is a heuristic: it does not detect actual expiry and gives no cost estimate. It also provides a `cache_guard_status` diagnostics tool and a `./tui` toast.

## quota-fallback (not registered)

On a quota or rate-limit error it moves the session to a fallback model and retries there. Each agent can name its preferred target with a `# fallback-model:` line under `model:`. A per-session circuit breaker stops failover loops, and it never switches back on its own. Add it to `plugins` in `opencode.json` to turn it on. It is also out of the root `package.json` workspaces, so add it back there and run `bun install` too.

## docs

The pandoc-based document generator that provides the `docs_*` tools used by `document-writer` and the `docs-workflow` skill. It is registered in `opencode.json` and exposes: `docs_draft`, `docs_list_drafts`, `docs_delete_draft`, `docs_compile`, `docs_create`, `docs_compile_latex`, `docs_convert`, `docs_presets_list`, `docs_presets_show`, `docs_templates_list` and `docs_templates_install`.

- Drafts live in `.opencode/docs/<id>/` with a `refs.bib` sidecar for references.
- Presets: `school-report`, `eisvogel`; add your own as YAML presets in the user pandoc dir.
- Venue papers are **not** a docs-plugin job: `scholar` writes them in native LaTeX with the official class (`IEEEtran`, `acmart`, ...).
- Citation handling is chosen with `citation_style`.
- Templates and logos ship inside the package: `packages/docs/pandoc/templates/{sit-uofg,eisvogel}` and `packages/docs/pandoc/assets/`. `~/.config/opencode/pandoc/` is an optional user override.

## subagent-control

Adds two tools for a parent's own children:

- `subagent_list({ running_only? })` lists the calling session's direct child sessions, running first then newest, with agent, title, running/idle state and the last turn's outcome. It reads each child's message history through the host (`session.context`, as `cache-guard` does): a running child shows what it is doing now (a tool such as `shell`, or a model response) and its last activity; an idle child shows when its last turn ended and whether its prompt cache has probably expired, with the context size a resume would re-write to the cache. The plugin context's session API has no list call, so this one discovers the local OpenCode service (`Service.discover`) and calls `session.list({ parentID })` and `session.active()`; it refuses if that service does not hold the calling session.
- `subagent_stop({ sessionID, reason? })` reads the target session and refuses unless its `parentID` is the calling session, so an agent can only stop the children it started; then it calls the host's session interrupt, the same call as the TUI's "Interrupt subagent" command. The child's current turn is aborted but its session is kept, so `subagent` with the same `sessionID` continues it.

Cache lifetimes are per provider, in minutes, and are timed from the start of the last model call:

```jsonc
{ "package": "./packages/subagent-control", "options": { "cacheTTLMinutes": { "anthropic": 5, "openai": 30 } } }
```

The defaults follow the providers' documentation: Anthropic caches for 5 minutes by default (1 hour is opt-in, and OpenCode's default Anthropic cache policy does not request it), measured from the start of the request; OpenAI GPT-5.6+ keeps a prefix for at least 30 minutes after its last write or reuse. Both refresh on every use. Providers not listed, such as GitHub Copilot, which documents no lifetime, get no cache note. A cold resume re-writes the whole context at the cache-write price (1.25x base input on both providers, against 0.1x or less for a cache read), which is usually still cheaper than a fresh child redoing the work.

Only `build` and `orchestrator` are allowed these tools ([permissions.md](permissions.md)); the other ask-by-default agents deny them explicitly.

## image-budget (not registered)

Every image a session has seen (a `read` of a screenshot, an MCP screenshot, a pasted image) is re-sent as base64 on every turn, so long visual-check sessions, typically `frontend-engineer` and `orchestrator`, eventually exceed a request limit and every later request fails. The tightest limit here is the 10 MiB request-body cap hard-coded in `@ex-machina/opencode-anthropic-auth` ([issue #277](https://github.com/ex-machina-co/opencode-anthropic-auth/issues/277)); the Anthropic API itself allows 32 MB.

The plugin's `context` and `generate` hooks count the inline images in the outgoing request. While they fit the budget nothing changes. Once they do not, the oldest are replaced with a one-line note (with the file path to read again, when the tool call names one) until the newest fit in `pruneTo` of the budget, and older copies of a kept image are dropped. Pruned images stay pruned for the rest of the session, so the prompt prefix, and its cache, changes only on the turn a prune happens. The `compaction` hook removes every image from a summary request. Only the outgoing request changes; the stored session keeps the images. It applies to every agent and is a no-op until the budget is exceeded, so a session that is already failing recovers on its next request.

```jsonc
{ "package": "./packages/image-budget",
  "options": { "maxImages": 12, "maxImageBytes": "6MiB", "pruneTo": 0.5,
               "providers": { "anthropic": { "maxImageBytes": "6MiB" } } } }
```

The values shown are the defaults (`providers` is empty by default). Sizes are base64 bytes and accept a number or a string such as `"512KB"` or `"6MiB"` (binary units). The budget covers images only; leave headroom under the provider limit for text. Decisions are logged as `[image-budget] <session> (<agent>): request now omits N image(s)`.

## Third-party plugins

OpenCode installs these npm packages on first start.

- **[opencode-anthropic-auth](https://github.com/ex-machina-co/opencode-anthropic-auth)** (`@ex-machina/opencode-anthropic-auth@next`) signs Anthropic requests with a Claude subscription. It rejects request bodies over 10 MiB ([issue #277](https://github.com/ex-machina-co/opencode-anthropic-auth/issues/277)), which is why [image-budget](#image-budget) exists.
- **[opencode-notifier](https://github.com/mohak34/opencode-notifier)** (`@mohak34/opencode-notifier@latest`) raises a desktop popup and sound when a permission prompt waits, a session finishes, an error happens or the question tool fires. Alerts run in the terminal client, so `opencode run` and the Desktop/Web clients get none. It replaces OpenCode 2's built-in alerts, which `cli.json` turns off with `"-opencode.notifications"`. Settings live in `opencode-notifier.json` in this directory.
- **[Dynamic Context Pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)** (`@tarquinen/opencode-dcp@latest`) adds a `compress` tool that replaces a finished span of the conversation with a summary. On trial since 2026-10-05 with a narrow setup in `dcp.jsonc`: it runs only in primary sessions (`experimental.allowSubAgents` is off), so only `build`, `orchestrator`, `plan` and `scholar` are allowed `compress`; the automatic deduplication and error-purge strategies are off, because they rewrite earlier history whenever a file is re-read or a tool fails and so break the prompt cache; compression reminders start at 200k tokens and strong nudges at 450k (the defaults, 50k and 100k, sit below the orchestrator's median peak of about 330k); and `protectUserMessages` keeps your messages verbatim. Every compression still invalidates the cache from that point on. It updates itself unless the version is pinned. Keep it if orchestrator compactions drop without a clear fall in cache reads; otherwise remove it.

Present in `opencode.json` but commented out:

- **[cc-safety-net](https://github.com/kenryu42/cc-safety-net)** (`cc-safety-net@latest`) blocks destructive git and filesystem commands and reads of secrets (SSH keys, `.env`) by parsing what a command does, so wrapping a command or reordering its flags does not hide it. It inspects `shell` calls and other tool inputs. Keep the `@latest` spec: its installer and `doctor` match on it. After uncommenting, check that it is active with `npx -y cc-safety-net@latest doctor`; `/cc-safety-net` explains a block. Until then, only the `shell-guard` patterns in [permissions.md](permissions.md) stand between the implementers and destructive commands.

Not registered:

- **opencode-recall** (`~/opencode-recall`, session-history search) is V1-only: it uses `@opencode-ai/plugin` 1.x and indexes the V1 `session`/`part`/`message` tables, which OpenCode 2 stopped writing on 2026-09-04 (V2 stores sessions in `session_v2`/`session_message`). It needs a V2 port before it can be registered.
- **[opencode-pty](https://github.com/shekohex/opencode-pty)** (background and interactive PTY sessions). OpenCode 2.0.21 cannot load its `opencode-pty/v2` sub-entry (npm treats the spec as a GitHub shorthand and the install fails) and its default entry is V1-only; see [issue #67](https://github.com/shekohex/opencode-pty/issues/67). When it loads, note that its V2 entry does not check spawned commands against shell permission rules, and cc-safety-net sees only the `command` field, not `args`, so gate `pty_spawn` and `pty_write` with `ask` in `scripts/agent-permissions.yaml`.

## Related projects

- [gofetch-mcp](https://github.com/hoshinoht/gofetch-mcp) and [researcher-mcp](https://github.com/hoshinoht/researcher-mcp): MCP servers vendored as submodules under `mcps/`.
- [ats-tailor](https://github.com/hoshinoht/ats-tailor): resume-tailoring MCP used by the hidden `ats-tailor` agent; disabled by default (see [install](install.md)).
- [Shiori](https://github.com/hoshinoht/shiori): the workplan engine behind the `workplan_*` tools, vendored at `vendor/shiori`.
