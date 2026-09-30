// SPDX-License-Identifier: GPL-3.0-or-later
import { validateDependencyRecords } from "./dependencies";
import { validateWorkplanStructure, workplanInputSchemas, workplanValidateArgs } from "./schemas";
import { canonicalizeWorkspaceRoot, formatOutput, resolveToolWorkspaceRoot, summarize } from "./shared";
import { readWorkplanSnapshot } from "./snapshot";
import { defineWorkplanTool } from "./tool";

export const workplan_validate = defineWorkplanTool({
  description:
    "Validate a workplan's JSON, linked Markdown and spec files before handing it to other agents. Read-only.",
  args: workplanValidateArgs,
  async execute(args, context) {
    const input = workplanInputSchemas.validate.parse(args);
    const root = await canonicalizeWorkspaceRoot(resolveToolWorkspaceRoot(context, input.workspaceRoot));
    context.metadata({ title: "Validate workplan", metadata: { workspaceRoot: root, id: input.id } });

    try {
      const snap = await readWorkplanSnapshot(root, input.id);
      const doc = snap.document;
      const structure = validateWorkplanStructure(doc, input.id);
      const issues = [...structure.issues];
      if (snap.planContent === null || snap.planContent.toString("utf8").trim() === "") {
        issues.push(`planFile: Linked Markdown is missing or empty: ${doc.planFile}`);
      }
      for (const [specFile, content] of snap.specContents) {
        if (content === null || content.toString("utf8").trim() === "") issues.push(`specFiles: Linked spec is missing or empty: ${specFile}`);
      }
      if (snap.journalContent) issues.push(`transaction: Recovery required at .opencode/workplan/${snap.id}.transaction.json`);
      const dependencies = validateDependencyRecords(snap.dependencyContent, doc.id, doc);
      for (const issue of dependencies.issues) issues.push(`dependencies: ${issue}`);

      return formatOutput({
        path: snap.path,
        planPath: snap.planPath,
        valid: issues.length === 0,
        issueCount: issues.length,
        issues,
        workplan: summarize(doc),
        planHash: snap.planHash,
        stateHash: snap.stateHash,
        planFresh: snap.missingPlanArtifacts.length === 0,
        dependenciesRecorded: dependencies.recorded,
      });
    } catch (error) {
      return formatOutput({ valid: false, issueCount: 1, issues: [error instanceof Error ? error.message : String(error)] });
    }
  },
});
