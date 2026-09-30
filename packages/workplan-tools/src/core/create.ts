// SPDX-License-Identifier: GPL-3.0-or-later
import { promises as fs } from "node:fs";

import { workplanCreateArgs, workplanInputSchemas } from "./schemas";
import {
  canonicalizeWorkspaceRoot,
  formatOutput,
  normalizeFinding,
  normalizeId,
  normalizePhase,
  normalizePlanFile,
  normalizeSpecFiles,
  promptExternalDirectory,
  renderWorkplanMarkdown,
  resolveToolWorkspaceRoot,
  resolveWorkspaceFile,
  summarize,
  uniqueStrings,
  workplanMarkdownPath,
  workplanPath,
} from "./shared";
import { readWorkplanSnapshot, type WorkplanSnapshot } from "./snapshot";
import { checkpointPath, dependencyPath, journalPath } from "./storage-paths";
import { defineWorkplanTool } from "./tool";
import { assertMarkdownDestinationUnclaimed, commitWorkplanMutation, throwIfAborted } from "./transaction";
import type { WorkplanDocument } from "./types";

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

export const workplan_create = defineWorkplanTool({
  description:
    "Create a structured workplan under .opencode/workplan as a JSON document plus a linked Markdown plan.",
  args: workplanCreateArgs,
  async execute(args, context) {
    const input = workplanInputSchemas.create.parse(args);
    throwIfAborted(context.abort);
    const root = await canonicalizeWorkspaceRoot(resolveToolWorkspaceRoot(context, input.workspaceRoot));
    const id = normalizeId(input.id);
    const kind = input.kind.trim() || "general";
    const overwrite = input.overwrite;
    const path = workplanPath(root, id);
    const planFile = normalizePlanFile(root, input.planFile ?? workplanMarkdownPath(root, id));
    const planPath = resolveWorkspaceFile(root, planFile);

    context.metadata({ title: "Create workplan", metadata: { workspaceRoot: root, id, kind, overwrite } });
    await promptExternalDirectory(context, root, { workplan: id });

    const present = await exists(path);
    if (present && !overwrite) throw new Error(`Workplan already exists: ${path}`);
    if (!present && overwrite) throw new Error(`Cannot overwrite missing workplan: ${path}`);

    let snap: WorkplanSnapshot | null = null;
    if (present) {
      snap = await readWorkplanSnapshot(root, id);
      if (snap.document.planFile !== planFile) {
        throw new Error(
          `Overwrite target does not match the existing linked planFile ${snap.document.planFile}; use workplan_update to move or update it`,
        );
      }
    }
    const prior = snap?.planContent ?? null;
    if (prior !== null && snap && prior.toString("utf8") !== renderWorkplanMarkdown(snap.document) && !input.replaceMarkdown) {
      throw new Error("Refusing to replace handwritten Markdown; pass replaceMarkdown=true for an explicit full replacement");
    }
    if (!snap && (await exists(planPath))) throw new Error(`Plan file already exists: ${planPath}`);

    const now = new Date().toISOString();
    const usedPhaseIds = new Set<string>();
    const document: WorkplanDocument = {
      schemaVersion: 2,
      id,
      kind,
      title: input.title?.trim() || null,
      goal: input.goal.trim(),
      scope: uniqueStrings(input.scope),
      nonGoals: uniqueStrings(input.nonGoals),
      constraints: uniqueStrings(input.constraints),
      relevantFiles: uniqueStrings(input.relevantFiles),
      planFile,
      specFiles: normalizeSpecFiles(root, input.specFiles),
      phases: (input.phases ?? []).map((phase, index) => normalizePhase(phase, index, { usedPhaseIds })),
      reviewFindings: (input.reviewFindings ?? []).map((finding, index) => normalizeFinding(finding, index)),
      notes: uniqueStrings(input.notes),
      status: input.status,
      createdAt: now,
      updatedAt: now,
    };

    let markdown = input.planMarkdown ?? renderWorkplanMarkdown(document);
    if (!markdown.endsWith("\n")) markdown += "\n";

    const result = await commitWorkplanMutation({
      workspaceRoot: root,
      id,
      operation: overwrite ? "create:overwrite" : "create",
      initialSnapshot: snap,
      expectedHash: input.expectedHash,
      requiredAbsentPaths: overwrite ? [] : [path, planPath, checkpointPath(root, id), dependencyPath(root, id), journalPath(root, id)],
      targets: [
        { path, content: `${JSON.stringify(document, null, 2)}\n`, before: snap ? Buffer.from(snap.raw) : null, label: "Workplan file" },
        { path: planPath, content: markdown, before: prior, label: "Plan file" },
      ],
      preflight: () => assertMarkdownDestinationUnclaimed(root, id, planPath),
      invocation: context,
    });

    return formatOutput({
      created: !overwrite,
      overwritten: overwrite,
      path,
      planPath,
      workplan: summarize(document),
      planHash: result.snapshot.planHash,
      stateHash: result.snapshot.stateHash,
      directorySync: result.directorySync,
    });
  },
});
