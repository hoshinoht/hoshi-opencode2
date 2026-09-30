// SPDX-License-Identifier: GPL-3.0-or-later
import { workplanInputSchemas, workplanPatchArgs } from "./schemas";
import {
  canonicalizeWorkspaceRoot,
  normalizeWorkspaceFile,
  promptExternalDirectory,
  resolveToolWorkspaceRoot,
} from "./shared";
import { readWorkplanSnapshot } from "./snapshot";
import { defineWorkplanTool } from "./tool";
import { assertNoPendingTransaction, commitWorkplanMutation, throwIfAborted } from "./transaction";
import { workplan_validate } from "./validate";

type Hunk = { anchor: string | null; oldLines: string[]; newLines: string[]; hasChange: boolean };
type ParsedPatch = { target: string; hunks: Hunk[] };

const MOVE_TO_ERROR = "workplan_patch does not support Move to sections";

/** Parse the restricted single-file "Update File" patch grammar. */
export function parseWorkplanPatch(patchText: string): ParsedPatch {
  const lines = patchText.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.length < 2 || lines[0]!.trim() !== "*** Begin Patch" || lines[lines.length - 1]!.trim() !== "*** End Patch") {
    throw new Error("Invalid patch format: missing required Begin/End markers");
  }
  const body = lines.slice(1, -1);
  if (body.every((line) => line.trim() === "")) throw new Error("Patch rejected: empty patch");

  let target: string | null = null;
  const hunks: Hunk[] = [];
  let index = 0;
  while (index < body.length) {
    const line = body[index]!;
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (line.startsWith("*** Add File:")) throw new Error("workplan_patch does not support Add File sections");
    if (line.startsWith("*** Delete File:")) throw new Error("workplan_patch does not support Delete File sections");
    if (line.startsWith("*** Move to:")) throw new Error(MOVE_TO_ERROR);
    if (!line.startsWith("*** Update File:")) throw new Error(`Invalid patch line outside an update section: ${line}`);
    if (target !== null) throw new Error("workplan_patch allows exactly one Update File section");
    target = line.slice("*** Update File:".length).trim();
    if (!target) throw new Error("Update File section must include a target path");
    index += 1;
    if (body[index]?.startsWith("*** Move to:")) throw new Error(MOVE_TO_ERROR);

    while (index < body.length && !body[index]!.startsWith("***")) {
      const header = body[index]!;
      if (!header.startsWith("@@")) throw new Error(`Patch hunks must start with @@: ${header}`);
      const anchor = header.slice(2).trim();
      const hunk: Hunk = { anchor: anchor || null, oldLines: [], newLines: [], hasChange: false };
      index += 1;
      while (index < body.length && !body[index]!.startsWith("@@") && !body[index]!.startsWith("***")) {
        const hunkLine = body[index]!;
        if (hunkLine.startsWith(" ")) {
          hunk.oldLines.push(hunkLine.slice(1));
          hunk.newLines.push(hunkLine.slice(1));
        } else if (hunkLine.startsWith("-")) {
          hunk.oldLines.push(hunkLine.slice(1));
          hunk.hasChange = true;
        } else if (hunkLine.startsWith("+")) {
          hunk.newLines.push(hunkLine.slice(1));
          hunk.hasChange = true;
        } else {
          throw new Error(`Invalid hunk line; expected space, -, or + prefix: ${hunkLine}`);
        }
        index += 1;
      }
      if (hunk.oldLines.length === 0 && hunk.newLines.length === 0) throw new Error("Patch hunk must contain at least one prefixed line");
      hunks.push(hunk);
    }
  }
  if (target === null) throw new Error("Patch must include exactly one Update File section");
  if (hunks.length === 0) throw new Error("Patch rejected: no hunks found");
  if (!hunks.some((hunk) => hunk.hasChange)) throw new Error("Patch rejected: no additions or removals found");
  return { target, hunks };
}

function findSequence(lines: string[], needle: string[], from: number): number {
  for (let start = from; start + needle.length <= lines.length; start += 1) {
    let match = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (lines[start + offset] !== needle[offset]) {
        match = false;
        break;
      }
    }
    if (match) return start;
  }
  return -1;
}

/** Apply parsed hunks with exact matching; no whitespace fuzzing. */
export function applyWorkplanPatch(content: string, hunks: Hunk[], absPlanPath: string): string {
  const trailingNewline = content.endsWith("\n");
  const text = trailingNewline ? content.slice(0, -1) : content;
  const original = content === "" ? [] : text.split("\n");
  const replacements: Array<{ start: number; deleteCount: number; lines: string[] }> = [];
  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.anchor !== null) {
      const anchorIndex = original.indexOf(hunk.anchor, cursor);
      if (anchorIndex < 0) throw new Error(`Failed to find context '${hunk.anchor}' in ${absPlanPath}`);
      cursor = anchorIndex + 1;
    }
    if (hunk.oldLines.length === 0) {
      replacements.push({ start: cursor, deleteCount: 0, lines: hunk.newLines });
      continue;
    }
    const start = findSequence(original, hunk.oldLines, cursor);
    if (start < 0) throw new Error(`Failed to find expected lines in ${absPlanPath}:\n${hunk.oldLines.join("\n")}`);
    replacements.push({ start, deleteCount: hunk.oldLines.length, lines: hunk.newLines });
    cursor = start + hunk.oldLines.length;
  }
  const result = [...original];
  for (const replacement of [...replacements].reverse()) {
    result.splice(replacement.start, replacement.deleteCount, ...replacement.lines);
  }
  const joined = result.join("\n");
  return trailingNewline ? `${joined}\n` : joined;
}

export const workplan_patch = defineWorkplanTool({
  description:
    "Patch only the linked Markdown plan with a restricted single Update File patch; use workplan_update for JSON changes.",
  args: workplanPatchArgs,
  async execute(args, context) {
    const input = workplanInputSchemas.patch.parse(args);
    throwIfAborted(context.abort);
    const root = await canonicalizeWorkspaceRoot(resolveToolWorkspaceRoot(context, input.workspaceRoot));
    await promptExternalDirectory(context, root);

    const snap = await readWorkplanSnapshot(root, input.id);
    await assertNoPendingTransaction(snap);
    const doc = snap.document;
    const patch = parseWorkplanPatch(input.patchText);
    const target = normalizeWorkspaceFile(root, patch.target, "Patch target");
    if (target !== doc.planFile) throw new Error(`Patch target must match linked planFile ${doc.planFile}: ${patch.target}`);
    if (snap.planContent === null) throw new Error(`Plan file not found: ${doc.planFile}`);

    const original = snap.planContent.toString("utf8");
    const patched = applyWorkplanPatch(original, patch.hunks, snap.planPath);
    if (patched === original) throw new Error("Patch did not change the linked plan file");

    context.metadata({ title: "Patch workplan", metadata: { workspaceRoot: root, id: snap.id, planFile: doc.planFile } });
    const result = await commitWorkplanMutation({
      workspaceRoot: root,
      id: snap.id,
      operation: "patch",
      initialSnapshot: snap,
      expectedHash: input.expectedHash,
      targets: [{ path: snap.planPath, content: patched, before: snap.planContent, label: "Plan file" }],
      invocation: context,
    });

    const validate = input.validate === true;
    let validation: { valid: boolean; issueCount: number } | undefined;
    if (validate) {
      const report = JSON.parse(String(await workplan_validate.execute({ workspaceRoot: root, id: snap.id }, context))) as Record<string, unknown>;
      validation =
        typeof report.valid === "boolean" && typeof report.issueCount === "number"
          ? { valid: report.valid, issueCount: report.issueCount }
          : undefined;
    }

    const headline = `Patched workplan ${snap.id} plan file: ${doc.planFile}`;
    return {
      output: validate ? headline : `${headline}\nRun workplan_validate if you need full validation.`,
      metadata: {
        id: snap.id,
        planFile: doc.planFile,
        patched: true,
        validate,
        validation,
        planHash: result.snapshot.planHash,
        stateHash: result.snapshot.stateHash,
      },
    };
  },
});
