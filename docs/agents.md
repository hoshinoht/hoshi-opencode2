# Agents

Each user-facing agent is one Markdown file in `agents/`. Its frontmatter is the only place its model, mode and permissions are defined, and its body is its prompt.

## Roster

| Agent | Mode | Model | Role |
|---|---|---|---|
| `build` | primary (default) | `openai/gpt-6.1-sol-1m#high` | direct-first everyday development |
| `orchestrator` | primary | `openai/gpt-6.1-sol-1m#high` | plans, delegates, integrates and verifies larger changes |
| `plan` | all | `openai/gpt-6.1-sol-1m#high` | concise approach by default; durable workplans when warranted |
| `plan-checker` | subagent | `openai/gpt-6.1-sol-1m#high` | reviews workplans, specs, handoffs and workflow risk |
| `explore` | subagent | `openai/gpt-6-luna#low` | fast read-only locator for files, config and code |
| `researcher` | subagent | `openai/gpt-5.6-terra-1m#medium` | literature reviews; read-only codebase access |
| `code-writer` | subagent | `openai/gpt-6-luna-1m#max` | docs-first scoped implementation, one step at a time |
| `code-engineer` | subagent | `openai/gpt-5.6-terra-1m#high` | implementation that needs bounded judgment |
| `frontend-engineer` | subagent | `openai/gpt-5.6-terra-1m#medium` | UI structure, accessibility, responsiveness, visuals |
| `tester` | subagent | `openai/gpt-6-luna#low` | runs the requested tests and smoke checks; never fixes |
| `experimenter` | subagent | `openai/gpt-5.6-terra-1m#high` | `metric-loop` experiments in an `autoresearch/<tag>` worktree; never merges or pushes |
| `code-checker` | subagent | `openai/gpt-5.6-terra-1m#medium` | independent review for correctness, spec fit and smells |
| `oracle` | subagent | `openai/gpt-6-astra#low` | last-resort read-only architecture and debugging advice |
| `document-writer` | subagent | `openai/gpt-5.6-terra-1m#medium` | documents through the docs toolchain |
| `document-proofreader` | subagent | `openai/gpt-5.6-terra-1m#medium` | academic proofreading; feedback only, no edits |
| `scholar` | primary | `openai/gpt-5.6-terra-1m#high` | scholarly research, verified BibTeX, LaTeX drafting and proofreading |
| `ats-tailor` | primary (hidden) | `openai/gpt-5.6-terra-1m#high` | resume tailoring through the `ats-tailor` MCP (disabled by default) |

The `-1m` model IDs are the long-context variants added by the `openai-long-context` plugin.

## Commented model lines

Most agents carry commented lines under `model:`:

- `# model: ...` records an alternative (usually Anthropic) to switch to by hand.
- `# fallback-model: ...` is read by the `quota-fallback` plugin as that agent's failover target. It is functional, not a comment to delete.

## Built-in agents

`opencode.json` configures only OpenCode's built-in helper agents:

| Built-in | Model |
|---|---|
| `general`, `compaction` | `openai/gpt-5.6-terra-1m#high` |
| `summary`, `title` | `openai/gpt-6-luna#low` |

The root `model` is `openai/gpt-5.6-terra-1m`.

Do not also define a custom agent in `opencode.json`. OpenCode 2 appends permission rules from every source and the last matching rule wins, so a second definition quietly changes behaviour.

## Shared conventions (`AGENTS.md`)

Rules that every agent shares (precedence, authority by request type and how to ask questions, harness blocks, search and web routing, fresh-read and surgical edits, dirty worktree and git safety, bounded workplan reads, outcome-first reporting and the receipt pointer) live once in the repository-root [`AGENTS.md`](../AGENTS.md). Agent bodies and skills keep only their role and their deviations; do not copy those rules back into them. Each agent body is a short contract (role, completion bar, agent-specific constraints, output, stop rule). Procedure shared by several agents lives in a skill: `agent-use` for delegating agents (with rare detail in `references/delegation-details.md`) and `implementation` for `code-writer`, `code-engineer` and `frontend-engineer`.

How OpenCode 2 (checked on 2.0.20) delivers it:

- **Loading.** The builtin `opencode.config.instruction` plugin reads `<config dir>/AGENTS.md` as the global file (the config dir is `~/.config/opencode`, see `opencode debug paths`), then every `AGENTS.md` from the working directory up toward home. Nested files found later are appended to history as they are discovered. V2 reads `AGENTS.md` only, not `CLAUDE.md`. [v2 instructions docs](https://opencode.ai/v2/docs/instructions)
- **The `instructions` config key is not an option.** V2 still accepts `instructions` in `opencode.json` but does not load its entries ([v2 config docs](https://opencode.ai/v2/docs/config): "OpenCode accepts this field but does not load its entries; use `AGENTS.md` for instructions"). The only file source in the instruction-discovery service is the `AGENTS.md` walk, so `opencode.json` is deliberately left without an `instructions` entry.
- **Who receives it.** Session context assembles, for every session, the Code Mode catalog, MCP server instructions, references, the skills list, discovered `AGENTS.md` files, date and environment, and API-managed instruction entries. Subagent child sessions go through the same path, so every custom agent and the builtin `general`/`explore` receive it. The hidden `compaction` agent receives it too: compaction requests carry the session's initial instructions. `title` does not: its request is the title agent's own prompt plus the conversation excerpt. The hidden `summary` agent is registered, but no 2.0.20 code path invoking it was found.
- **Cost.** About 780 words (~1,000 tokens) per session and per compaction call. It sits in the stable prefix, so provider prompt caching absorbs most of the repeat cost; keep the file compact anyway.
- **Custom prompts replace the base prompt.** The request's first system block is the agent's own prompt when it has one, otherwise OpenCode's generic `system.txt`. The provider prompt plugins (`opencode.prompt.openai`, `.anthropic`, `.kimi`, `.arcee`, `.meta`) rewrite or append to that block only for agents without a prompt. Every agent in `agents/` has a body, so none of them gets the generic or provider harness text (`<system-reminder>` semantics, parallel tool calls, dedicated tools over shell, treat unfamiliar changes as user work). `AGENTS.md` restates those points in provider-neutral form. `opencode.prompt.identity` still inserts the model identity block for every agent.

Evidence: the v2 docs linked above, and the bundled 2.0.20 source (`strings` on `@opencode/cli/bin/opencode.exe`: `ConfigInstructionPlugin`, `SessionContext.select`, `SessionTitle.attempt`, `OptimizePlugin.*`). Verify after an OpenCode upgrade.

## Reasoning-router policy

The `reasoning-router` plugin sets reasoning effort on child sessions. Its per-agent policy in `opencode.json` clamps whatever effort is requested, and it must be kept in step with the `#variant` on each agent's `model:` line.

| Agent | OpenAI (def / min / max) | Anthropic (def / min / max) |
|---|---|---|
| `explore` | low / low / medium | low / low / medium |
| `code-writer` | max / xhigh / max | medium / low / medium |
| `code-engineer` | high / medium / high | medium / medium / high |
| `frontend-engineer` | medium / medium / high | medium / low / medium |
| `tester` | - | low / low / medium |
| `researcher` | - | medium / low / medium |
| `document-writer` | - | medium / low / medium |
| `document-proofreader` | - | low / low / medium |
| `plan` | - | high / medium / high |
| `plan-checker` | - | medium / medium / high |
| `code-checker` | - | medium / low / high |
| `oracle` | - | medium / medium / medium |

A dash means no OpenAI policy is set for that agent.

## The built-in plan reminder

`"-opencode.plan"` in `plugins` turns off OpenCode's built-in plan-mode reminder. That reminder limits writes to `~/.opencode/plan`, which clashes with the custom `plan` agent writing `.opencode/workplan/` and `.opencode/docs/specs/` inside the project. `tests/agent-config.test.ts` checks that it stays disabled.

## Permissions

See [permissions.md](permissions.md). Never hand-edit a `permissions:` block.
