// SPDX-License-Identifier: GPL-3.0-or-later
import { createDependencySidecar, validateDependencyRecords } from "./dependencies";
import { workplanInputSchemas, workplanUpdateArgs } from "./schemas";
import {
  assertUniqueWorkplanIds,
  canonicalizeWorkspaceRoot,
  formatOutput,
  getPhaseById,
  getStepById,
  normalizeFinding,
  normalizePhase,
  normalizePlanFile,
  normalizeSpecFiles,
  normalizeStep,
  renderWorkplanMarkdown,
  resolveLinkedPlanPath,
  resolveToolWorkspaceRoot,
  serializeWorkplanDocument,
  summarize,
  uniqueStrings,
} from "./shared";
import { readWorkplanSnapshot } from "./snapshot";
import { dependencyPath } from "./storage-paths";
import { defineWorkplanTool } from "./tool";
import {
  assertMarkdownDestinationUnclaimed,
  assertNoPendingTransaction,
  commitWorkplanMutation,
  recoverWorkplanTransaction,
  throwIfAborted,
  type MutationTarget,
  type WorkplanMutationInvocation,
} from "./transaction";
import type { WorkplanDocument } from "./types";

const UPDATE_FIELD_ORDER = [
  "title",
  "goal",
  "status",
  "scope",
  "nonGoals",
  "constraints",
  "planFile",
  "planMarkdown",
  "specFiles",
  "reviewFindings",
  "phases",
  "updatePhases",
  "addPhases",
  "updateSteps",
  "addSteps",
  "addRelevantFiles",
  "addSpecFiles",
  "removeSpecFiles",
  "addReviewFindings",
  "appendNotes",
  "dependencies",
  "replaceMarkdown",
] as const;

/** Fields whose change regenerates Markdown that was previously generated. */
const REGENERATING_FIELDS = new Set<string>([
  "title",
  "goal",
  "status",
  "scope",
  "nonGoals",
  "constraints",
  "specFiles",
  "reviewFindings",
  "phases",
  "updatePhases",
  "addPhases",
  "updateSteps",
  "addSteps",
  "addRelevantFiles",
  "addSpecFiles",
  "removeSpecFiles",
  "addReviewFindings",
  "appendNotes",
]);

const TEXT_FIELDS = ["title", "goal", "planFile", "planMarkdown"] as const;
const ARRAY_FIELDS = [
  "scope",
  "nonGoals",
  "constraints",
  "specFiles",
  "reviewFindings",
  "phases",
  "addPhases",
  "addSteps",
  "addRelevantFiles",
  "addSpecFiles",
  "removeSpecFiles",
  "addReviewFindings",
  "appendNotes",
  "updatePhases",
  "updateSteps",
] as const;

function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function nonEmpty<T>(value: T[] | undefined): T[] | undefined {
  return value && value.length > 0 ? value : undefined;
}

function hasDefined(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => value[key] !== undefined);
}

export const workplan_update = defineWorkplanTool({
  description:
    "Update workplan metadata, the linked plan file, spec files, findings, dependencies, or targeted phase and step fields without rewriting the whole plan.",
  args: workplanUpdateArgs,
  async execute(args, context) {
    const parsed = workplanInputSchemas.update.parse(args);
    throwIfAborted(context.abort);
    const root = await canonicalizeWorkspaceRoot(resolveToolWorkspaceRoot(context, parsed.workspaceRoot));
    const snap = await readWorkplanSnapshot(root, parsed.id);

    if (parsed.recovery !== undefined) {
      const recovered = await recoverWorkplanTransaction({
        workspaceRoot: root,
        id: snap.id,
        recovery: parsed.recovery,
        expectedHash: parsed.expectedHash,
        initialSnapshot: snap,
        invocation: context as WorkplanMutationInvocation,
      });
      return formatOutput({
        recovered: true,
        recovery: parsed.recovery,
        id: snap.id,
        transactionId: recovered.transactionId,
        planHash: recovered.snapshot.planHash,
        stateHash: recovered.snapshot.stateHash,
        directorySync: recovered.directorySync,
      });
    }

    await assertNoPendingTransaction(snap);
    const doc: WorkplanDocument = snap.document;
    const before = structuredClone(doc);
    const prevPlanPath = resolveLinkedPlanPath(root, doc);
    const prevMd = snap.planContent?.toString("utf8") ?? null;
    const prevGenerated = prevMd !== null && prevMd === renderWorkplanMarkdown(before);

    // Placeholder filtering: blank strings, draft status and empty arrays mean "absent".
    const input: typeof parsed = { ...parsed };
    for (const key of TEXT_FIELDS) input[key] = blankToUndefined(input[key]);
    if (input.status === "draft") input.status = undefined;
    for (const key of ARRAY_FIELDS) (input as Record<string, unknown>)[key] = nonEmpty(input[key] as unknown[] | undefined);
    if (input.updatePhases) {
      input.updatePhases = nonEmpty(
        input.updatePhases
          .map((patch) => ({
            ...patch,
            title: blankToUndefined(patch.title),
            status: patch.status === "draft" ? undefined : patch.status,
          }))
          .filter((patch) => hasDefined(patch, ["title", "status"])),
      );
    }
    if (input.updateSteps) {
      input.updateSteps = nonEmpty(
        input.updateSteps
          .map((patch) => ({
            ...patch,
            title: blankToUndefined(patch.title),
            target: blankToUndefined(patch.target),
            action: blankToUndefined(patch.action),
            validation: blankToUndefined(patch.validation),
            status: patch.status === "draft" ? undefined : patch.status,
          }))
          .filter((patch) => hasDefined(patch, ["title", "target", "action", "validation", "status"])),
      );
    }

    const updateFields = UPDATE_FIELD_ORDER.filter((key) =>
      key === "replaceMarkdown" ? input.replaceMarkdown === true : input[key] !== undefined,
    );
    context.metadata({ title: "Update workplan", metadata: { workspaceRoot: root, id: snap.id, updateFields } });

    if (
      input.updatePhases?.length ||
      input.updateSteps?.length ||
      input.addSteps !== undefined ||
      input.addPhases?.some((entry) => entry.afterPhaseId !== undefined)
    ) {
      assertUniqueWorkplanIds(doc);
    }

    if (input.title !== undefined) doc.title = input.title.trim() || null;
    if (input.goal !== undefined) doc.goal = input.goal.trim();
    if (input.status !== undefined) doc.status = input.status;
    if (input.scope) doc.scope = uniqueStrings(input.scope);
    if (input.nonGoals) doc.nonGoals = uniqueStrings(input.nonGoals);
    if (input.constraints) doc.constraints = uniqueStrings(input.constraints);
    if (input.planFile !== undefined) doc.planFile = normalizePlanFile(root, input.planFile);
    if (input.specFiles) doc.specFiles = normalizeSpecFiles(root, input.specFiles);
    if (input.reviewFindings) doc.reviewFindings = input.reviewFindings.map((finding, index) => normalizeFinding(finding, index));
    if (input.phases) {
      const usedPhaseIds = new Set<string>();
      doc.phases = input.phases.map((phase, index) => normalizePhase(phase, index, { usedPhaseIds }));
    }
    for (const patch of input.updatePhases ?? []) {
      const { phase } = getPhaseById(doc, patch.phaseId);
      if (patch.title !== undefined) {
        const title = patch.title.trim();
        if (!title) throw new Error(`Phase ${phase.id} title cannot be empty`);
        phase.title = title;
      }
      if (patch.status !== undefined) phase.status = patch.status;
    }
    if (input.addPhases) {
      const usedPhaseIds = new Set(doc.phases.map((phase) => phase.id));
      const insertedAfter = new Map<string, number>();
      for (const entry of input.addPhases) {
        const phase = normalizePhase(entry.phase, doc.phases.length, { usedPhaseIds });
        if (entry.afterPhaseId === undefined) {
          doc.phases.push(phase);
          continue;
        }
        const anchor = getPhaseById(doc, entry.afterPhaseId);
        const count = insertedAfter.get(anchor.phase.id) ?? 0;
        doc.phases.splice(anchor.index + 1 + count, 0, phase);
        insertedAfter.set(anchor.phase.id, count + 1);
      }
    }
    for (const patch of input.updateSteps ?? []) {
      const { phase } = getPhaseById(doc, patch.phaseId);
      const { step } = getStepById(phase, patch.stepId);
      if (patch.title !== undefined) {
        const title = patch.title.trim();
        if (!title) throw new Error(`Step ${step.id} title cannot be empty`);
        step.title = title;
      }
      if (patch.target !== undefined) step.target = patch.target.trim() || undefined;
      if (patch.action !== undefined) step.action = patch.action.trim() || undefined;
      if (patch.validation !== undefined) step.validation = patch.validation.trim() || undefined;
      if (patch.status !== undefined) step.status = patch.status;
    }
    if (input.addSteps) {
      const insertedAfter = new Map<string, number>();
      for (const entry of input.addSteps) {
        const { phase } = getPhaseById(doc, entry.phaseId);
        const usedIds = new Set(phase.steps.map((step) => step.id));
        const step = normalizeStep(entry.step, phase.steps.length, { usedIds });
        if (entry.afterStepId === undefined) {
          phase.steps.push(step);
          continue;
        }
        const anchor = getStepById(phase, entry.afterStepId);
        const key = `${phase.id}\u0000${anchor.step.id}`;
        const count = insertedAfter.get(key) ?? 0;
        phase.steps.splice(anchor.index + 1 + count, 0, step);
        insertedAfter.set(key, count + 1);
      }
    }
    if (input.addRelevantFiles) doc.relevantFiles = uniqueStrings([...doc.relevantFiles, ...input.addRelevantFiles]);
    if (input.addSpecFiles) doc.specFiles = normalizeSpecFiles(root, [...doc.specFiles, ...input.addSpecFiles]);
    if (input.removeSpecFiles) {
      const removals = new Set(normalizeSpecFiles(root, input.removeSpecFiles));
      doc.specFiles = doc.specFiles.filter((specFile) => !removals.has(specFile));
    }
    if (input.addReviewFindings) {
      doc.reviewFindings = [...doc.reviewFindings, ...input.addReviewFindings.map((finding, index) => normalizeFinding(finding, index))];
    }
    if (input.appendNotes) doc.notes = uniqueStrings([...doc.notes, ...input.appendNotes]);
    doc.updatedAt = new Date().toISOString();

    // Markdown decision.
    const planPath = resolveLinkedPlanPath(root, doc);
    const moved = planPath !== prevPlanPath;
    if (moved && prevMd === null && input.planMarkdown === undefined) {
      throw new Error("Cannot move workplan link because source Markdown is missing; supply a nonblank planMarkdown explicitly");
    }
    if (input.planMarkdown !== undefined && prevMd !== null && !prevGenerated && !input.replaceMarkdown) {
      throw new Error("Refusing to replace handwritten Markdown; pass replaceMarkdown=true for an explicit full replacement");
    }
    let markdown: string | null = null;
    if (input.planMarkdown !== undefined) {
      markdown = input.planMarkdown.endsWith("\n") ? input.planMarkdown : `${input.planMarkdown}\n`;
    } else if (moved) {
      markdown = prevGenerated ? renderWorkplanMarkdown(doc) : prevMd;
    } else if (
      (prevGenerated && updateFields.some((field) => REGENERATING_FIELDS.has(field))) ||
      (input.replaceMarkdown === true && updateFields.length > 0)
    ) {
      markdown = renderWorkplanMarkdown(doc);
    }
    const specFilesTouched = input.specFiles !== undefined || input.addSpecFiles !== undefined || input.removeSpecFiles !== undefined;
    const omitSpecFiles = !snap.specFilesPresent && !specFilesTouched;

    const targets: MutationTarget[] = [
      { path: snap.path, content: serializeWorkplanDocument(doc, { omitSpecFiles }), before: Buffer.from(snap.raw), label: "Workplan file" },
    ];
    if (markdown !== null) {
      targets.push({ path: planPath, content: markdown, before: moved ? null : snap.planContent, label: "Plan file" });
    }
    if (input.dependencies !== undefined) {
      const sidecar = createDependencySidecar(doc.id, input.dependencies);
      const check = validateDependencyRecords(JSON.stringify(sidecar), doc.id, doc);
      if (check.issues.length > 0) throw new Error(`Invalid dependency metadata: ${check.issues.join("; ")}`);
      targets.push({
        path: dependencyPath(root, doc.id),
        content: `${JSON.stringify(sidecar, null, 2)}\n`,
        before: snap.dependencyContent,
        label: "Workplan dependencies",
      });
    }

    const result = await commitWorkplanMutation({
      workspaceRoot: root,
      id: doc.id,
      operation: "update",
      initialSnapshot: snap,
      expectedHash: input.expectedHash,
      targets,
      requiredAbsentPaths: moved ? [planPath] : [],
      preflight: moved ? () => assertMarkdownDestinationUnclaimed(root, doc.id, planPath) : undefined,
      invocation: context,
    });

    return formatOutput({
      updated: true,
      path: snap.path,
      planPath,
      workplan: summarize(doc),
      planHash: result.snapshot.planHash,
      stateHash: result.snapshot.stateHash,
      directorySync: result.directorySync,
    });
  },
});
