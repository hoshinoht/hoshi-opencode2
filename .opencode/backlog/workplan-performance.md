# Shiori — workplan performance bucket list

Status: deferred; recorded at the user's request on 2026-09-30.

Begin consideration only after [workplan-tools-hardening](../workplan/workplan-tools-hardening.md)
is completed and verified. This is a backlog, not an active implementation plan
or authorization to start another rollout automatically. Reuse improvements
already delivered by the current work rather than implementing them twice.

Follow-up project name: **Shiori**. The user will create its Git repository;
do not create/publish one on their behalf. After current hardening is verified,
prepare a separate specification covering a proposed Go core, this improvement
list and worktree-aware execution. Specification writing is authorized; Go
implementation, artifact migration and renaming existing `workplan_*` APIs are
not yet authorized. The user supplied `git@github.com:hoshinoht/shiori.git`;
proposed Go module path is `github.com/hoshinoht/shiori`. Discover or create a
non-conflicting local checkout for specifications after hardening completes;
do not commit, push or alter remote settings without explicit approval.

## First: establish the bottleneck

- [ ] Benchmark approximately 100 KB, 1 MB and 10 MB plans, large handwritten
  Markdown histories, thousands of steps/findings, and many linked specs.
- [ ] Measure cold/warm resume, read/inspect pagination, checkpoint, update and
  compaction preview: latency distributions, peak memory, bytes read/written,
  parse/hash/serialization time, and emitted payload size.

## Priority: compatible indexes and bounded processing

- [ ] Keep ordered phase/step arrays for V2 compatibility, with reusable
  `phaseById` and `stepByKey` hash maps for expected O(1) lookup. Step keys must
  include phase ID because step IDs are only unique within a phase.
- [ ] Extend existing dependency support with reusable DAG adjacency indexes
  (`dependencies`, `dependents`) and, if needed, a ready-work queue/incremental
  prerequisite counts. Preserve cycle checks and archived prerequisite context.
- [ ] Use stable severity buckets for unresolved findings; consider a priority
  queue only if measured scheduling needs dynamic priorities beyond severity.
- [ ] Select page records before rendering; avoid constructing or repeatedly
  serializing the full active-work collection for a small requested page.
- [ ] Reuse raw buffers, parsed documents and hashes within one operation to
  eliminate duplicate reads/parses and nested-helper recomputation.
- [ ] Cache validated snapshot indexes/rendered pages with explicit invalidation
  and bounded eviction. Filesystem timestamps/sizes are hints, not proof of
  unchanged content; external edits and stale snapshots must still be detected.
- [ ] Hash independent artifacts with bounded concurrency and memory usage.
- [ ] Reuse authenticated clients/event connections where proven safe, while
  retaining fresh host/readiness checks, per-invocation authorization and
  cancellation. Never cache permission grants.

## History and Markdown

- [ ] Separate growing historical receipts/notes from active state using indexed
  sidecars/archives with stable retrieval pointers. Existing custom Markdown
  preservation means JSON compaction alone may not reduce a huge Markdown file.
- [ ] Build hash-bound heading/marker-to-byte-range indexes for targeted section
  retrieval, preserving generated markers and handwritten prose.
- [ ] Evaluate ropes/piece tables or chunked representations only if frequent
  localized Markdown edits are a measured copying/allocation bottleneck.
- [ ] Evaluate structural sharing for cached in-memory updates if allocation is
  significant; do not claim it avoids full JSON serialization on disk.

## Conditional: indexed persistent storage

- [ ] Consider B-tree-backed/SQLite storage only if whole-document JSON loading
  or persistence remains the measured bottleneck after simpler optimizations.
  This requires a separately reviewed compatibility/migration/rollback plan;
  retain human-readable JSON/Markdown exports and do not silently migrate plans.

## Acceptance guardrails

Index construction still costs O(n); benefits require reuse. Preserve stable
ordering, authoritative mutation checks, multiartifact freshness, exact-path
permissions, cancellation, cross-process concurrency, safe recovery, preview
binding and evidence limits. Compare performance and correctness on the same
code state; faster output is not permission to omit safety-critical information.
