import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "node:path";

import { tool } from "./tool";

import {
  assertUniqueWorkplanIds,
  canonicalizeWorkspaceRoot,
  formatOutput,
  isWithinWorkspaceRoot,
  renderWorkplanMarkdown,
  resolveToolWorkspaceRoot,
  serializeWorkplanDocument,
} from "./shared";
import { checkpointFreshness, checkpointReadFromContent, readStableWorkplan } from "./checkpoint-shared";
import type { WorkplanCheckpointV2 } from "./checkpoint-shared";
import { workplanCompactArgs, workplanInputSchemas } from "./schemas";
import { createDependencySidecar, validateDependencyRecords } from "./dependencies";
import { planHashWithArtifactChanges } from "./snapshot";
import { archivePath as workplanArchivePath, checkpointPath, dependencyPath, journalPath, journalStagePath, planLockPath, stagePath, workspaceLockPath } from "./storage-paths";
import { assertNoPendingTransaction, commitWorkplanMutation, throwIfAborted } from "./transaction";
import type { MutationTarget, WorkplanMutationInvocation } from "./transaction";
import type { WorkplanDependency, WorkplanTerminalDependencySummary } from "./types";

const APPLY_CONFIRMATION = "ARCHIVE_SELECTED_HISTORY";

function indexes(values: number[] | undefined, label: string): number[] {
  const result = values ?? [];
  if (result.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error(`${label} must contain unique zero-based non-negative integer indexes`);
  }
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate indexes`);
  return result;
}

function safePreview(value: string, limit = 180): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit)}…` : singleLine;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function parentDirectories(root: string, path: string): string[] {
  const result: string[] = [];
  let current = dirname(resolve(path));
  while (current !== root && isWithinWorkspaceRoot(root, current)) {
    result.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

function selectHistory(document: import("./types").WorkplanDocument, phaseIds: string[], noteIndexes: number[], findingIndexes: number[]) {
  if (new Set(phaseIds).size !== phaseIds.length) throw new Error("completedPhaseIds contains duplicates");
  if (phaseIds.length >= document.phases.length) throw new Error("Compaction must leave at least one phase in the active workplan");
  const selectedPhases = phaseIds.map((phaseId) => {
    const phase = document.phases.find((candidate) => candidate.id === phaseId);
    if (!phase) throw new Error(`Phase not found: ${phaseId}`);
    if (phase.status !== "completed" || phase.steps.length === 0 || phase.steps.some((step) => step.status !== "completed")) {
      throw new Error(`Only phases with every step explicitly completed can be archived: ${phaseId}`);
    }
    return phase;
  });
  const selectedNotes = noteIndexes.map((index) => {
    if (index >= document.notes.length) throw new Error(`Note index out of range: ${index}`);
    return { index, text: document.notes[index]! };
  });
  const selectedFindings = findingIndexes.map((index) => {
    const finding = document.reviewFindings[index];
    if (!finding) throw new Error(`Review finding index out of range: ${index}`);
    if (finding.status !== "resolved") throw new Error(`Only findings explicitly marked resolved can be archived: ${index}`);
    return { index, finding };
  });
  return { selectedPhases, selectedNotes, selectedFindings };
}

function previewPayload(
  snapshot: Awaited<ReturnType<typeof readStableWorkplan>>,
  reason: string,
  phaseIds: string[],
  noteIndexes: number[],
  findingIndexes: number[],
) {
  const selection = selectHistory(snapshot.document, phaseIds, noteIndexes, findingIndexes);
  const markdown = snapshot.planContent?.toString("utf8") ?? null;
  const markdownWasGenerated = markdown !== null && markdown === renderWorkplanMarkdown(snapshot.document);
  return {
    version: 1,
    root: snapshot.workspaceRoot,
    id: snapshot.id,
    stateHash: snapshot.stateHash,
    reason,
    selection: {
      phaseIds,
      phases: selection.selectedPhases,
      notes: selection.selectedNotes,
      findings: selection.selectedFindings,
    },
    markdownTreatment: markdownWasGenerated ? "generated-refresh" : "preserved",
    removals: {
      phaseIds,
      noteIndexes: selection.selectedNotes,
      findingIndexes: selection.selectedFindings,
    },
  };
}

function previewToken(payload: unknown): string {
  return `v1-${digest(payload)}`;
}

export const workplan_compact = tool({
  description:
    "Preview or archive explicitly selected workplan history. Apply mode requires a fresh checkpoint and exact confirmation; it snapshots the original JSON, linked Markdown, and checkpoint before removing only selected completed phases, notes, and explicitly resolved findings.",
  args: workplanCompactArgs,
  async execute(args, context) {
    const input = workplanInputSchemas.compact.parse(args);
    if (input.mode === "apply") throwIfAborted(context.abort);
    const workspaceRoot = await canonicalizeWorkspaceRoot(resolveToolWorkspaceRoot(context, input.workspaceRoot));
    const snapshot = await readStableWorkplan(workspaceRoot, input.id);
    const mode = input.mode ?? "preview";
    if (snapshot.journalContent && mode === "preview") {
      return formatOutput({ recoveryRequired: true, journalPath: `.opencode/workplan/${snapshot.id}.transaction.json`, planHash: snapshot.planHash, stateHash: snapshot.stateHash, planFresh: false });
    }
    await assertNoPendingTransaction(snapshot);
    const { document, path, planPath } = snapshot;
    assertUniqueWorkplanIds(document);
    const reason = input.archiveReason;
    if (!reason.trim()) throw new Error("archiveReason cannot be empty");
    const phaseIds = input.completedPhaseIds ?? [];
    const selectedNoteIndexes = indexes(input.noteIndexes, "noteIndexes");
    const selectedFindingIndexes = indexes(input.resolvedFindingIndexes, "resolvedFindingIndexes");
    const selection = selectHistory(document, phaseIds, selectedNoteIndexes, selectedFindingIndexes);
    const selectionCount = selection.selectedPhases.length + selection.selectedNotes.length + selection.selectedFindings.length;
    const checkpointRead = checkpointReadFromContent(snapshot.checkpointContent, document.id, checkpointPath(workspaceRoot, document.id));
    const checkpointFresh = checkpointFreshness(checkpointRead.checkpoint, snapshot, checkpointRead.diagnostic);
    const dependencyRead = validateDependencyRecords(snapshot.dependencyContent, document.id, document);
    if (dependencyRead.issues.length) throw new Error(`Invalid dependency metadata blocks compaction: ${dependencyRead.issues.join("; ")}`);
    const markdown = snapshot.planContent?.toString("utf8") ?? null;
    const markdownWasGenerated = markdown !== null && markdown === renderWorkplanMarkdown(document);
    const payload = previewPayload(snapshot, reason, phaseIds, selectedNoteIndexes, selectedFindingIndexes);
    const token = previewToken(payload);
    const transactionId = token.slice(3, 19);
    const checkpointFile = checkpointPath(workspaceRoot, document.id);
    const dependencyFile = dependencyPath(workspaceRoot, document.id);
    const archiveFile = workplanArchivePath(workspaceRoot, document.id, `state-${snapshot.stateHash.slice(0, 12)}`, token.slice(3, 15));
    const transactionJournalPath = journalPath(workspaceRoot, document.id);
    const archiveRelativePath = relative(workspaceRoot, archiveFile).replaceAll("\\", "/");
    const writeTargets = [archiveFile, path, ...(markdownWasGenerated ? [planPath] : []), ...(dependencyRead.recorded ? [dependencyFile] : []), checkpointFile];
    const stagePaths = writeTargets.map((target, index) => stagePath(target, transactionId, index));
    stagePaths.push(journalStagePath(workspaceRoot, document.id, transactionId));
    const lockPaths = [workspaceLockPath(workspaceRoot), planLockPath(workspaceRoot, document.id)];
    const resourcePaths = [
      ...writeTargets,
      ...stagePaths,
      transactionJournalPath,
      ...lockPaths,
      ...lockPaths.map((lock) => `${lock}.reclaim`),
      ...lockPaths.flatMap((lock) => [`${lock}.dead-${transactionId}-workspace-reclaim`, `${lock}.dead-${transactionId}-plan-reclaim`]),
      ...lockPaths.map((lock, index) => `${lock}.release-${transactionId}-${index === 0 ? "workspace" : "plan"}`),
      ...writeTargets.map(dirname),
      dirname(transactionJournalPath),
    ];
    const writeIntent = {
      writePaths: writeTargets,
      journalPath: transactionJournalPath,
      lockPaths,
      stagingPaths: stagePaths,
      resources: [...new Set([...resourcePaths, ...resourcePaths.flatMap((path) => parentDirectories(workspaceRoot, path))])],
    };
    const activeAfterCompaction = {
      phaseCount: document.phases.length - selection.selectedPhases.length,
      noteCount: document.notes.length - selection.selectedNotes.length + 1,
      findingCount: document.reviewFindings.length - selection.selectedFindings.length,
      openFindingCount: document.reviewFindings.filter((finding) => finding.status !== "resolved").length,
    };
    const removalDigest = digest(payload.removals);
    context.metadata({ title: "Compact workplan", metadata: { workspaceRoot, id: document.id, mode, stateHash: snapshot.stateHash } });
    if (mode === "preview") {
      return formatOutput({
        mode,
        workplanId: document.id,
        confirmationRequiredForApply: APPLY_CONFIRMATION,
        requiresFreshCheckpoint: true,
        checkpointFreshness: checkpointFresh.freshness,
        archiveReason: reason,
        previewToken: token,
        planHash: snapshot.planHash,
        stateHash: snapshot.stateHash,
        canonicalSelection: {
          completedPhaseIds: phaseIds,
          noteIndexes: selectedNoteIndexes,
          resolvedFindingIndexes: selectedFindingIndexes,
        },
        selected: {
          completedPhases: selection.selectedPhases.map((phase) => ({ id: phase.id, title: phase.title, stepCount: phase.steps.length })),
          notes: selection.selectedNotes.map(({ index, text }) => ({ index, preview: safePreview(text), contentHash: digest(text) })),
          resolvedFindings: selection.selectedFindings.map(({ index, finding }) => ({ index, severity: finding.severity, title: finding.title, contentHash: digest(finding) })),
        },
        removals: {
          digest: removalDigest,
          phaseCount: selection.selectedPhases.length,
          noteCount: selection.selectedNotes.length,
          resolvedFindingCount: selection.selectedFindings.length,
        },
        activeAfterCompaction,
        protected: ["scope", "nonGoals", "constraints", "unfinished phases and steps", "open findings", "handwritten Markdown"],
        linkedMarkdownTreatment: markdownWasGenerated ? "generated-refresh" : "preserved",
        archivePath: archiveFile,
        writeIntent,
      });
    }

    if (input.confirmation !== APPLY_CONFIRMATION) throw new Error(`Apply requires confirmation=${APPLY_CONFIRMATION}`);
    if (!selectionCount) throw new Error("Select at least one completed phase, note, or resolved finding to archive");
    if (!checkpointFresh.planFresh || checkpointRead.checkpoint?.schemaVersion !== 2) {
      throw new Error("A fresh version-2 multiartifact checkpoint is required; write a checkpoint after the latest plan update, then preview again");
    }
    if (input.previewToken !== token) throw new Error("previewToken does not match the current snapshot, reason, exact selection, removals, or Markdown treatment; preview again before applying");

    const checkpoint = checkpointRead.checkpoint as WorkplanCheckpointV2;
    const now = new Date().toISOString();
    const archive = {
      archiveVersion: 1,
      workplanId: document.id,
      archivedAt: now,
      reason,
      previewToken: token,
      removed: {
        completedPhaseIds: selection.selectedPhases,
        noteIndexes: selection.selectedNotes,
        resolvedFindingIndexes: selection.selectedFindings,
        digest: removalDigest,
      },
      source: {
        workplanJsonPath: relative(workspaceRoot, path).replaceAll("\\", "/"),
        workplanJson: snapshot.raw,
        linkedMarkdownPath: document.planFile,
        linkedMarkdown: markdown,
        checkpointPath: relative(workspaceRoot, checkpointFile).replaceAll("\\", "/"),
        checkpoint: snapshot.checkpointContent?.toString("utf8") ?? null,
        dependencyPath: relative(workspaceRoot, dependencyFile).replaceAll("\\", "/"),
        dependencies: snapshot.dependencyContent?.toString("utf8") ?? null,
      },
    };

    const archivedPhaseSet = new Set(phaseIds);
    const archivedNoteSet = new Set(selectedNoteIndexes);
    const archivedFindingSet = new Set(selectedFindingIndexes);
    document.phases = document.phases.filter((phase) => !archivedPhaseSet.has(phase.id));
    document.notes = document.notes.filter((_note, index) => !archivedNoteSet.has(index));
    document.reviewFindings = document.reviewFindings.filter((_finding, index) => !archivedFindingSet.has(index));
    document.notes.push(`Compaction archive: ${archiveRelativePath}`);
    document.updatedAt = now;
    const compactedJson = serializeWorkplanDocument(document, { omitSpecFiles: !snapshot.specFilesPresent });
    const compactedMarkdown = markdownWasGenerated ? renderWorkplanMarkdown(document) : null;
    const targets: MutationTarget[] = [
      { path: archiveFile, content: `${JSON.stringify(archive, null, 2)}\n`, before: null, label: "Workplan archive" },
      { path, content: compactedJson, before: Buffer.from(snapshot.raw), label: "Workplan file" },
    ];
    if (compactedMarkdown !== null) targets.push({ path: planPath, content: compactedMarkdown, before: snapshot.planContent, label: "Plan file" });

    if (dependencyRead.recorded) {
      const remaining = dependencyRead.dependencies.filter((entry) => !archivedPhaseSet.has(entry.phaseId));
      const survivingKeys = new Set(document.phases.flatMap((phase) => phase.steps.map((step) => `${phase.id}\u0000${step.id}`)));
      const referencedTerminal = new Set(remaining.flatMap((entry) => entry.dependsOn
        .filter((reference) => !survivingKeys.has(`${reference.phaseId}\u0000${reference.stepId}`))
        .map((reference) => `${reference.phaseId}\u0000${reference.stepId}`)));
      const terminalByKey = new Map<string, WorkplanTerminalDependencySummary>();
      for (const summary of dependencyRead.terminalSummaries) {
        const key = `${summary.phaseId}\u0000${summary.stepId}`;
        if (referencedTerminal.has(key)) terminalByKey.set(key, summary);
      }
      for (const phase of selection.selectedPhases) for (const step of phase.steps) {
        const key = `${phase.id}\u0000${step.id}`;
        if (referencedTerminal.has(key)) terminalByKey.set(key, { phaseId: phase.id, stepId: step.id, title: step.title, status: "completed" });
      }
      const dependencies: WorkplanDependency[] = remaining.map((entry) => ({
        ...entry,
        dependsOn: entry.dependsOn.filter((reference) => survivingKeys.has(`${reference.phaseId}\u0000${reference.stepId}`) || terminalByKey.has(`${reference.phaseId}\u0000${reference.stepId}`)),
      }));
      const sidecar = createDependencySidecar(document.id, dependencies, now, [...terminalByKey.values()]);
      const checkedDependencies = validateDependencyRecords(JSON.stringify(sidecar), document.id, document);
      if (checkedDependencies.issues.length) throw new Error(`Compaction would invalidate dependency metadata: ${checkedDependencies.issues.join("; ")}`);
      targets.push({ path: dependencyFile, content: `${JSON.stringify(sidecar, null, 2)}\n`, before: snapshot.dependencyContent, label: "Workplan dependencies" });
    }

    const planChanges = [{ path, content: compactedJson }, ...(compactedMarkdown === null ? [] : [{ path: planPath, content: compactedMarkdown }])];
    const nextPlan = planHashWithArtifactChanges(snapshot, planChanges);
    const nextCheckpoint: WorkplanCheckpointV2 = {
      ...checkpoint,
      sourceUpdatedAt: document.updatedAt,
      planHash: nextPlan.planHash,
      manifest: nextPlan.manifest,
      updatedAt: now,
      references: [...new Set([...checkpoint.references, archiveRelativePath])].slice(-10),
      evidenceStatus: "unverified",
    };
    targets.push({ path: checkpointFile, content: `${JSON.stringify(nextCheckpoint, null, 2)}\n`, before: snapshot.checkpointContent, label: "Workplan checkpoint" });
    const result = await commitWorkplanMutation({
      workspaceRoot,
      id: document.id,
      operation: "compact:apply",
      initialSnapshot: snapshot,
      expectedHash: input.expectedHash,
      transactionId,
      requiredAbsentPaths: [archiveFile],
      preflight: async (currentSnapshot) => {
        if (!currentSnapshot || previewToken(previewPayload(currentSnapshot, reason, phaseIds, selectedNoteIndexes, selectedFindingIndexes)) !== input.previewToken) {
          throw new Error("Compaction preview changed before publication; no archive or mutation was written");
        }
      },
      targets,
      invocation: context as WorkplanMutationInvocation,
    });

    return formatOutput({
      compacted: true,
      workplanId: document.id,
      archivePath: archiveFile,
      previewToken: token,
      archived: { phaseCount: selection.selectedPhases.length, noteCount: selection.selectedNotes.length, resolvedFindingCount: selection.selectedFindings.length },
      activeAfterCompaction,
      linkedMarkdownUpdated: markdownWasGenerated,
      checkpointRefreshed: true,
      planHash: result.snapshot.planHash,
      stateHash: result.snapshot.stateHash,
      directorySync: result.directorySync,
    });
  },
});
