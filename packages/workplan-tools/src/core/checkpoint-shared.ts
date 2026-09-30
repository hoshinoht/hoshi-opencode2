import { createHash } from "node:crypto";

import { normalizeId, readOptionalFile } from "./shared";
import type { WorkplanDocument, WorkplanManifestEntry, WorkplanPhase, WorkplanStatus, WorkplanStep } from "./types";
import { workplanCheckpointSchema } from "./schemas";
import { readWorkplanSnapshot, type WorkplanSnapshot } from "./snapshot";
import { checkpointPath } from "./storage-paths";

export { checkpointPath } from "./storage-paths";

export type CheckpointPosition = {
  phaseId: string;
  phaseTitle: string;
  phaseStatus: WorkplanStatus;
  stepId: string;
  stepTitle: string;
  stepStatus: WorkplanStatus;
} | null;

export type WorkplanCheckpointV1 = {
  schemaVersion: 1;
  id: string;
  sourceUpdatedAt: string;
  sourceHash: string;
  createdAt: string;
  updatedAt: string;
  status: WorkplanStatus;
  summary: string;
  current: CheckpointPosition;
  nextAction: string;
  blockers: string[];
  recentValidation: string[];
  guardrails: string[];
  references: string[];
};

export type WorkplanCheckpointV2 = Omit<WorkplanCheckpointV1, "schemaVersion" | "sourceHash"> & {
  schemaVersion: 2;
  planHash: string;
  manifest: WorkplanManifestEntry[];
  evidenceStatus: "unverified";
};

export type WorkplanCheckpoint = WorkplanCheckpointV1 | WorkplanCheckpointV2;

export type CheckpointRead = { checkpoint: WorkplanCheckpoint | null; diagnostic: string | null };

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function readStableWorkplan(workspaceRoot: string, id: string) {
  return readWorkplanSnapshot(workspaceRoot, id);
}

export async function readCheckpoint(workspaceRoot: string, id: string): Promise<WorkplanCheckpoint | null> {
  return (await readCheckpointResult(workspaceRoot, id)).checkpoint;
}

export async function readCheckpointResult(workspaceRoot: string, id: string): Promise<CheckpointRead> {
  const path = checkpointPath(workspaceRoot, id);
  const raw = await readOptionalFile(workspaceRoot, path, "Workplan checkpoint");
  return checkpointReadFromContent(raw, id, path);
}

export function checkpointReadFromContent(raw: string | Buffer | null, id: string, path = checkpointPath("", id)): CheckpointRead {
  if (raw === null) return { checkpoint: null, diagnostic: null };

  let value: unknown;
  try {
    value = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw);
  } catch (error) {
    return { checkpoint: null, diagnostic: `Invalid workplan checkpoint JSON at ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }

  const parsed = workplanCheckpointSchema.safeParse(value);
  if (!parsed.success) {
    return { checkpoint: null, diagnostic: `Invalid workplan checkpoint document at ${path}: ${parsed.error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`).join("; ")}` };
  }
  if (parsed.data.id !== normalizeId(id)) return { checkpoint: null, diagnostic: `Invalid workplan checkpoint id at ${path}` };
  return { checkpoint: parsed.data as WorkplanCheckpoint, diagnostic: null };
}

export function checkpointFreshness(checkpoint: WorkplanCheckpoint | null, snapshot: WorkplanSnapshot, diagnostic: string | null) {
  if (diagnostic) return { planFresh: false, freshness: "invalid" as const, diagnostic };
  if (!checkpoint) return { planFresh: false, freshness: "missing" as const, diagnostic: null };
  if (checkpoint.schemaVersion === 1) return { planFresh: false, freshness: "legacy-unverified" as const, diagnostic: "Checkpoint v1 only hashes JSON; multiartifact freshness is unverified" };
  const sortManifest = (manifest: WorkplanManifestEntry[]) => [...manifest].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifestMatches = JSON.stringify(sortManifest(checkpoint.manifest)) === JSON.stringify(sortManifest(snapshot.planManifest));
  const planFresh = snapshot.missingPlanArtifacts.length === 0 && checkpoint.planHash === snapshot.planHash && manifestMatches;
  return { planFresh, freshness: planFresh ? "fresh" as const : "stale" as const, diagnostic: planFresh ? null : "Checkpoint does not match the current JSON/Markdown/spec manifest" };
}

function terminal(status: WorkplanStatus): boolean {
  return status === "completed" || status === "cancelled";
}

function position(phase: WorkplanPhase, step: WorkplanStep | undefined): CheckpointPosition {
  if (!step) return null;
  return {
    phaseId: phase.id,
    phaseTitle: phase.title,
    phaseStatus: phase.status,
    stepId: step.id,
    stepTitle: step.title,
    stepStatus: step.status,
  };
}

function firstActiveStep(phase: WorkplanPhase): WorkplanStep | undefined {
  return (
    phase.steps.find((step) => step.status === "in_progress" || step.status === "blocked" || step.status === "review") ??
    phase.steps.find((step) => !terminal(step.status))
  );
}

export function selectCheckpointPosition(
  document: WorkplanDocument,
  phaseId?: string,
  stepId?: string,
): CheckpointPosition {
  if (stepId && !phaseId) {
    const normalizedStepId = normalizeId(stepId);
    const matches = document.phases.flatMap((phase) => phase.steps.filter((step) => step.id === normalizedStepId).map((step) => ({ phase, step })));
    if (matches.length !== 1) throw new Error(`Step id must identify exactly one phase: ${normalizedStepId}`);
    const match = matches[0]!;
    if (terminal(match.phase.status) || terminal(match.step.status)) throw new Error("Current checkpoint step must not be completed or cancelled");
    return position(match.phase, match.step);
  }

  const selectedPhase = phaseId
    ? document.phases.find((phase) => phase.id === normalizeId(phaseId))
    : document.phases.find((phase) => !terminal(phase.status) && firstActiveStep(phase));

  if (phaseId && !selectedPhase) throw new Error(`Phase not found: ${normalizeId(phaseId)}`);
  if (!selectedPhase) return null;
  if (terminal(selectedPhase.status)) throw new Error(`Current checkpoint phase is terminal: ${selectedPhase.id}`);

  if (stepId) {
    const selectedStep = selectedPhase.steps.find((step) => step.id === normalizeId(stepId));
    if (!selectedStep) throw new Error(`Step not found in phase ${selectedPhase.id}: ${normalizeId(stepId)}`);
    if (terminal(selectedStep.status)) throw new Error(`Current checkpoint step is terminal: ${selectedStep.id}`);
    return position(selectedPhase, selectedStep);
  }

  return position(selectedPhase, firstActiveStep(selectedPhase));
}
