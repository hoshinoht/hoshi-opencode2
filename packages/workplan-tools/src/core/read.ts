// SPDX-License-Identifier: GPL-3.0-or-later
import { validateDependencyRecords } from "./dependencies";
import { workplanInputSchemas, workplanReadArgs } from "./schemas";
import { canonicalizeWorkspaceRoot, formatOutput, resolveToolWorkspaceRoot } from "./shared";
import { readWorkplanSnapshot } from "./snapshot";
import { defineWorkplanTool } from "./tool";
import type { WorkplanPhase } from "./types";

export const workplan_read = defineWorkplanTool({
  description: "Read one workplan, optionally filtered to a phase or step, with its linked Markdown.",
  args: workplanReadArgs,
  async execute(args, context) {
    const input = workplanInputSchemas.read.parse(args);
    const root = await canonicalizeWorkspaceRoot(resolveToolWorkspaceRoot(context, input.workspaceRoot));
    const snap = await readWorkplanSnapshot(root, input.id);
    const doc = snap.document;
    const dependencies = validateDependencyRecords(snap.dependencyContent, doc.id, doc);

    let phases: WorkplanPhase[] = doc.phases;
    if (input.phaseId !== undefined) {
      const matches = phases.filter((phase) => phase.id === input.phaseId);
      if (matches.length !== 1) throw new Error(`Phase not found: ${input.phaseId}`);
      phases = matches;
    }
    if (input.stepId !== undefined) {
      const matches = phases.flatMap((phase) =>
        phase.steps.filter((step) => step.id === input.stepId).map((step) => ({ phase, step })),
      );
      if (matches.length !== 1) throw new Error(`Step filter must identify exactly one step: ${input.stepId}`);
      const [{ phase, step }] = matches as [{ phase: WorkplanPhase; step: WorkplanPhase["steps"][number] }];
      phases = [{ ...phase, steps: [step] }];
    }

    context.metadata({ title: "Read workplan", metadata: { workspaceRoot: root, id: snap.id, stateHash: snap.stateHash } });

    if (snap.journalContent) {
      return formatOutput({
        recoveryRequired: true,
        journalPath: `.opencode/workplan/${snap.id}.transaction.json`,
        planHash: snap.planHash,
        stateHash: snap.stateHash,
        workplan: null,
      });
    }

    const content = snap.planContent?.toString("utf8") ?? null;
    return formatOutput({
      path: snap.path,
      workplan: doc,
      selection: { phaseId: input.phaseId ?? null, stepId: input.stepId ?? null, phases },
      plan: {
        path: snap.planPath,
        exists: snap.planContent !== null,
        ...(input.includeMarkdown === false ? {} : { content }),
      },
      dependencies,
      planHash: snap.planHash,
      stateHash: snap.stateHash,
    });
  },
});
