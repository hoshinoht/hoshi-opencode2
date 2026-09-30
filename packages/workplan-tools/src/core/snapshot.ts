import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { relative, resolve } from "node:path";

import {
  assertSafePathAccess,
  normalizePlanFile,
  normalizeSpecFiles,
  normalizeId,
  resolveWorkspaceFile,
  workplanPath,
} from "./shared";
import { formatWorkplanInputError, workplanDocumentSchema } from "./schemas";
import type { WorkplanDocument, WorkplanManifestEntry } from "./types";
import { checkpointPath, dependencyPath, journalPath } from "./storage-paths";

export type WorkplanSnapshot = {
  workspaceRoot: string;
  id: string;
  path: string;
  planPath: string;
  document: WorkplanDocument;
  specFilesPresent: boolean;
  raw: string;
  planContent: Buffer | null;
  specContents: Map<string, Buffer | null>;
  checkpointContent: Buffer | null;
  dependencyContent: Buffer | null;
  journalContent: Buffer | null;
  planManifest: WorkplanManifestEntry[];
  stateManifest: WorkplanManifestEntry[];
  planHash: string;
  stateHash: string;
  missingPlanArtifacts: string[];
};

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparePath(a: WorkplanManifestEntry, b: WorkplanManifestEntry): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function manifestHash(version: string, manifest: WorkplanManifestEntry[]): string {
  return hash(`${version}\n${JSON.stringify([...manifest].sort(comparePath))}\n`);
}

function relativeKey(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

async function optionalBytes(root: string, path: string, label: string): Promise<Buffer | null> {
  await assertSafePathAccess(root, path, label);
  try {
    return await fs.readFile(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

function artifactEntry(path: string, content: Buffer | null): WorkplanManifestEntry {
  return content === null ? { path, missing: true } : { path, sha256: hash(content) };
}

function changed(label: string): Error {
  return new Error(`Workplan artifacts changed while being read (${label}); retry the read`);
}

export async function readWorkplanSnapshot(workspaceRoot: string, id: string): Promise<WorkplanSnapshot> {
  const requestedRoot = resolve(workspaceRoot);
  const root = await fs.realpath(requestedRoot);
  const normalizedId = normalizeId(id);
  const path = workplanPath(root, normalizedId);
  const rawBytes = await optionalBytes(root, path, "Workplan file");
  if (rawBytes === null) throw new Error(`Workplan file not found: ${path}`);
  const raw = rawBytes.toString("utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid workplan JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = workplanDocumentSchema.safeParse(parsedJson);
  if (!parsed.success) throw new Error(formatWorkplanInputError(parsed.error));
  if (parsed.data.id !== normalizedId) throw new Error(`id: Document id ${parsed.data.id} does not match filename id ${normalizedId}`);

  const document = {
    ...parsed.data,
    planFile: normalizePlanFile(root, parsed.data.planFile),
    specFiles: normalizeSpecFiles(root, parsed.data.specFiles),
  } as WorkplanDocument;
  const planPath = resolveWorkspaceFile(root, document.planFile);
  const planContent = await optionalBytes(root, planPath, "Plan file");
  const specContents = new Map<string, Buffer | null>();
  for (const specFile of document.specFiles) {
    const specPath = resolveWorkspaceFile(root, specFile);
    specContents.set(specFile, await optionalBytes(root, specPath, "Spec file"));
  }

  const checkpointFile = checkpointPath(root, normalizedId);
  const dependenciesFile = dependencyPath(root, normalizedId);
  const journalFile = journalPath(root, normalizedId);
  const [checkpointContent, dependencyContent, journalContent] = await Promise.all([
    optionalBytes(root, checkpointFile, "Workplan checkpoint"),
    optionalBytes(root, dependenciesFile, "Workplan dependencies"),
    optionalBytes(root, journalFile, "Workplan transaction journal"),
  ]);

  const planManifest = [
    artifactEntry(relativeKey(root, path), rawBytes),
    artifactEntry(relativeKey(root, planPath), planContent),
    ...[...specContents].map(([specFile, content]) => artifactEntry(specFile.replaceAll("\\", "/"), content)),
  ].sort(comparePath);
  const stateManifest = [
    ...planManifest,
    artifactEntry(relativeKey(root, checkpointFile), checkpointContent),
    artifactEntry(relativeKey(root, dependenciesFile), dependencyContent),
    artifactEntry(relativeKey(root, journalFile), journalContent),
  ].sort(comparePath);
  const planHash = manifestHash("workplan-plan-v1", planManifest);
  const stateHash = manifestHash("workplan-state-v1", stateManifest);

  const recheckPaths = [
    [path, rawBytes, "Workplan file"],
    [planPath, planContent, "Plan file"],
    ...[...specContents].map(([specFile, content]) => [resolveWorkspaceFile(root, specFile), content, "Spec file"] as const),
    [checkpointFile, checkpointContent, "Workplan checkpoint"],
    [dependenciesFile, dependencyContent, "Workplan dependencies"],
    [journalFile, journalContent, "Workplan transaction journal"],
  ] as const;
  for (const [artifactPath, previous, label] of recheckPaths) {
    const current = await optionalBytes(root, artifactPath, label);
    if ((previous === null) !== (current === null) || (previous && current && !previous.equals(current))) {
      throw changed(artifactPath);
    }
  }

  return {
    workspaceRoot: root,
    id: normalizedId,
    path,
    planPath,
    document,
    specFilesPresent: parsed.data.specFiles !== undefined,
    raw,
    planContent,
    specContents,
    checkpointContent,
    dependencyContent,
    journalContent,
    planManifest,
    stateManifest,
    planHash,
    stateHash,
    missingPlanArtifacts: planManifest.filter((entry) => entry.missing).map((entry) => entry.path),
  };
}

export function recomputePlanHash(manifest: WorkplanManifestEntry[]): string {
  return manifestHash("workplan-plan-v1", manifest);
}

export function planHashWithArtifactChanges(
  snapshot: WorkplanSnapshot,
  changes: Array<{ path: string; content: Buffer | string | null }>,
): { planHash: string; manifest: WorkplanManifestEntry[] } {
  const manifest = new Map(snapshot.planManifest.map((entry) => [entry.path, entry]));
  for (const change of changes) {
    const key = relativeKey(snapshot.workspaceRoot, change.path);
    manifest.set(key, artifactEntry(key, change.content === null ? null : Buffer.isBuffer(change.content) ? change.content : Buffer.from(change.content)));
  }
  const result = [...manifest.values()].sort(comparePath);
  return { planHash: manifestHash("workplan-plan-v1", result), manifest: result };
}
