# Workplan artifact and evidence contract

Use one stable id and one pair of files per non-trivial task. Preserve the existing version-2 schema; store richer task contracts and receipts in Markdown, with concise pointers and decisions in JSON notes. Do not invent new tool arguments or silently upgrade old metadata.

A minimal version-2 JSON document has this shape (substitute actual values, paths and timestamps):

```json
{
  "schemaVersion": 2,
  "id": "feature-name",
  "kind": "software-engineering",
  "title": "Feature name",
  "goal": "Observable user outcome",
  "scope": ["Included behavior"],
  "nonGoals": ["Excluded behavior"],
  "constraints": [],
  "relevantFiles": ["src/example.ts"],
  "planFile": ".opencode/workplan/feature-name.md",
  "specFiles": [],
  "phases": [{
    "id": "implementation",
    "title": "Implementation",
    "status": "draft",
    "steps": [{
      "id": "feature",
      "title": "Implement the feature",
      "target": "src/example.ts",
      "action": "Concrete bounded change",
      "validation": "Exact check and expected result",
      "status": "draft"
    }]
  }],
  "reviewFindings": [],
  "notes": [],
  "status": "draft",
  "createdAt": "<current ISO timestamp>",
  "updatedAt": "<current ISO timestamp>"
}
```

Allowed statuses: `draft`, `in_progress`, `blocked`, `review`, `completed`, `cancelled`. Findings use `severity`, `title`, optional `detail`, `source`, and `status: open|resolved`; severities are `blocker`, `critical`, `major`, `minor`, `note`, `question`.

Use this Markdown structure, scaled to the work:

```markdown
# Goal
## Scope and non-goals
## Authorization, decisions and assumptions
## Approach and verified references
## Work packages
### <phase>/<step>
- Objective:
- Owned files / blocked files:
- Dependencies and integration order:
- Acceptance criteria (observable behavior):
- Validation (command/interaction + expected result):
- Escalation trigger:
## Validation and review strategy
## Risks and open questions
## Execution receipts
### <phase>/<step> — attempt <n>
- Worker agent / session id (if returned):
- Code state (commit plus working-diff description or artifact fingerprint):
- Changed files:
- Acceptance criterion -> evidence:
- Checks: cwd, command, exit status, relevant counts, evidence path:
- Hypothesis / result / next decision:
- Review findings and disposition:
## Resume point
- Next executable step and unmet dependencies:
- Unresolved findings / decision required:
```

Generated phase/step markers (`<!-- workplan-phase-id: ... -->`, `<!-- workplan-step-id: ... -->`) must be preserved when present. A new handwritten plan may include them beside the matching headings for tool interoperability.

The parent alone records execution receipts and JSON updates after integrating worker results. Retain failed attempts as well as the final result. Evidence paths should point to actual logs/artifacts, not promised future output. Avoid storing full transcripts. Note which code state was tested so changed code cannot reuse stale evidence.

## Three distinct gates

1. **Structural validity:** valid JSON/version/statuses, unique phase IDs and step IDs within each phase, nonempty goal/actions/validation, existing nonempty linked plan/spec files within the project. Validate with the tool when available, otherwise check with native reads. This does not run tests.
2. **Readiness:** requirements and ownership are clear enough to execute, dependencies are achievable, references are accurate, acceptance is observable, and material plan findings are resolved. Record the separate authorization decision; readiness alone is not permission.
3. **Completion:** every in-scope step/phase is completed, acceptance criteria have current supporting evidence, required checks actually ran, no unresolved blocker/critical/major findings remain, and significant changes have independent review (or an explicitly disclosed, accepted limitation). A zero exit code with no relevant tests, a worker's PASS, or a structurally valid plan alone is insufficient.

If checks cannot run, record the limitation and return BLOCKED/unverified as appropriate; do not silently treat missing evidence as passing. Update both artifacts using small edits before handing off or after meaningful progress. Before every artifact edit, read the exact current target and compute the patch from that read; never reuse a prior read or copied Markdown segment. If a stale-state, anchor/context, or patch error occurs, discard the attempted edit, re-read, regenerate the smallest patch, and retry only the new patch. When resuming, read actual files instead of reconstructing state from conversation memory.

The parent orchestrator agent can run `bun ~/.config/opencode/scripts/check-workplan.ts <absolute-workspace-root> <workplan-id>` to check structural validity in this V2 harness without registering custom tools. This helper is read-only and does not infer readiness or completion from a status field. Planning/review agents have shell disabled, so they return the workplan id/paths for the parent to run this check; file creation itself stays with the planner.

## Native mutation and continuation contract

- Keep core `schemaVersion: 2`. Checkpoints, dependency metadata and recovery
  journals are separately versioned sidecars; reads never migrate old artifacts.
- Native existing-state writes require current `stateHash` as `expectedHash`.
  Retrieve it from read/inspect/resume or a successful mutation. A stale hash
  means reread and recompute; tokens/hashes are state bindings, not authorization.
- Tool writers serialize workspace linkage and per-plan changes. Individual
  files publish atomically; multi-file failure leaves explicit recovery state.
  Read-only tools never recover, create locks or repair files. Only orchestrator
  may use `workplan_update` recovery mode, separate from normal update fields.
  Recovery must refuse externally edited targets rather than overwrite them.
- Planner/orchestrator may author plans; only orchestrator may checkpoint or
  apply compaction. Native permissions must cover every exact mutation path and
  the live invocation; unknown host, denied approval or cancellation fails closed.
  Do not bypass pending transactions or failed permission checks via raw edits.
- Compaction order: update -> checkpoint -> read-only preview -> apply. Apply
  needs unchanged `previewToken`, current `expectedHash`, fresh multiartifact
  checkpoint and `confirmation: "ARCHIVE_SELECTED_HISTORY"`. Changing state or
  selection requires a new preview; complete originals are archived before pruning.
- Checkpoint freshness binds JSON, linked Markdown and specs, not tested code.
  Legacy/stale guidance and guardrails are unverified and require reconfirmation;
  their omission or staleness never authorizes relaxing an existing restriction.
- Resume output is bounded and paginated. Respect omission/danger counts and
  retrieve referenced work through exact read/inspect pointers or the returned
  snapshot-bound cursor before declaring readiness or completion. Doctor is
  diagnostic only: unavailable effective permission facts remain unknown.
