// SPDX-License-Identifier: GPL-3.0-or-later
// Shared helpers: roots, ids, paths, serialisation and Markdown rendering.
import { randomInt } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  FindingSeverity,
  WorkplanDocument,
  WorkplanFinding,
  WorkplanPhase,
  WorkplanStatus,
  WorkplanStep,
} from "./types";

// ---------------------------------------------------------------------------
// Output and roots
// ---------------------------------------------------------------------------

export function formatOutput(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function resolveWorkspaceRoot(baseDirectory: string, workspaceRoot?: string): string {
  if (!workspaceRoot) return resolve(baseDirectory);
  const expanded = expandHome(workspaceRoot);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDirectory, expanded);
}

export function resolveToolWorkspaceRoot(context: { directory: string; worktree?: string }, workspaceRoot?: string): string {
  return resolveWorkspaceRoot(context.worktree ?? context.directory, workspaceRoot);
}

export async function canonicalizeWorkspaceRoot(root: string): Promise<string> {
  return fs.realpath(resolve(root));
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function normalizeId(value: string): string {
  const id = slug(value);
  if (!id) throw new Error("Workplan id must contain at least one letter or number");
  return id;
}

const ID_ADJECTIVES = [
  "amber", "brisk", "calm", "clear", "cobalt", "deft", "eager", "fleet", "gentle", "hardy",
  "keen", "lucid", "mellow", "nimble", "plain", "quiet", "rapid", "steady", "tidy", "vivid",
];
const ID_NOUNS = [
  "anchor", "beacon", "bridge", "canyon", "cedar", "comet", "delta", "ember", "falcon", "harbor",
  "island", "lantern", "meadow", "orbit", "pebble", "quarry", "river", "summit", "thicket", "willow",
];

function pick(list: readonly string[]): string {
  return list[randomInt(list.length)]!;
}

export function createReadableId(prefix: string, usedIds?: ReadonlySet<string>): string {
  const base = normalizeId(prefix);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const digits = String(randomInt(1_000_000)).padStart(6, "0");
    const candidate = `${base}-${pick(ID_ADJECTIVES)}-${pick(ID_NOUNS)}-${digits}`;
    if (!usedIds?.has(candidate)) return candidate;
  }
  const fallback = `${base}-${String(Date.now()).slice(-6)}`;
  if (!usedIds?.has(fallback)) return fallback;
  throw new Error(`Unable to generate unique ${base} id`);
}

export function ensureEntityId(prefix: string, explicitId: string | undefined, usedIds?: Set<string>): string {
  const id = explicitId !== undefined && explicitId.trim() !== "" ? normalizeId(explicitId) : createReadableId(prefix, usedIds);
  if (usedIds?.has(id)) throw new Error(`Duplicate ${prefix} id: ${id}`);
  usedIds?.add(id);
  return id;
}

export function phaseMarker(id: string): string {
  return `<!-- workplan-phase-id: ${normalizeId(id)} -->`;
}

export function stepMarker(id: string): string {
  return `<!-- workplan-step-id: ${normalizeId(id)} -->`;
}

export function uniqueStrings(values?: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function isWithinWorkspaceRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedRoot === resolvedCandidate) return true;
  const rel = relative(resolvedRoot, resolvedCandidate);
  return (
    rel !== "" &&
    !rel.startsWith("..") &&
    !rel.includes(`${sep}..${sep}`) &&
    rel !== ".." &&
    !isAbsolute(rel)
  );
}

export function resolveWorkspaceFile(root: string, value: string): string {
  const expanded = expandHome(value.trim());
  return isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded);
}

export function normalizeWorkspaceFile(root: string, value: string, label = "File"): string {
  const resolved = resolveWorkspaceFile(root, value);
  if (!isWithinWorkspaceRoot(root, resolved)) throw new Error(`${label} must stay inside workspace root: ${value}`);
  const rel = relative(resolve(root), resolved);
  if (rel === "" || rel === ".") throw new Error(`${label} must point to a file inside the workspace root: ${value}`);
  return rel;
}

export function normalizePlanFile(root: string, value: string): string {
  const rel = normalizeWorkspaceFile(root, value, "Plan file");
  if (!rel.startsWith(`.opencode${sep}workplan${sep}`)) throw new Error(`Plan file must stay under .opencode/workplan/: ${value}`);
  if (!rel.endsWith(".md")) throw new Error(`Plan file must be Markdown under .opencode/workplan/: ${value}`);
  return rel;
}

export function normalizeSpecFiles(root: string, values?: string[]): string[] {
  return uniqueStrings((values ?? []).map((value) => normalizeWorkspaceFile(root, value, "Spec file")));
}

export function workplanDirectory(root: string): string {
  return join(root, ".opencode", "workplan");
}

export function workplanPath(root: string, id: string): string {
  return join(workplanDirectory(root), `${normalizeId(id)}.json`);
}

export function workplanMarkdownPath(root: string, id: string): string {
  return join(workplanDirectory(root), `${normalizeId(id)}.md`);
}

export type WorkplanArtifactKind = "plan" | "checkpoint" | "dependencies" | "transaction" | "lock" | "archive" | "temporary" | "other";

export function classifyWorkplanArtifact(name: string): WorkplanArtifactKind {
  if (name === "archive" || name.startsWith("archive/")) return "archive";
  if (name.endsWith(".checkpoint.json")) return "checkpoint";
  if (name.endsWith(".dependencies.json")) return "dependencies";
  if (name.endsWith(".transaction.json")) return "transaction";
  if (name.endsWith(".lock") || name.includes(".lock.")) return "lock";
  if (name.startsWith(".") && (name.endsWith(".stage") || name.includes(".tmp"))) return "temporary";
  if (name.endsWith(".json")) return "plan";
  return "other";
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

export async function assertSafePathAccess(root: string, target: string, label: string): Promise<void> {
  const resolvedRoot = resolve(root);
  let realRoot = resolvedRoot;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    realRoot = resolvedRoot;
  }
  const resolvedTarget = resolve(target);
  if (!isWithinWorkspaceRoot(resolvedRoot, resolvedTarget)) throw new Error(`${label} must stay inside workspace root: ${target}`);
  if (resolvedTarget === resolvedRoot) return;

  let current = resolvedRoot;
  for (const segment of relative(resolvedRoot, resolvedTarget).split(sep)) {
    if (!segment) continue;
    current = join(current, segment);
    try {
      const stats = await fs.lstat(current);
      if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${current}`);
      const real = await fs.realpath(current);
      if (!isWithinWorkspaceRoot(realRoot, real)) throw new Error(`${label} resolves outside workspace root: ${current}`);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
  }
}

export async function readOptionalFile(root: string, path: string, label = "File"): Promise<string | null> {
  await assertSafePathAccess(root, path, label);
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

/**
 * Legacy-path pre-prompt: when the resolved root lies outside the caller's worktree,
 * ask for external_directory access before anything under it is read.
 */
export async function promptExternalDirectory(
  context: {
    directory: string;
    worktree?: string;
    ask?: (input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => Promise<unknown>;
  },
  root: string,
  extraMetadata: Record<string, unknown> = {},
): Promise<void> {
  const base = context.worktree ?? context.directory;
  let worktree = base;
  try {
    worktree = await fs.realpath(base);
  } catch {
    worktree = base;
  }
  if (isWithinWorkspaceRoot(worktree, root) || !context.ask) return;
  const pattern = `${root.replaceAll("\\", "/")}/**`;
  await context.ask({
    permission: "external_directory",
    patterns: [pattern],
    always: [pattern],
    metadata: { filepath: root, parentDir: root, ...extraMetadata },
  });
}

export function resolveLinkedPlanPath(root: string, document: WorkplanDocument): string {
  return resolveWorkspaceFile(root, document.planFile);
}

// ---------------------------------------------------------------------------
// Serialisation and rendering
// ---------------------------------------------------------------------------

export function serializeWorkplanDocument(document: WorkplanDocument, options?: { omitSpecFiles?: boolean }): string {
  const copy: Record<string, unknown> = { ...document };
  if (options?.omitSpecFiles) delete copy.specFiles;
  return `${JSON.stringify(copy, null, 2)}\n`;
}

function renderList(values: readonly string[] | undefined): string {
  if (!values || values.length === 0) return "_None_";
  return values.map((value) => `- ${value}`).join("\n");
}

function renderFindings(findings: readonly WorkplanFinding[]): string {
  if (findings.length === 0) return "_None_";
  return findings
    .map((finding) => {
      let line = `- [${finding.severity}] ${finding.title}`;
      if (finding.status) line += `(${finding.status})`;
      if (finding.detail) line += `— ${finding.detail}`;
      if (finding.source) line += ` [source: ${finding.source}]`;
      return line;
    })
    .join("\n");
}

function renderPhases(phases: readonly WorkplanPhase[]): string {
  if (phases.length === 0) return "_No phases defined yet._";
  return phases
    .map((phase, phaseIndex) => {
      const n = phaseIndex + 1;
      const lines = [`### ${n}. ${phase.title} ${phaseMarker(phase.id)}`, `- Status: ${phase.status}`, `- Id: ${phase.id}`];
      if (phase.steps.length === 0) {
        lines.push("- Steps: _None yet_");
      } else {
        phase.steps.forEach((step, stepIndex) => {
          lines.push(`#### ${n}.${stepIndex + 1} ${step.title} ${stepMarker(step.id)}`);
          lines.push(`- Status: ${step.status}`);
          lines.push(`- Id: ${step.id}`);
          if (step.target) lines.push(`- Target: ${step.target}`);
          if (step.action) lines.push(`- Action: ${step.action}`);
          if (step.validation) lines.push(`- Validation: ${step.validation}`);
        });
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

export function renderWorkplanMarkdown(document: WorkplanDocument): string {
  const title = document.title?.trim() || document.id;
  return [
    `# ${title}`,
    "",
    "## Goal",
    document.goal,
    "",
    "## Scope",
    renderList(document.scope),
    "",
    "## Non-goals",
    renderList(document.nonGoals),
    "",
    "## Constraints",
    renderList(document.constraints),
    "",
    "## Relevant files",
    renderList(document.relevantFiles),
    "",
    "## Spec files",
    renderList(document.specFiles),
    "",
    "## Execution phases",
    renderPhases(document.phases),
    "",
    "## Adversarial review findings",
    renderFindings(document.reviewFindings),
    "",
    "## Notes",
    renderList(document.notes),
    "",
    "## Status",
    `- Overall status: ${document.status}`,
    `- Metadata file: .opencode/workplan/${document.id}.json`,
    `- Detailed plan file: ${document.planFile}`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Normalisation of input entities
// ---------------------------------------------------------------------------

type StepInput = { id?: string; title: string; target?: string; action?: string; validation?: string; status?: WorkplanStatus };
type PhaseInput = { id?: string; title: string; status?: WorkplanStatus; steps?: StepInput[] };
type FindingInput = { severity: FindingSeverity; title: string; detail?: string; source?: string; status?: "open" | "resolved" };

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeStep(step: StepInput, index: number, options?: { usedIds?: Set<string> }): WorkplanStep {
  const title = step.title.trim();
  if (!title) throw new Error(`Step ${index + 1} is missing a title`);
  return {
    id: ensureEntityId("step", step.id, options?.usedIds),
    title,
    target: optionalText(step.target),
    action: optionalText(step.action),
    validation: optionalText(step.validation),
    status: step.status ?? "draft",
  };
}

export function normalizePhase(phase: PhaseInput, index: number, options?: { usedPhaseIds?: Set<string> }): WorkplanPhase {
  const title = phase.title.trim();
  if (!title) throw new Error(`Phase ${index + 1} is missing a title`);
  const id = ensureEntityId("phase", phase.id, options?.usedPhaseIds);
  const usedStepIds = new Set<string>();
  return {
    id,
    title,
    status: phase.status ?? "draft",
    steps: (phase.steps ?? []).map((step, stepIndex) => normalizeStep(step, stepIndex, { usedIds: usedStepIds })),
  };
}

export function normalizeFinding(finding: FindingInput, index: number): WorkplanFinding {
  const title = finding.title.trim();
  if (!title) throw new Error(`Finding ${index + 1} is missing a title`);
  return {
    severity: finding.severity,
    title,
    detail: optionalText(finding.detail),
    source: optionalText(finding.source),
    status: finding.status ?? "open",
  };
}

export function getPhaseById(document: WorkplanDocument, phaseId: string): { phase: WorkplanPhase; index: number } {
  const id = normalizeId(phaseId);
  const index = document.phases.findIndex((phase) => phase.id === id);
  if (index < 0) throw new Error(`Phase not found: ${id}`);
  return { phase: document.phases[index]!, index };
}

export function getStepById(phase: WorkplanPhase, stepId: string): { step: WorkplanStep; index: number } {
  const id = normalizeId(stepId);
  const index = phase.steps.findIndex((step) => step.id === id);
  if (index < 0) throw new Error(`Step not found in phase ${phase.id}: ${id}`);
  return { step: phase.steps[index]!, index };
}

export function assertUniqueWorkplanIds(document: WorkplanDocument): void {
  const phaseIds = new Set<string>();
  for (const phase of document.phases) {
    if (phaseIds.has(phase.id)) {
      throw new Error(`Workplan ${document.id} has duplicate phase id: ${phase.id}. Migrate ids before targeted inspect or update calls.`);
    }
    phaseIds.add(phase.id);
    const stepIds = new Set<string>();
    for (const step of phase.steps) {
      if (stepIds.has(step.id)) {
        throw new Error(
          `Workplan ${document.id} has duplicate step id in phase ${phase.id}: ${step.id}. Migrate ids before targeted inspect or update calls.`,
        );
      }
      stepIds.add(step.id);
    }
  }
}

export function summarize(document: WorkplanDocument) {
  return {
    id: document.id,
    kind: document.kind,
    title: document.title,
    goal: document.goal,
    status: document.status,
    planFile: document.planFile,
    phaseCount: document.phases.length,
    stepCount: document.phases.reduce((total, phase) => total + phase.steps.length, 0),
    specFileCount: document.specFiles?.length ?? 0,
    openFindingCount: document.reviewFindings.filter((finding) => finding.status !== "resolved").length,
    updatedAt: document.updatedAt,
  };
}
