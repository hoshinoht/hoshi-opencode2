// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";

import { validateDependencyRecords } from "./dependencies";
import { workplanInputSchemas, workplanInspectArgs, workplanInspectCursorSchema } from "./schemas";
import {
  assertUniqueWorkplanIds,
  canonicalizeWorkspaceRoot,
  formatOutput,
  phaseMarker,
  resolveToolWorkspaceRoot,
  stepMarker,
  summarize,
} from "./shared";
import { readWorkplanSnapshot } from "./snapshot";
import { defineWorkplanTool } from "./tool";

type InspectCursor = { version: 1; stateHash: string; phaseId: string | null; limit: number; offset: number };

function cursorChecksum(cursor: InspectCursor): string {
  const ordered: InspectCursor = {
    version: cursor.version,
    stateHash: cursor.stateHash,
    phaseId: cursor.phaseId,
    limit: cursor.limit,
    offset: cursor.offset,
  };
  return createHash("sha256").update(`workplan-inspect-cursor-v1\n${JSON.stringify(ordered)}`).digest("hex");
}

function encodeCursor(cursor: InspectCursor): string {
  return Buffer.from(JSON.stringify({ ...cursor, checksum: cursorChecksum(cursor) }), "utf8").toString("base64url");
}

function decodeCursor(token: string): InspectCursor {
  try {
    const parsed = workplanInspectCursorSchema.safeParse(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
    if (!parsed.success) throw new Error("schema");
    const { checksum, ...cursor } = parsed.data;
    if (cursorChecksum(cursor) !== checksum) throw new Error("checksum");
    return cursor;
  } catch {
    throw new Error("Invalid workplan inspect cursor; restart without a cursor");
  }
}

type PhaseRecord = {
  type: "phase";
  id: string;
  title: string;
  status: string;
  index: number;
  indexLabel: string;
  stepCount: number;
  markdownMarker: string;
};

type StepRecord = {
  type: "step";
  phaseId: string;
  phaseTitle: string;
  id: string;
  title: string;
  status: string;
  target: string | null;
  index: number;
  indexPath: string;
  markdownMarker: string;
};

export const workplan_inspect = defineWorkplanTool({
  description: "List a workplan's stable phase and step ids and Markdown markers without returning the Markdown content.",
  args: workplanInspectArgs,
  async execute(args, context) {
    const input = workplanInputSchemas.inspect.parse(args);
    const root = await canonicalizeWorkspaceRoot(resolveToolWorkspaceRoot(context, input.workspaceRoot));
    const snap = await readWorkplanSnapshot(root, input.id);
    const limit = input.limit ?? 100;
    const doc = snap.document;
    const dependencies = validateDependencyRecords(snap.dependencyContent, doc.id, doc);

    if (snap.journalContent) {
      return formatOutput({
        recoveryRequired: true,
        journalPath: `.opencode/workplan/${snap.id}.transaction.json`,
        planHash: snap.planHash,
        stateHash: snap.stateHash,
      });
    }

    assertUniqueWorkplanIds(doc);
    const phaseId = input.phaseId ? input.phaseId : null;
    if (phaseId !== null && !doc.phases.some((phase) => phase.id === phaseId)) throw new Error(`Phase not found: ${phaseId}`);

    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    if (cursor && (cursor.stateHash !== snap.stateHash || cursor.phaseId !== phaseId || cursor.limit !== limit)) {
      throw new Error("Stale or option-mismatched workplan inspect cursor; restart from the first page");
    }

    const items: Array<PhaseRecord | StepRecord> = [];
    doc.phases.forEach((phase, phaseIndex) => {
      if (phaseId !== null && phase.id !== phaseId) return;
      items.push({
        type: "phase",
        id: phase.id,
        title: phase.title,
        status: phase.status,
        index: phaseIndex,
        indexLabel: `${phaseIndex + 1}`,
        stepCount: phase.steps.length,
        markdownMarker: phaseMarker(phase.id),
      });
      phase.steps.forEach((step, stepIndex) => {
        items.push({
          type: "step",
          phaseId: phase.id,
          phaseTitle: phase.title,
          id: step.id,
          title: step.title,
          status: step.status,
          target: step.target ?? null,
          index: stepIndex,
          indexPath: `${phaseIndex + 1}.${stepIndex + 1}`,
          markdownMarker: stepMarker(step.id),
        });
      });
    });

    const offset = cursor?.offset ?? 0;
    const page = items.slice(offset, offset + limit);
    const next = offset + page.length;
    const total = items.length;

    context.metadata({ title: "Inspect workplan", metadata: { workspaceRoot: root, id: snap.id, stateHash: snap.stateHash } });

    return formatOutput({
      path: snap.path,
      workplan: summarize(doc),
      plan: { path: snap.planPath, exists: snap.planContent !== null },
      phases: page.filter((item): item is PhaseRecord => item.type === "phase"),
      steps: page.filter((item): item is StepRecord => item.type === "step"),
      dependencies,
      pagination: {
        total,
        offset,
        returned: page.length,
        omitted: Math.max(0, total - next),
        nextCursor: next < total ? encodeCursor({ version: 1, stateHash: snap.stateHash, phaseId, limit, offset: next }) : null,
      },
      planHash: snap.planHash,
      stateHash: snap.stateHash,
    });
  },
});
