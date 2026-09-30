import { workplanDependenciesSchema } from "./schemas";
import type { WorkplanDependencies, WorkplanDependency, WorkplanDocument, WorkplanDependencyReference, WorkplanTerminalDependencySummary } from "./types";

function key(reference: WorkplanDependencyReference): string {
  return `${reference.phaseId}\u0000${reference.stepId}`;
}

export type DependencyRead = {
  recorded: boolean;
  dependencies: WorkplanDependency[];
  terminalSummaries: WorkplanTerminalDependencySummary[];
  issues: string[];
};

export function validateDependencyRecords(
  content: string | Buffer | null,
  id: string,
  document: WorkplanDocument,
): DependencyRead {
  if (content === null) return { recorded: false, dependencies: [], terminalSummaries: [], issues: [] };
  let value: unknown;
  try {
    value = JSON.parse(Buffer.isBuffer(content) ? content.toString("utf8") : content);
  } catch (error) {
    return { recorded: true, dependencies: [], terminalSummaries: [], issues: [`Invalid dependency JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const parsed = workplanDependenciesSchema.safeParse(value);
  if (!parsed.success) {
    return {
      recorded: true,
      dependencies: [],
      terminalSummaries: [],
      issues: parsed.error.issues.map((issue) => `${issue.path.map(String).join(".") || "$"}: ${issue.message}`),
    };
  }
  if (parsed.data.id !== id) return { recorded: true, dependencies: [], terminalSummaries: [], issues: [`id: Dependency sidecar id does not match ${id}`] };

  const available = new Set(document.phases.flatMap((phase) => phase.steps.map((step) => key({ phaseId: phase.id, stepId: step.id }))));
  const terminalSummaries = parsed.data.terminalSummaries ?? [];
  const issues: string[] = [];
  const terminalKeys = new Set(terminalSummaries.map(key));
  if (terminalKeys.size !== terminalSummaries.length) issuesDuplicateSummaries(terminalSummaries, issues);
  const sources = new Set<string>();
  const graph = new Map<string, string[]>();
  for (const [index, record] of parsed.data.dependencies.entries()) {
    const source = key(record);
    if (!available.has(source)) issues.push(`dependencies.${index}: Source step ${record.phaseId}/${record.stepId} does not exist`);
    if (sources.has(source)) issues.push(`dependencies.${index}: Duplicate dependency source ${record.phaseId}/${record.stepId}`);
    sources.add(source);
    const edges: string[] = [];
    const edgeSet = new Set<string>();
    for (const [edgeIndex, dependency] of record.dependsOn.entries()) {
      const target = key(dependency);
      if (!available.has(target) && !terminalKeys.has(target)) issues.push(`dependencies.${index}.dependsOn.${edgeIndex}: Step ${dependency.phaseId}/${dependency.stepId} does not exist`);
      if (edgeSet.has(target)) issues.push(`dependencies.${index}.dependsOn.${edgeIndex}: Duplicate dependency`);
      edgeSet.add(target);
      edges.push(target);
    }
    graph.set(source, edges);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string, stack: string[]) => {
    if (visiting.has(node)) {
      issues.push(`dependencies: Cycle detected: ${[...stack, node].map((entry) => entry.replace("\u0000", "/")).join(" -> ")}`);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const target of graph.get(node) ?? []) visit(target, [...stack, node]);
    visiting.delete(node);
    visited.add(node);
  };
  for (const source of graph.keys()) visit(source, []);

  return { recorded: true, dependencies: parsed.data.dependencies, terminalSummaries, issues };
}

function issuesDuplicateSummaries(summaries: WorkplanTerminalDependencySummary[], issues: string[]): void {
  const seen = new Set<string>();
  for (const summary of summaries) {
    const summaryKey = key(summary);
    if (seen.has(summaryKey)) issues.push(`terminalSummaries: Duplicate terminal summary ${summary.phaseId}/${summary.stepId}`);
    seen.add(summaryKey);
  }
}

export function createDependencySidecar(
  id: string,
  dependencies: WorkplanDependency[],
  updatedAt = new Date().toISOString(),
  terminalSummaries: WorkplanTerminalDependencySummary[] = [],
): WorkplanDependencies {
  return { schemaVersion: 1, id, updatedAt, dependencies, ...(terminalSummaries.length ? { terminalSummaries } : {}) };
}

export function dependencyTargetKeys(dependencies: WorkplanDependency[]): Set<string> {
  return new Set(dependencies.flatMap((dependency) => [key(dependency), ...dependency.dependsOn.map(key)]));
}

export function dependencyReference(phaseId: string, stepId: string): WorkplanDependencyReference {
  return { phaseId, stepId };
}
