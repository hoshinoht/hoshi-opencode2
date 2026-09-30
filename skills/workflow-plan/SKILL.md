---
name: workflow-plan
description: Create or revise a durable development plan for cross-session, multi-owner, migration, staged-rollout, or consequential work. Ordinary planning stays inline; planning never authorizes implementation by itself.
compatibility: Requires OpenCode with this repo's agents (orchestrator, plan, plan-checker, code-writer, code-engineer) and workplan_* tools from packages/workplan-tools.
metadata:
  domain: software-engineering
  workflow: workplan-planning
---

# Planning procedure

1. Confirm that durable planning is warranted: the task must survive across sessions, has multiple dependent write owners, is a migration or staged rollout, carries consequential architecture/security/data-loss risk, or was explicitly requested as durable. Otherwise return a concise inline plan and create no files.
2. Read the goal, project instructions, existing changes, and the smallest relevant implementation/test set. Separate discoverable facts from material user decisions; follow repository precedent for reversible details.
3. Create one stable plan id. Define only coherent work packages with ownership, dependencies, observable acceptance, failure-mode-driven validation, and a finite completion boundary. Do not split work merely to create phases or parallel lanes.
4. Use `plan-checker` only when independent review is likely to reduce consequential execution risk, such as migrations, security/data changes, public-contract changes, difficult rollback, or several interacting owners. One review pass is the default; re-review only after a material correction, and stop after two non-converging passes.
5. Return an execution-ready handoff or the exact blocker. Preserve existing implementation authorization and do not launch implementation workers. Include `Lesson candidates` only when a durable project-specific lesson genuinely emerged.

# Durable storage

Keep `.opencode/workplan/<id>.json` for machine state and `.opencode/workplan/<id>.md` for detailed reasoning, ownership, acceptance and evidence. Optional specifications live under `.opencode/docs/specs/` and are linked via `specFiles`. Read [the artifact contract](references/workplan-contract.md) when creating, resuming or validating a durable plan.

Use `workplan_list`, `read` and `inspect` for discovery. If these tools are actually available, use `create`, `update`, `patch` and `validate` for maintenance. Never assume a tool exists merely because it appears in this skill. If absent in V2, use native read/edit tools and the same documented file format; preserve existing ids and fields. This fallback stays inside the planner's allowed artifact paths and requires no shell execution or plugin installation. If both the tools and the native edit fallback are unavailable or denied, return BLOCKED with the exact tool error; never claim READY with pasted content for the parent to write.

When registered, use read-only `workplan_doctor` to diagnose missing tools,
invalid artifacts, pending transactions or host/permission conflicts. Native
existing-plan mutations require the current `stateHash` as `expectedHash`,
obtained from read/inspect/resume or the last successful mutation. On a stale
hash, reread and recompute; never automatically rebase an old patch. Creation
defaults to must-be-absent. Preserve handwritten Markdown; full replacement
requires explicit `replaceMarkdown` intent. Planner authoring does not permit
implicit regeneration on a move with missing source Markdown: provide nonblank
`planMarkdown` explicitly or stop. Planner authoring also does not permit
checkpoint writes, compaction apply or transaction recovery. Use
`workplan_compact_preview` for read-only preview, not the apply tool. If a
transaction is pending, return its diagnostic to orchestrator; do not bypass
it with fallback edits or delete lock/journal files.

Before a fallback write, read `references/workplan-contract.md` relative to this skill's base directory. If that reference cannot be read, return BLOCKED with the error; do not infer a schema from logs, old conversations or another project's plan. New metadata must use numeric `schemaVersion: 2`, the documented field types and status enum. Re-read both artifacts and compare against that reference before claiming structural validity. Use the live session's canonical project directory for paths (on macOS `/tmp` may resolve to `/private/tmp`).

For every native workplan edit, read the target artifact immediately before
computing the patch and apply that patch without an intervening write. Never
patch from an earlier read or copied Markdown segment. If a tool reports stale
state, an anchor/context mismatch, or a patch failure, discard the attempted
patch, re-read the target, regenerate the smallest logical patch, and retry
only the regenerated patch. Do not retry an unchanged edit. Keep JSON state
and Markdown prose updates separate, and make one small logical update at a
time; the parent is the sole writer during execution.

When tools are available:
- `workplan_update` changes JSON state: goal, scope, constraints, files, phases/steps, findings, notes and status. Prefer targeted `updatePhases`, `updateSteps`, `addPhases`, `addSteps`.
- Omit unchanged optional values. Never send blank strings or placeholder arrays to clear data. Do not retry a stale-schema error unchanged.
- `workplan_patch` changes localized Markdown prose only. Do not replace the whole plan on every update or use Markdown to silently change machine state.
- Use reset only for a requested restart; never reset a valid plan on resume.
- `workplan_validate` checks structure and linked files. Its `valid` result does not prove executability, authorization, or completion.

# Handoff

Return STATUS: READY | BLOCKED with workspace root, workplan id and paths, scope, decisions, work packages and ownership, acceptance/validation, remaining material findings, and the next executable step. Claim READY only when both artifacts exist on disk; pasted content without files is not READY. Include review coverage and `Lesson candidates` only when present. Preserve whether implementation was already requested; do not ask for another generic approval.
