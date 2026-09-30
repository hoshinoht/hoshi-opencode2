# OMO MCP Hygiene Guide (V2 port)

Scope: how this config adds, groups, and scopes MCP servers without
bloating context. Applies to `opencode.json` (`mcp.servers`) only.
Rule for new servers: scoped and justified, or not added.

Provenance:

- OMO source SHA (dev): `b5122f19` (full:
  `b5122f19db107e9ab76be51e2898d699c1b6e755`), verified 2026-09-09
  via raw fetch (7 URLs 200 with `packages/` prefix).
- SkillMcpManager source:
  `https://raw.githubusercontent.com/code-yeongyu/omo/b5122f19db107e9ab76be51e2898d699c1b6e755/packages/omo-opencode/src/features/skill-mcp-manager/AGENTS.md`
- V2 MCP-servers docs (canonical, `codemode` PRESENT):
  `https://opencode.ai/docs/mcp-servers`
- Phase-verify verdicts consumed here: `codemode` PRESENT per
  canonical V2 docs; SkillMcpManager lifecycle verified (lazy
  connect, 5-min idle TTL, `session.deleted` disconnect);
  project-config precedence holds (same-name server in a
  higher-precedence project config replaces the global entry).

Current inventory (for reference; `step-apply` acts on this, not
this doc): local `researcher-mcp` / `gofetch` / `lsp-tools` via
`sh -c` wrappers, remotes `deepwiki` / `context7` / `grep_app`,
`exa` disabled, `ats-tailor` currently global-enabled.

## 1. Skill-embedded MCP lifecycle (default for task-scoped servers)

OMO's `SkillMcpManager` treats skill-embedded servers as scoped
per-task/session resources, not always-on additions:

- Lazy connect: a skill's servers connect only when the skill runs.
- Torn down after: disconnect on task/session end; `session.deleted`
  forces disconnect.
- Idle reclamation: 5-min idle TTL disconnects unused skill servers.

Port rule: prefer this pattern for any new task-scoped server. Do
not add always-on global servers for work one skill or one project
needs. If V2 has no native skill-embedded slot for the case, the
closest equivalent is a per-project override (section 3), still
scoped, still removed/disabled when the need ends.

## 2. Grouping guidance (Code Mode)

Default: grouped Code Mode. One tool entry fans out to the
underlying MCP tools, so the model sees one surface instead of N
server tool lists.

- `codemode: false` opts out natively per server. Deliberate use
  only: when a server's tools must appear ungrouped (debugging a
  server, or a single tool that grouping hides). Record why in the
  `step-apply` receipt when used.
- Do not set `codemode: false` globally or by habit; each opt-out
  spends context budget on every session.

## 3. Per-project enablement pattern (ats-tailor example)

Specialist servers stay disabled globally and are enabled only in
the projects that use them, via same-name override: a same-name
server entry in the higher-precedence project config replaces the
global entry.

`ats-tailor` example (target state; applied by `step-apply`):

```jsonc
// global opencode.json — disabled by default
{ "mcp": { "servers": { "ats-tailor": {
  "type": "local",
  "command": ["sh", "-c",
    "uv run --project $HOME/projects/personal/resume/ats-tailor ats-tailor mcp --repo $HOME/projects/personal/resume"],
  "disabled": true
} } } }
```

```jsonc
// <resume-project>/.opencode/opencode.json — enabled where used
{ "mcp": { "servers": { "ats-tailor": { "disabled": false } } } }
```

Same pattern fits any future specialist server: global entry
documents the command with `disabled: true`; each consuming project
opts in with a same-name override.

## 4. No-bloat rule + context-budget rationale

Rule: no new always-on server without (a) naming the agents that
need it, (b) choosing grouped vs opt-out (section 2), and (c)
choosing global vs per-project scope (section 3).

Why: every enabled server's tool list competes for context on every
session, even sessions that never call it. Disabled-by-default +
per-project enablement + grouped Code Mode keeps the shared budget
for the general trio (`deepwiki` / `context7` / `grep_app`) and
local utilities (`researcher-mcp` / `gofetch` / `lsp-tools`), while
specialist servers cost budget only where they pay off.

## Rules-injector convention note (appended by step-rules)

Placeholder: `phase-patterns/step-rules` appends the AGENTS.md
auto-load convention note here (V2 native injection per
OPENCODE_V2.md; no code change).
