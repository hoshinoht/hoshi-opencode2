# Permissions

Agent permissions are written once in `scripts/agent-permissions.yaml` and generated into each `agents/<name>.md` frontmatter. Do not edit the `permissions:` blocks by hand; the next generator run overwrites them.

## Evaluation order

OpenCode 2 evaluates permission rules **last match wins**. Put broad defaults first and narrower exceptions after them:

```yaml
- [shell, "*", allow]
- [shell, git push*, ask]   # later and more specific, so it wins for pushes
```

## Source format

```yaml
fragments:
  env-guard:
    - [read, "*.env", ask]
    - [read, "*.env.*", ask]
    - [read, "*.env.example", allow]
agents:
  researcher:
    - ["*", "*", deny]
    - "@core-read"
    - "@env-guard"
```

- A rule is `[action, resource, effect]`, where effect is `allow`, `ask` or `deny`.
- `"@name"` splices a fragment in at that exact position, so fragment order is preserved. Fragments can reference other fragments; unknown names and cycles are errors.
- Every file in `agents/` must have an entry under `agents:`.

### Default effect

Subagents start from `["*", "*", deny]` and allow what they use. A tool that is not denied (even one left at `ask`) is still offered to the model: OpenCode lists it in the agent's Code Mode tool catalog, which is sent with every request and again whenever the catalog changes. With an `ask` default, the implementers carried all `docs_*`, `researcher-mcp_*` and status tools they never call, about 13 KB of catalog per notice, and an `ask` inside a subagent stops the run for a permission prompt. Only primary agents a person drives directly (`build`, `orchestrator`, `scholar`) and `document-writer` keep an `ask` default.

`edit`, `write` and `patch` all check the `edit` permission, so `@implement` covers them. The desktop browser tools (`browser.*`) check `browser`, but OpenCode appends `browser * deny` to every agent and grants it per session when the desktop browser attaches, so agent rules cannot allow it.

### Fragments

| Fragment | Contents |
|---|---|
| `core-read` | `read`, `glob`, `grep`, `skill` |
| `web` | `webfetch`, `websearch`, `gofetch_*`, `context7_*` |
| `workplan-read` | `workplan_read`, `workplan_list`, `workplan_inspect`, `workplan_validate`, `workplan_resume` |
| `shell-guard` | ask before `git push*`, `git reset --hard*`, `git clean*`, `rm -rf*` |
| `implement` | `edit` and `shell` allowed, followed by `@shell-guard` |
| `workplan-write-deny` | deny `workplan_create`, `workplan_update`, `workplan_patch`, `workplan_reset`, `workplan_checkpoint`, `workplan_compact` |
| `external-dirs` | ask for outside directories, but allow the skills folder and tool-output folder |
| `env-guard` | ask before reading `.env` files; allow `.env.example` |

Shiori is served over MCP. The `workplan-permissions` plugin preserves the lifecycle role checks using OpenCode's trusted tool caller: only `plan` and `orchestrator` may author plans, and only `orchestrator` may recover transactions, write checkpoints or apply compaction. This supplements the tool allow/ask/deny rules, so an argument such as `recovery` cannot bypass ownership through an otherwise allowed `workplan_update`.

`plan` may list MCP resources and read resources from the `workplan` server; the plugin blocks its reads from other servers. `orchestrator` may list resources, while resource reads retain its existing `ask` policy.

## Generator

```sh
bun scripts/gen-agent-permissions.ts          # rewrite the permissions blocks
bun scripts/gen-agent-permissions.ts --check  # exit 1 if any agent is stale
```

The generator replaces only the `permissions:` block; the rest of the frontmatter (including the commented `# model:` and `# fallback-model:` lines) and the prompt body are left alone.

`tests/agent-permissions.test.ts` fails if any agent file is out of sync with the YAML or has no entry in it.
