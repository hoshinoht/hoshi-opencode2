// SPDX-License-Identifier: GPL-3.0-or-later
import { workplanInputSchemas, workplanResetArgs } from "./schemas";
import {
  canonicalizeWorkspaceRoot,
  formatOutput,
  renderWorkplanMarkdown,
  resolveToolWorkspaceRoot,
  serializeWorkplanDocument,
  summarize,
} from "./shared";
import { readWorkplanSnapshot } from "./snapshot";
import { defineWorkplanTool } from "./tool";
import { assertNoPendingTransaction, commitWorkplanMutation, throwIfAborted, type MutationTarget } from "./transaction";

export const workplan_reset = defineWorkplanTool({
  description:
    "Reset a workplan to the draft planning state, or only regenerate its linked Markdown from the JSON.",
  args: workplanResetArgs,
  async execute(args, context) {
    const input = workplanInputSchemas.reset.parse(args);
    throwIfAborted(context.abort);
    const root = await canonicalizeWorkspaceRoot(resolveToolWorkspaceRoot(context, input.workspaceRoot));
    const snap = await readWorkplanSnapshot(root, input.id);
    await assertNoPendingTransaction(snap);
    const doc = snap.document;

    const md = snap.planContent?.toString("utf8") ?? null;
    const generated = md !== null && md === renderWorkplanMarkdown(doc);
    if (md !== null && !generated && !input.replaceMarkdown) {
      throw new Error("Refusing to replace handwritten Markdown; pass replaceMarkdown=true for an explicit replacement");
    }

    const { mode, preserveNotes } = input;
    context.metadata({ title: "Reset workplan", metadata: { workspaceRoot: root, id: snap.id, mode, preserveNotes } });

    const targets: MutationTarget[] = [];
    if (mode === "draft") {
      doc.phases = [];
      doc.reviewFindings = [];
      doc.status = "draft";
      doc.updatedAt = new Date().toISOString();
      if (!preserveNotes) doc.notes = [];
      targets.push({
        path: snap.path,
        content: serializeWorkplanDocument(doc, { omitSpecFiles: !snap.specFilesPresent }),
        before: Buffer.from(snap.raw),
        label: "Workplan file",
      });
    }
    if (generated || input.replaceMarkdown || md === null) {
      targets.push({ path: snap.planPath, content: renderWorkplanMarkdown(doc), before: snap.planContent, label: "Plan file" });
    }
    if (targets.length === 0) throw new Error("Reset has no authorized artifact to change");

    const result = await commitWorkplanMutation({
      workspaceRoot: root,
      id: snap.id,
      operation: `reset:${mode}`,
      initialSnapshot: snap,
      expectedHash: input.expectedHash,
      targets,
      invocation: context,
    });

    return formatOutput({
      reset: true,
      mode,
      path: snap.path,
      planPath: snap.planPath,
      workplan: summarize(doc),
      planHash: result.snapshot.planHash,
      stateHash: result.snapshot.stateHash,
      directorySync: result.directorySync,
    });
  },
});
