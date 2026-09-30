import { tool } from "./tool";

import { assertUniqueWorkplanIds, canonicalizeWorkspaceRoot, formatOutput, resolveToolWorkspaceRoot } from "./shared";
import { workplanCheckpointArgs, workplanInputSchemas } from "./schemas";
import {
  checkpointPath,
  checkpointFreshness,
  checkpointReadFromContent,
  readStableWorkplan,
  selectCheckpointPosition,
} from "./checkpoint-shared";
import type { WorkplanCheckpointV2 } from "./checkpoint-shared";
import { assertNoPendingTransaction, commitWorkplanMutation, throwIfAborted } from "./transaction";
import type { WorkplanMutationInvocation } from "./transaction";

function cleanStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

export const workplan_checkpoint = tool({
  description:
    "Write a concise, structured handoff checkpoint for the next session without replacing the full workplan. Include the current task, immediate next action, blockers, validation, and safety guardrails.",
  args: workplanCheckpointArgs,
  async execute(args, context) {
    const input = workplanInputSchemas.checkpoint.parse(args);
    throwIfAborted(context.abort);
    const workspaceRoot = await canonicalizeWorkspaceRoot(resolveToolWorkspaceRoot(context, input.workspaceRoot));
    const snapshot = await readStableWorkplan(workspaceRoot, input.id);
    await assertNoPendingTransaction(snapshot);
    const { document } = snapshot;
    assertUniqueWorkplanIds(document);
    const summary = input.summary.trim();
    const nextAction = input.nextAction.trim();
    if (!summary) throw new Error("Checkpoint summary cannot be empty");
    if (!nextAction) throw new Error("Checkpoint nextAction cannot be empty");

    const checkpointFile = checkpointPath(workspaceRoot, document.id);
    const prior = checkpointReadFromContent(snapshot.checkpointContent, document.id, checkpointFile);
    if (prior.diagnostic) throw new Error(`${prior.diagnostic}; inspect the artifact before replacing it`);
    const current = selectCheckpointPosition(document, input.phaseId, input.stepId);
    const now = new Date().toISOString();
    const checkpoint: WorkplanCheckpointV2 = {
      schemaVersion: 2,
      id: document.id,
      sourceUpdatedAt: document.updatedAt,
      planHash: snapshot.planHash,
      manifest: snapshot.planManifest,
      evidenceStatus: "unverified",
      createdAt: prior.checkpoint?.createdAt ?? now,
      updatedAt: now,
      status: document.status,
      summary,
      current,
      nextAction,
      blockers: cleanStrings(input.blockers),
      recentValidation: cleanStrings(input.recentValidation),
      guardrails: cleanStrings(input.guardrails),
      references: cleanStrings(input.references),
    };

    context.metadata({ title: "Checkpoint workplan", metadata: { workspaceRoot, id: document.id } });
    const result = await commitWorkplanMutation({
      workspaceRoot,
      id: document.id,
      operation: "checkpoint",
      initialSnapshot: snapshot,
      expectedHash: input.expectedHash,
      targets: [{ path: checkpointFile, content: `${JSON.stringify(checkpoint, null, 2)}\n`, before: snapshot.checkpointContent, label: "Workplan checkpoint" }],
      invocation: context as WorkplanMutationInvocation,
    });
    const freshness = checkpointFreshness(checkpoint, result.snapshot, null);
    return formatOutput({ checkpointPath: checkpointFile, checkpoint, planFresh: freshness.planFresh, evidenceStatus: "unverified", planHash: result.snapshot.planHash, stateHash: result.snapshot.stateHash, directorySync: result.directorySync });
  },
});
