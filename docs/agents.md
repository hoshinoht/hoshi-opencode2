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
