# hoshi-opencode2

A personal global configuration for **OpenCode 2**, kept in `~/.config/opencode`: custom agents, slash commands, skills, local V2 plugins and MCP server registrations.

It targets OpenCode 2 only and does not load OpenCode 1 plugins.

## Quick start

```sh
git clone --recurse-submodules git@github.com:hoshinoht/hoshi-opencode2.git ~/.config/opencode
cd ~/.config/opencode
bun install
make -C mcps/gofetch-mcp build
(cd mcps/researcher-mcp && go build -o bin/researcher-mcp ./cmd/google-scholar-mcp)
opencode mcp list
```

`bun install` is required: OpenCode 2 does not install local plugin dependencies. Secrets, requirements and details are in [docs/install.md](docs/install.md).

## How to work

| You want | Use | What happens |
|---|---|---|
| an everyday fix or question | `build` (default agent) | works directly; delegates only when it clearly helps |
| a feature or larger change | `/dev <request>` | `orchestrator` plans, delegates, reviews and verifies |
| a review of your diff | `/review` | adversarial review split across `code-checker` workers |
| to optimise a measurable number | `/autoresearch <goal + metric>` | `experimenter` iterates on an isolated branch, keeps or reverts each change |

Durable workplans are reserved for cross-session, multi-owner, migration or high-risk work. See [docs/workflows.md](docs/workflows.md).

## Agents

| Agent | Mode | Model |
|---|---|---|
| `build` | primary (default) | `openai/gpt-6.1-sol-1m#high` |
| `orchestrator` | primary | `openai/gpt-6.1-sol-1m#high` |
| `plan` | all | `openai/gpt-6.1-sol-1m#high` |
| `plan-checker` | subagent | `openai/gpt-6.1-sol-1m#high` |
| `explore` | subagent | `openai/gpt-6-luna#low` |
| `researcher` | subagent | `openai/gpt-5.6-terra-1m#medium` |
| `code-writer` | subagent | `openai/gpt-6-luna-1m#max` |
| `code-engineer` | subagent | `openai/gpt-5.6-terra-1m#high` |
| `frontend-engineer` | subagent | `openai/gpt-5.6-terra-1m#medium` |
| `tester` | subagent | `openai/gpt-6-luna#low` |
| `experimenter` | subagent | `openai/gpt-5.6-terra-1m#high` |
| `code-checker` | subagent | `openai/gpt-5.6-terra-1m#medium` |
| `oracle` | subagent | `openai/gpt-6-astra#low` |
| `document-writer` | subagent | `openai/gpt-5.6-terra-1m#medium` |
| `document-proofreader` | subagent | `openai/gpt-5.6-terra-1m#medium` |
| `scholar` | primary | `openai/gpt-5.6-terra-1m#high` |
| `ats-tailor` | primary (hidden) | `openai/gpt-5.6-terra-1m#high` |

Roles, built-in agent overrides and reasoning tiers: [docs/agents.md](docs/agents.md). Permissions are generated from one YAML file: [docs/permissions.md](docs/permissions.md).

## Commands

| Command | Agent | Purpose |
|---|---|---|
| `/dev` | orchestrator | plan, implement, validate and review a feature or fix |
| `/review` | orchestrator | adversarial review of recent changes |
| `/refactor` | orchestrator | refactor behind an intent gate, structural search and tests |
| `/init-deep` | orchestrator | generate hierarchical `AGENTS.md` files |
| `/handoff` | build | write a handoff summary for another session |
| `/remove-ai-slops` | build | strip AI-generated slop without changing behaviour |
| `/autoresearch` | experimenter | bounded metric-driven experiment loop on an `autoresearch/<tag>` branch |

`/usage` comes from the `usage-tracker` plugin, not from `commands/`.

## Skills

- `agent-use`: routing, scoping and acceptance evidence for delegation
- `workflow-plan` / `workflow-execute`: durable workplans and their execution
- `docs-workflow`: the `docs_*` tool flow, presets, `refs.bib`, citation styles
- `git-commit`: commit conventions, granularity and branch safety
- `ast-grep`: search and rewrite by syntax tree
- `property-based-testing`: generative and property-based tests
- `shell-strategy`: non-interactive, distro-aware shell use
- `frontend-design` / `frontend-design-studio`: frontend UX and visual direction
- `metric-loop`: keep-or-revert experiment loop against a mechanical metric
- `logo-design`: logo and brand-mark design with SVG audit/render/export scripts (lightweight adaptation of [logo-design-skill](https://github.com/kaankiziltug/logo-design-skill), MIT)

## Plugins

Local packages in `packages/`, all `@hoshi-opencode2/*`:

| Package | Status |
|---|---|
| `reasoning-router` | active: maps effort classes to provider reasoning effort |
| `openai-long-context` | active: adds `-1m` long-context model variants |
| `usage-tracker` | active: Copilot and OpenAI/Codex quota view (`/usage`) |
| `workplan-tools` | active: durable workplan tools; to be replaced by [Shiori](https://github.com/hoshinoht/shiori) |
| `cache-guard` | active: advisory prompt-cache idle warning |
| `quota-fallback` | present, not registered |
| `docs` | active: pandoc reports and styled PDFs (`docs_*` tools) |

Details: [docs/plugins.md](docs/plugins.md).

## MCP servers

| Server | Type | Purpose |
|---|---|---|
| `gofetch` | local | preferred web search and page/PDF fetch |
| `researcher-mcp` | local | scholarly search and full text |
| `context7` | remote | library documentation |
| `deepwiki` | remote | repository wiki Q&A |
| `grep_app` | remote | public code search |
| `lsp-tools` | local | language-server tooling |
| `ats-tailor` | local | resume tailoring (disabled by default) |

## Layout

```
agents/      agent prompts and frontmatter
commands/    slash commands
skills/      Agent Skills
packages/    local OpenCode 2 plugins
mcps/        gofetch-mcp, researcher-mcp (submodules), lsp-tools-mcp
scripts/     permission generator, workplan checker
tests/       config, permission and workplan tests
docs/        detailed documentation
opencode.json  server config      cli.json  TUI config
```

## Testing

```sh
bun test                                     # all repo + package suites (mcps/ excluded via bunfig.toml)
bun run typecheck                            # tsc --noEmit
bun scripts/gen-agent-permissions.ts --check # permissions in sync
```


## License

GPL-3.0-or-later; see [LICENSE](LICENSE). Bundled third-party components keep their own licenses, listed in [NOTICE](NOTICE).
