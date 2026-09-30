# Workflows

hoshi-opencode2 offers two ways to get development work done: a direct default agent for everyday tasks, and an orchestrated flow for larger changes.

## `build`: the default

`build` is the default agent (`"default_agent": "build"` in `opencode.json`).

- Lightweight and direct-first: small, clear tasks are done in place.
- It can call the whole specialist roster, but only delegates when a specialist would clearly be faster or give more confidence.
- A multi-step change gets a short inline plan at most. `build` never creates durable workplans; its `workplan_create`/`update`/`patch`/`reset` permissions are denied.

## `/dev`: the orchestrated flow

`/dev <request>` runs the `orchestrator` agent, pinned by the command to `openai/gpt-6.1-sol#high`.

1. Inspect the repository and plan inline.
2. Hand bounded slices to workers (`code-writer`, `code-engineer`, `frontend-engineer`, ...).
3. Get independent review (`code-checker`) and validation (`tester`).
4. Integrate the results and report evidence.

Commits, pushes and deploys each need their own explicit authorization; `/dev` does not grant them.

## `/autoresearch`: experiment loops

`/autoresearch <goal + params>` runs the `experimenter` subagent with the `metric-loop` skill. It creates a git worktree on branch `autoresearch/<tag>`, records a baseline, then makes one change per iteration, commits it as `experiment: ...`, measures a mechanical metric (plus an optional guard) and keeps or `git revert`s it. Results go to an untracked `results.tsv` in the worktree.

- Budget: 10 iterations by default (a hard maximum unless you raise it); stops early on a plateau (3 non-improving iterations) or repeated guard failures.
- Starting the loop authorizes commits on that branch only. It never touches the main worktree, pushes or merges; adopting the result is up to you.
- Metrics must come from a command, never from an LLM judgement.
- `build`, `orchestrator` and `scholar` can delegate to `experimenter`. `scholar` uses it for ML/numerical experiments and paper-hygiene metrics, then writes tables and methods text from the TSV.

## Durable workplans

Most plans stay inline. The orchestrator escalates to a durable workplan, through the `workflow-plan` and `workflow-execute` skills, only when the work:

- has to survive across sessions,
- has several dependent write owners,
- is a migration or a staged rollout,
- carries high architectural, security or data-loss risk,
- or when the user explicitly asks for one.

Only `plan` and `orchestrator` may author workplans. Plans are stored under `.opencode/workplan/` in the project, specs under `.opencode/docs/specs/`. The workplan contract is in [`skills/workflow-plan/references/workplan-contract.md`](../skills/workflow-plan/references/workplan-contract.md), and the tools are described in [plugins.md](plugins.md#workplan-tools).

The `plan` agent has `mode: all`, so you can select it directly or let the orchestrator call it.

## Delegation limits

- Workers run as background child sessions and start with fresh context.
- `experimental.subagent_depth: 2` in `opencode.json` means implementation and review workers cannot spawn further subagents.
- The `agent-use` skill holds the routing, scoping, ownership and acceptance-evidence rules; primary agents load it before delegating.

## Review

`/review` (orchestrator) reviews the current diff adversarially. A small diff goes to one `code-checker`; a large one is sliced by package or file group across parallel checkers, and the findings are merged and ranked by severity. It never edits files or commits.
