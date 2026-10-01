# Delegation details

Read the section you need. The main skill covers ordinary delegation.

## Dispatching steps of a durable workplan

Only the parent writes workplan state. Workers return receipts and never claim, release or edit steps. Use the existing status values and `notes[]`; add no new fields.

Claim each step in two phases, because the child's session id exists only after the call returns:

1. Before dispatch: set the step (and its phase, if it is starting) to `in_progress` and add the note `dispatching to <worker>: <phase-id>/<step-id>`.
2. When the call returns: add the note `claimed by <worker>/<session-id>: <phase-id>/<step-id>`, so a correction can resume the same worker.
3. A step that is `in_progress` with a dispatch or claim note is owned. Do not hand it to a second worker.
4. Re-check the workplan before each new handoff.
5. Release a claim only by a status update after the worker's receipt has landed.

Name the workplan id and phase/step in the brief. Workers read their part with a scoped `workplan_inspect`, not a full `workplan_read`. Make workplan edits one small logical change at a time.

## Planner-owned artifacts

A delegated `plan` agent owns its planning artifacts until it returns its handoff. Do not edit them while it runs.

## Ownership fields in a brief

When several workers share a codebase, the brief's Scope names owned files, blocked or shared files, merge order and, for lanes, the worktree path. Workers stay inside them and never reconcile sibling work. A worker that finds these fields missing or unclear in a way that changes what it edits stops and reports the gap; otherwise it states which files it assumed it owns.

## Background workers

Any configured child may run in the background once it has a complete brief and isolated ownership. Background execution changes scheduling only. Reconcile receipts as they complete. Reviewers still review the merged result.

Run `subagent_list` to confirm a child's sessionID, agent and running state before stopping it. Stop a child with `subagent_stop` only when its brief is superseded, it has drifted outside its scope, or the user asks; never to check on progress. A stopped child returns no receipt: record the stop and its reason, treat any edits it made as unreviewed partial work, and either resume it with its `sessionID` or re-dispatch with a fresh brief.

## Tester assignments

Record the code state (commit plus a description of the working diff) before the run. Afterwards, check that validation produced only expected temporary or build output.

## Concurrent edits

Shared files, above all `.opencode/workplan/*`, can change between worker calls. A worker that finds a conflicting change returns BLOCKED instead of overwriting it.

## Review cycles

- A cycle is one pass of implementation or fix, validation, and independent review for one scope.
- A failed fix is a change meant to resolve a material finding that leaves it unresolved or introduces another material defect.
- Two failed fixes for the same issue: reassess the hypothesis instead of repeating it.
- Three cycles without convergence: stop looping and report the blocker and decision needed.
- Record attempts and decisions where the next session can find them. Size alone is never a reason to call `oracle`, and `oracle` is not a routine review step.

## Reasoning-router markers

The `reasoning-router` plugin may map a marker at the start of a child's task text to that child's reasoning effort. It only acts for providers listed in its `providers` option and only for delegated child sessions; elsewhere a marker does nothing.

| Marker | Use for |
| --- | --- |
| none (`auto`) | the agent's default |
| `[reasoning:fast]` | lookups, deterministic validation |
| `[reasoning:balanced]` | an explicit middle level |
| `[reasoning:deep]` | planning, review, debugging, consequential decisions |

- Append `:escalate` only after a failed approach, on contradictory evidence, or for migrations. It moves one level.
- Agent policy clamps every request to that agent's range. Some agents have a single fixed level (for example `oracle`), so omit markers for them.
- Never write raw effort values such as `low` or `high`; they are not markers and are ignored.
- A marker changes compute, not responsibility. Work that needs more judgment goes to a more capable agent, not to the same agent with a deeper marker.
- The ranges live in `packages/reasoning-router/README.md` and under `providerAgentPolicy` in `opencode.json`. Do not copy the numbers into prompts.

## Worktree lanes

Lanes run parallel or risky slices in separate `git worktree` checkouts. They need commits, so use them only when the user has explicitly authorized this plan's execution including commits on lane branches and merging them locally. Authorization to implement is not authorization to commit. Without it, serialize the slices in the shared checkout or ask the user.

1. From the canonical project root, the parent runs `git worktree add ../<task>-<lane> -b <lane-branch>` for each slice and records the path and branch in the workplan notes.
2. The brief's workspace and cwd are the worktree path. Owned files keep their usual relative paths.
3. Workers never touch `.opencode/workplan` inside a worktree. Workplan state lives in the canonical root and only the parent writes it.
4. The worker validates inside its worktree. It commits on its own lane branch only when the brief grants that; otherwise it leaves changes uncommitted and the parent commits them on the lane branch. The receipt lists any commit SHAs.
5. The parent alone merges each lane with `git merge --no-ff <lane-branch>`, resolves conflicts itself, and re-runs the relevant checks on the merged result.
6. The parent removes each worktree after merge or on abort (`git worktree remove ../<task>-<lane>`) and records the removal in the workplan notes.
7. Nobody pushes lane branches without explicit user authorization. Workers never merge, rebase or push any branch.
