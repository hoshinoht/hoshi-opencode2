// SPDX-License-Identifier: GPL-3.0-or-later
// Persisted workplan data types. Field names are part of the on-disk format.

export const WORKPLAN_STATUSES = ["draft", "in_progress", "blocked", "review", "completed", "cancelled"] as const;
export const FINDING_SEVERITIES = ["blocker", "critical", "major", "minor", "note", "question"] as const;

export type WorkplanStatus = (typeof WORKPLAN_STATUSES)[number];
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export type WorkplanStep = {
  id: string;
  title: string;
  target?: string;
  action?: string;
  validation?: string;
  status: WorkplanStatus;
};

export type WorkplanPhase = {
  id: string;
  title: string;
  status: WorkplanStatus;
  steps: WorkplanStep[];
};

export type WorkplanFinding = {
  severity: FindingSeverity;
  title: string;
  detail?: string;
  source?: string;
  status?: "open" | "resolved";
};

export type WorkplanDocument = {
  [key: string]: unknown;
  schemaVersion: 2;
  id: string;
  kind: string;
  title: string | null;
  goal: string;
  scope: string[];
  nonGoals: string[];
  constraints: string[];
  relevantFiles: string[];
  planFile: string;
  specFiles: string[];
  phases: WorkplanPhase[];
  reviewFindings: WorkplanFinding[];
  notes: string[];
  status: WorkplanStatus;
  createdAt: string;
  updatedAt: string;
};

export type WorkplanDependencyReference = { phaseId: string; stepId: string };

export type WorkplanDependency = WorkplanDependencyReference & { dependsOn: WorkplanDependencyReference[] };

export type WorkplanTerminalDependencySummary = WorkplanDependencyReference & {
  title: string;
  status: "completed" | "cancelled";
};

export type WorkplanDependencies = {
  schemaVersion: 1;
  id: string;
  updatedAt: string;
  dependencies: WorkplanDependency[];
  terminalSummaries?: WorkplanTerminalDependencySummary[];
};

export type WorkplanManifestEntry = { path: string; sha256?: string; missing?: true };

export type DirectoryLikeEntry = { name: string; isFile(): boolean };
