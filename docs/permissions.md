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

### Fragments

| Fragment | Contents |
|---|---|
| `core-read` | `read`, `glob`, `grep`, `skill` |
| `web` | `webfetch`, `websearch`, `gofetch_*`, `context7_*`, `deepwiki_*` |
| `workplan-read` | `workplan_read`, `workplan_list`, `workplan_inspect`, `workplan_validate`, `workplan_resume` |
| `shell-guard` | ask before `git push*`, `git reset --hard*`, `git clean*`, `rm -rf*` |
| `implement` | `edit` and `shell` allowed, followed by `@shell-guard` |
| `workplan-write-deny` | deny `workplan_create`, `workplan_update`, `workplan_patch`, `workplan_reset` |
| `external-dirs` | ask for outside directories, but allow the skills folder and tool-output folder |
| `env-guard` | ask before reading `.env` files; allow `.env.example` |

## Generator

```sh
bun scripts/gen-agent-permissions.ts          # rewrite the permissions blocks
bun scripts/gen-agent-permissions.ts --check  # exit 1 if any agent is stale
```

The generator replaces only the `permissions:` block; the rest of the frontmatter (including the commented `# model:` and `# fallback-model:` lines) and the prompt body are left alone.

`tests/agent-permissions.test.ts` fails if any agent file is out of sync with the YAML or has no entry in it.
