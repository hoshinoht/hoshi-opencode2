---
name: workflow-execute
description: Execute an existing durable development workplan through scoped implementation and evidence-backed validation. Routine inline plans do not use this skill.
compatibility: Requires OpenCode with this repo's agents (orchestrator, plan, plan-checker, code-writer, code-engineer) and workplan_* tools from packages/workplan-tools.
metadata:
  domain: software-engineering
  workflow: workplan-execution
---

# Preconditions

Read the exact plan from the actual project root, including JSON state, linked Markdown and specFiles. Confirm readiness and the user's existing implementation authorization. An implementation request or `/dev` authorizes ordinary in-scope work; a plan-only request does not. Do not request a redundant approval between ready steps.

On session start with an existing `in_progress` workplan and no new instruction, report its recorded resume point (next executable step, unmet dependencies, unresolved findings) and ask to continue; never auto-execute a plan-only workplan.

If no durable workplan exists, return control to orchestrator. Orchestrator should use direct execution or a concise inline plan unless the durable-planning triggers apply; this skill does not promote routine tasks into artifact-backed workflows.

Read [the artifact and evidence contract](../workflow-plan/references/workplan-contract.md) for state, receipts and the three gates. If workplan tools are unavailable, use native read/edit tools on the same artifacts. Never stall in a retry loop over nonexistent or stale tools.

When registered, `workplan_doctor` is a read-only preflight for tool, artifact,
host and permission problems; unavailable permission facts are unknown, not
approval. Native writes require current `stateHash` as `expectedHash`; reread
and recompute after stale-state errors. Resume defaults to bounded output;
follow its cursor or exact read/inspect pointers for omitted material. Reconfirm
stale checkpoint guardrails and blockers; plan freshness does not verify test
evidence. For compaction: update, checkpoint, read-only preview, then apply
with that exact `previewToken`, current `expectedHash` and
`confirmation: "ARCHIVE_SELECTED_HISTORY"`. Any intervening change requires
a new preview. Only orchestrator may checkpoint, apply compaction or recover
transactions via `workplan_update` with `recovery: "resume" | "rollback"`.
Recovery is separate from normal updates. Stop on external-edit conflicts;
never remove locks/journals or bypass a pending transaction with fallback edits.

If the artifact contract cannot be read, report that blocker rather than guessing field names or accepting an unknown schema. Numeric `schemaVersion: 2` and the documented field types/statuses are required for the native-file fallback. Use the live session's canonical project root, not a filesystem alias that resolves outside it. Native workplan edits follow the shared fresh-read rule in the global `AGENTS.md`, with no intervening write between the read and the patch.

For this global harness, when `workplan_validate` is absent, orchestrator can run the read-only structural check with `bun ~/.config/opencode/scripts/check-workplan.ts <absolute-workspace-root> <workplan-id>` after the planner returns. It checks the existing schema and linked files without installing anything. A nonzero exit blocks structural validity. If Bun or this helper is unavailable, disclose that limitation and validate with native reads against the artifact contract; do not claim the command ran. Planner and reviewer agents have shell disabled and return their artifacts/findings to orchestrator for this check.

# Execution loop

1. Check structural validity and codebase readiness. Request `plan-checker` only when the plan carries consequential migration, security/data, public-contract, rollback, or multi-owner risk and has not already received proportionate review.
2. Read exact phase/step IDs immediately before each update. Identify the next executable package, prerequisites, owned files, blocked/shared files, integration order and validation target. Recheck stale references when the code changed. Keep each JSON or Markdown update small and serialized.
3. Load `agent-use`. Delegate bounded engineering to `code-writer` (settled behavior and ownership, reversible local choices allowed), `code-engineer` (slice needing broader bounded judgment), or `frontend-engineer` for UI work, while the orchestrator (parent) keeps decisions and integration. Work directly for a small task or when one coherent reasoning context is needed. Delegate only independent meaningful slices with disjoint ownership. Serialize shared-file work.
4. Require the worker to run relevant self-checks and return the standard receipt. The parent reconciles outputs, inspects the diff and updates shared state once. Workers do not edit the shared workplan.
5. Use `tester` for additional specified checks, bug reproduction or collecting high-volume evidence when that saves work. Reuse already valid checks for the same code state. Choose the smallest check capable of exposing a plausible incorrect implementation; add a focused regression test for a reproduced bug when practical, and use property-based tests only where meaningful invariants justify them. A tester reports failures; the implementer fixes them.
6. For medium/large or consequential changes, obtain a fresh `code-checker` review with exact scope, acceptance criteria, current diff and evidence. Reviewers do not repair the implementation. Track findings durably and return concrete corrections to the appropriate worker.
7. Record code state, worker/session id, attempts, changed files, acceptance evidence, validation results, findings and next step. Update artifacts at phase transitions, blockers, review handoff, and completion rather than after every routine command or worker message.
8. Continue the next ready package without generic permission questions. Stop when the completion gate passes or a concrete blocker/decision requires input.
9. When the completion gate passes, update all completed steps/phases and the workplan status in one final state change, record current evidence, and set the resume point to `none — complete`. Do not dispatch more workers or pursue adjacent work.
10. Treat any task discovered after completion as new scope. Stop and ask the user for explicit authorization before changing files, creating a new phase, reopening the plan, or running additional implementation/review loops. A completed workplan is not an invitation to continue iterating.
11. Review any planner-provided `Lesson candidates` only before the final completion update. Persist at most three durable, project-specific lessons, and only if this is explicitly part of the existing authorized workflow; otherwise leave the completed task untouched.
# Isolated worktrees (optional)

For parallel slices touching the same area, or a slice risky enough to isolate, run one slice per `git worktree` instead of sharing the checkout. This is procedure only — no plugin required.

Lanes require commits (each lane's work reaches the canonical checkout as a branch merge), so use them only when the user has explicitly authorized this plan's execution including commits on lane branches and merging them locally. Without that authorization, do not create lanes: serialize the slices in the shared checkout instead, or ask the user. Authorization to implement is not authorization to commit.

1. The parent creates one worktree per slice: `git worktree add ../<task>-<lane> -b <lane-branch>` from the canonical project root. Record the worktree path and branch in the workplan notes (notes only — no schema changes).
2. The handoff's Workspace/cwd is the worktree path; owned files keep their usual relative paths. Workers never touch `.opencode/workplan` inside a worktree — workplan state lives in the canonical root and only the parent writes it.
3. The worker validates inside its worktree, commits its own changes on its lane branch only when the handoff explicitly grants that (never on another branch; otherwise it leaves them uncommitted and the parent commits them on the lane branch), and returns the standard receipt with any commit SHAs. The parent merges each lane (`git merge --no-ff <lane-branch>`, resolving conflicts itself), re-runs the relevant checks on the merged result, then removes the worktree (`git worktree remove ../<task>-<lane>`).
4. Never push lane branches without explicit user authorization. Never leave stale worktrees behind — remove after merge or on abort, and record the removal in the workplan notes.

Single integrator still holds: only the parent (orchestrator) merges; workers never merge, rebase or push any branch.

# State updates

Prefer one active workplan per task. Read state with the bounded `workplan_resume`/scoped `workplan_inspect` described in the global `AGENTS.md` before targeted updates. `workplan_update` owns JSON fields; `workplan_patch` owns localized Markdown prose. Omit unchanged optional fields and never send empty placeholder strings or full planMarkdown for routine updates. If tools are absent, edit the same version-2 JSON and Markdown directly; preserve ids, markers and unrelated state.

Record review severities as `blocker`, `critical`, `major`, `minor`, `note`, `question`; map legacy Critical -> critical, High -> major, Medium -> minor, Low -> note. Mark resolved findings explicitly. Do not confuse structural `valid` with verified completion. Preserve failed attempt history and the current resume point across compaction.

# Convergence and acceptance

A cycle is implementation/fix → validation → independent review; a substantive failed fix leaves its finding unresolved or introduces a material defect. After two failed substantive fixes, the orchestrator (parent) reassesses the hypothesis itself; consult oracle for contradictory evidence or exceptional uncertainty. Resume the worker for a specific correction when native continuation is available. Stop after three non-converging implementation/review cycles and report remaining evidence and the decision needed. Do not repeat an unchanged failing approach or broaden scope to appease speculative review suggestions.

Before marking completed, check the original user outcome, current acceptance evidence, required validation, integration across slices, and absence of unresolved blocker/critical/major findings. An independently reviewed significant change may pass with non-blocking notes. If required verification is unavailable, report that limitation; never invent a passing check. Completion is terminal for the current authorization: after the status is `completed`, do not reopen or extend the plan without an explicit user request.

Finish with behavior delivered, relevant files, checks/evidence and remaining limitations. After global harness changes, explain whether a new session or service restart is needed to load them; do not interrupt unrelated running work automatically.
