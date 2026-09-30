// SPDX-License-Identifier: GPL-3.0-or-later
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { workplanInputSchemas, workplanListArgs } from "./schemas";
import {
  assertSafePathAccess,
  canonicalizeWorkspaceRoot,
  classifyWorkplanArtifact,
  formatOutput,
  normalizeId,
  resolveToolWorkspaceRoot,
  summarize,
  workplanDirectory,
} from "./shared";
import { readWorkplanSnapshot } from "./snapshot";
import { defineWorkplanTool } from "./tool";

type ListEntry = { id: string; valid: boolean; [key: string]: unknown };

function isFatalSafetyError(message: string): boolean {
  return /must not be a symlink|resolves outside workspace root/.test(message);
}

export const workplan_list = defineWorkplanTool({
  description: "List the workplans stored in .opencode/workplan with their validity and hashes.",
  args: workplanListArgs,
  async execute(args, context) {
    const input = workplanInputSchemas.list.parse(args);
    const root = await canonicalizeWorkspaceRoot(resolveToolWorkspaceRoot(context, input.workspaceRoot));
    const dir = workplanDirectory(root);
    context.metadata({ title: "List workplans", metadata: { workspaceRoot: root } });

    try {
      await assertSafePathAccess(root, dir, "Workplan directory");
      const entries = await fs.readdir(dir, { withFileTypes: true });

      const plans = await Promise.all(
        entries
          .filter((entry) => classifyWorkplanArtifact(entry.name) === "plan")
          .map(async (entry): Promise<ListEntry> => {
            const entryPath = join(dir, entry.name);
            const fid = entry.name.slice(0, -".json".length);
            try {
              await assertSafePathAccess(root, entryPath, "Workplan file");
              if (!entry.isFile()) throw new Error(`Workplan path is not a file: ${entryPath}`);
              let canonical: string;
              try {
                canonical = normalizeId(fid);
              } catch {
                canonical = "";
              }
              if (canonical !== fid) throw new Error(`Primary plan filename is not a canonical workplan id: ${entry.name}`);

              const snap = await readWorkplanSnapshot(root, fid);
              const issues: string[] = [];
              for (const missing of snap.missingPlanArtifacts) issues.push(`Missing linked artifact: ${missing}`);
              if (snap.planContent !== null && snap.planContent.toString("utf8").trim() === "") {
                issues.push(`Linked Markdown is empty: ${snap.document.planFile}`);
              }
              for (const [specFile, content] of snap.specContents) {
                if (content !== null && content.toString("utf8").trim() === "") issues.push(`Linked spec is empty: ${specFile}`);
              }
              return {
                valid: issues.length === 0,
                issues,
                ...summarize(snap.document),
                planHash: snap.planHash,
                stateHash: snap.stateHash,
                recoveryRequired: snap.journalContent !== null,
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (isFatalSafetyError(message)) throw error;
              return { id: fid, valid: false, issue: message };
            }
          }),
      );
      plans.sort((a, b) => a.id.localeCompare(b.id));

      const sidecars = entries
        .map((entry) => ({ name: entry.name, kind: classifyWorkplanArtifact(entry.name) }))
        .filter((entry) => entry.kind !== "plan" && entry.kind !== "other");

      return formatOutput({ workspaceRoot: root, directory: dir, count: plans.length, workplans: plans, sidecars });
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return formatOutput({ workspaceRoot: root, directory: dir, count: 0, workplans: [], sidecars: [] });
      }
      throw error;
    }
  },
});
