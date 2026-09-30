import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { workplan_checkpoint } from "../../packages/workplan-tools/src/core/checkpoint";
import { workplan_compact } from "../../packages/workplan-tools/src/core/compact";
import { workplan_create } from "../../packages/workplan-tools/src/core/create";
import { workplan_resume } from "../../packages/workplan-tools/src/core/resume";
import { workplan_update } from "../../packages/workplan-tools/src/core/update";

type AskInput = { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> };

function context(root: string, asks: AskInput[] = []) {
  return {
    directory: root,
    worktree: root,
    metadata() {},
    async ask(input: AskInput) {
      asks.push(input);
    },
  };
}

function parseOutput<T>(value: unknown): T {
  const output = typeof value === "string" ? value : (value as { output?: string }).output;
  if (!output) throw new Error("Tool returned no output");
  return JSON.parse(output) as T;
}

async function createPlan(root: string): Promise<void> {
  await workplan_create.execute(
    {
      id: "resume-demo",
      kind: "software-engineering",
      title: "Resume demo",
      goal: "Finish the current implementation safely",
      status: "in_progress",
      scope: ["Keep active execution context"],
      nonGoals: ["Do not deploy"],
      constraints: ["No live provider requests"],
      relevantFiles: ["src/current.ts"],
      phases: [
        {
          id: "completed-phase",
          title: "Completed setup",
          status: "completed",
          steps: [{ id: "completed-step", title: "Scaffold", action: "Create the scaffold", validation: "Run scaffold tests", status: "completed" }],
        },
        {
          id: "active-phase",
          title: "Active implementation",
          status: "in_progress",
          steps: [
            { id: "old-active-step", title: "Already done in active phase", action: "Finish an earlier slice", validation: "Run focused tests", status: "completed" },
            { id: "current-step", title: "Fix the open issue", action: "Correct the bounded defect", validation: "Run the focused regression and lint", status: "in_progress" },
          ],
        },
      ],
      reviewFindings: [
        { severity: "major", title: "Resolved fixture mismatch", detail: "Old resolution evidence", source: "review-1", status: "resolved" },
        { severity: "major", title: "Current token parser issue", detail: "Must remain visible", source: "review-2", status: "open" },
      ],
      notes: ["Historical worker log: completed setup validation passed", "Current handoff detail that must remain"],
      overwrite: false,
    },
    context(root) as never,
  );
}

describe("workplan continuation and compaction tools", () => {
  it("writes a bounded checkpoint and detects when the source plan changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "workplan-resume-"));
    try {
      await createPlan(root);
      const asks: AskInput[] = [];
      const checkpoint = parseOutput<{
              checkpoint: {
                current: { phaseId: string; phaseTitle: string; phaseStatus: string; stepId: string; stepTitle: string; stepStatus: string };
                nextAction: string;
              };
              checkpointPath: string;
            }>(
        await workplan_checkpoint.execute(
          {
            id: "resume-demo",
            summary: "The Codex token parser correction is underway; no live login or provider request occurred.",
            nextAction: "Verify the malformed-header regression, then rerun focused validation and independent review.",
            phaseId: "active-phase",
            stepId: "current-step",
            blockers: ["Independent review remains open"],
            recentValidation: ["Focused tests passed on the previous state"],
            guardrails: ["Do not access credentials or make provider calls"],
            references: ["src/adapter/current.rs", "docs/security/current.md"],
          },
          context(root, asks) as never,
        ),
      );
      expect(checkpoint.checkpoint.current).toEqual({
        phaseId: "active-phase",
        phaseTitle: "Active implementation",
        phaseStatus: "in_progress",
        stepId: "current-step",
        stepTitle: "Fix the open issue",
        stepStatus: "in_progress",
      });
      expect(asks.some((ask) => ask.permission === "edit")).toBe(true);

      const fresh = parseOutput<{ checkpoint: { fresh: boolean; nextAction: string }; counts: { historicalNotesOmitted: number } }>(
        await workplan_resume.execute({ id: "resume-demo" }, context(root) as never),
      );
      expect(fresh.checkpoint.fresh).toBe(true);
      expect(fresh.checkpoint.nextAction).toContain("malformed-header");
      expect(fresh.counts.historicalNotesOmitted).toBe(2);

      const update = parseOutput<{ stateHash: string }>(await workplan_update.execute({ id: "resume-demo", appendNotes: ["A newly recorded result"] }, context(root) as never));
      const stale = parseOutput<{ checkpoint: { fresh: boolean; nextAction: null }; instruction: string }>(
        await workplan_resume.execute({ id: "resume-demo" }, context(root) as never),
      );
      expect(stale.checkpoint.fresh).toBe(false);
      expect(stale.checkpoint.nextAction).toBeNull();
      expect(stale.instruction).toContain("not fresh");
      const stalePreview = parseOutput<{ previewToken: string; stateHash: string }>(await workplan_compact.execute({
        id: "resume-demo",
        mode: "preview",
        archiveReason: "A stale checkpoint must block destructive compaction",
        completedPhaseIds: ["completed-phase"],
      }, context(root) as never));
      expect(stalePreview.stateHash).toBe(update.stateHash);
      await expect(
        workplan_compact.execute(
          {
            id: "resume-demo",
            mode: "apply",
            archiveReason: "A stale checkpoint must block destructive compaction",
            completedPhaseIds: ["completed-phase"],
            previewToken: stalePreview.previewToken,
            expectedHash: stalePreview.stateHash,
            confirmation: "ARCHIVE_SELECTED_HISTORY",
          },
          context(root) as never,
        ),
      ).rejects.toThrow("fresh version-2 multiartifact checkpoint is required");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("previews without mutation, then archives selected history before compacting it", async () => {
    const root = mkdtempSync(join(tmpdir(), "workplan-compact-"));
    try {
      await createPlan(root);
      const jsonPath = join(root, ".opencode", "workplan", "resume-demo.json");
      const markdownPath = join(root, ".opencode", "workplan", "resume-demo.md");
      const beforeJson = readFileSync(jsonPath, "utf8");
      const beforeMarkdown = readFileSync(markdownPath, "utf8");
      await workplan_checkpoint.execute(
        {
          id: "resume-demo",
          summary: "The current defect and its verification are captured here.",
          nextAction: "Continue with the current step.",
          phaseId: "active-phase",
          stepId: "current-step",
          guardrails: ["Preserve open findings and all security constraints"],
        },
        context(root) as never,
      );

      const selection = {
        id: "resume-demo",
        archiveReason: "Move completed setup receipts and resolved review history out of the active handoff.",
        completedPhaseIds: ["completed-phase"],
        noteIndexes: [0],
        resolvedFindingIndexes: [0],
      };
      const preview = parseOutput<{ mode: string; previewToken: string; stateHash: string; selected: { completedPhases: unknown[]; notes: unknown[]; resolvedFindings: unknown[] }; confirmationRequiredForApply: string }>(
        await workplan_compact.execute({ ...selection, mode: "preview" }, context(root) as never),
      );
      expect(preview.mode).toBe("preview");
      expect(preview.selected.completedPhases).toHaveLength(1);
      expect(preview.selected.notes).toHaveLength(1);
      expect(preview.selected.resolvedFindings).toHaveLength(1);
      expect(readFileSync(jsonPath, "utf8")).toBe(beforeJson);
      expect(readFileSync(markdownPath, "utf8")).toBe(beforeMarkdown);

      await expect(
        workplan_compact.execute({ ...selection, mode: "apply", previewToken: preview.previewToken, expectedHash: preview.stateHash }, context(root) as never),
      ).rejects.toThrow("confirmation=ARCHIVE_SELECTED_HISTORY");
      expect(readFileSync(jsonPath, "utf8")).toBe(beforeJson);

      const applied = parseOutput<{ compacted: boolean; archivePath: string; archived: { phaseCount: number; noteCount: number; resolvedFindingCount: number }; checkpointRefreshed: boolean }>(
        await workplan_compact.execute(
          { ...selection, mode: "apply", previewToken: preview.previewToken, expectedHash: preview.stateHash, confirmation: "ARCHIVE_SELECTED_HISTORY" },
          context(root) as never,
        ),
      );
      expect(applied.compacted).toBe(true);
      expect(applied.archived).toEqual({ phaseCount: 1, noteCount: 1, resolvedFindingCount: 1 });
      expect(applied.checkpointRefreshed).toBe(true);

      const archive = JSON.parse(readFileSync(applied.archivePath, "utf8")) as {
        source: { workplanJson: string; linkedMarkdown: string; checkpoint: string };
        removed: { completedPhaseIds: Array<{ id: string }> };
      };
      expect(archive.source.workplanJson).toBe(beforeJson);
      expect(archive.source.linkedMarkdown).toBe(beforeMarkdown);
      expect(JSON.parse(archive.source.checkpoint).id).toBe("resume-demo");
      expect(archive.removed.completedPhaseIds.map((phase) => phase.id)).toEqual(["completed-phase"]);

      const active = JSON.parse(readFileSync(jsonPath, "utf8")) as {
        scope: string[];
        nonGoals: string[];
        constraints: string[];
        phases: Array<{ id: string; steps: Array<{ id: string; status: string }> }>;
        notes: string[];
        reviewFindings: Array<{ title: string; status?: string }>;
      };
      expect(active.scope).toEqual(["Keep active execution context"]);
      expect(active.nonGoals).toEqual(["Do not deploy"]);
      expect(active.constraints).toEqual(["No live provider requests"]);
      expect(active.phases.map((phase) => phase.id)).toEqual(["active-phase"]);
      expect(active.phases[0]?.steps.map((step) => step.id)).toEqual(["old-active-step", "current-step"]);
      expect(active.notes).toContain("Current handoff detail that must remain");
      expect(active.notes.some((note) => note.startsWith("Compaction archive: "))).toBe(true);
      expect(active.reviewFindings).toHaveLength(1);
      expect(active.reviewFindings[0]?.title).toBe("Current token parser issue");
      expect(active.reviewFindings[0]?.status).toBe("open");
      expect(readFileSync(markdownPath, "utf8")).not.toContain("Historical worker log");

      const resumed = parseOutput<{ checkpoint: { fresh: boolean; nextAction: string }; counts: { findingsTotal: number; referencesTotal: number } }>(
        await workplan_resume.execute({ id: "resume-demo" }, context(root) as never),
      );
      expect(resumed.checkpoint.fresh).toBe(true);
      expect(resumed.checkpoint.nextAction).toBe("Continue with the current step.");
      expect(resumed.counts.referencesTotal).toBeGreaterThan(0);
      expect(resumed.counts.findingsTotal).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects archiving unfinished phases, open findings, and symlinked archive paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "workplan-compact-safe-"));
    const outside = mkdtempSync(join(tmpdir(), "workplan-compact-outside-"));
    try {
      await createPlan(root);
      await workplan_checkpoint.execute(
        { id: "resume-demo", summary: "Current state", nextAction: "Continue current step" },
        context(root) as never,
      );

      await expect(
        workplan_compact.execute(
          {
            id: "resume-demo",
            mode: "preview",
            archiveReason: "Must reject active work",
            completedPhaseIds: ["active-phase"],
          },
          context(root) as never,
        ),
      ).rejects.toThrow("every step explicitly completed");
      await expect(
        workplan_compact.execute(
          {
            id: "resume-demo",
            mode: "preview",
            archiveReason: "Must reject open findings",
            resolvedFindingIndexes: [1],
          },
          context(root) as never,
        ),
      ).rejects.toThrow("explicitly marked resolved");

      mkdirSync(join(root, ".opencode", "workplan", "archive"), { recursive: true });
      symlinkSync(outside, join(root, ".opencode", "workplan", "archive", "resume-demo"), "dir");
      const collisionPreview = parseOutput<{ previewToken: string; stateHash: string }>(await workplan_compact.execute({
        id: "resume-demo",
        mode: "preview",
        archiveReason: "Reject a symlinked archive destination",
        completedPhaseIds: ["completed-phase"],
      }, context(root) as never));
      await expect(
        workplan_compact.execute(
          {
            id: "resume-demo",
            mode: "apply",
            archiveReason: "Reject a symlinked archive destination",
            completedPhaseIds: ["completed-phase"],
            previewToken: collisionPreview.previewToken,
            expectedHash: collisionPreview.stateHash,
            confirmation: "ARCHIVE_SELECTED_HISTORY",
          },
          context(root) as never,
        ),
      ).rejects.toThrow("must not be a symlink");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
