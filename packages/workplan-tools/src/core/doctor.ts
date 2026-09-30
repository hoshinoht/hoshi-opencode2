import { promises as fs } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { tool } from "./tool";

import { checkpointFreshness, type WorkplanCheckpoint } from "./checkpoint-shared";
import { validateDependencyRecords } from "./dependencies";
import { workplanInputSchemas, workplanDoctorArgs, workplanCheckpointSchema, workplanJournalSchema, validateWorkplanStructure } from "./schemas";
import { readWorkplanSnapshot } from "./snapshot";
import { assertSafePathAccess, classifyWorkplanArtifact, formatOutput, normalizeId, resolveToolWorkspaceRoot, summarize, workplanDirectory } from "./shared";

export type WorkplanDoctorRuntimeFacts = {
  registrations?: { effective?: string[] | null; configured?: string[] | null };
  plugin?: { id?: string | null; configured?: boolean | null; effective?: boolean | null; canonicalLocation?: string | null };
  permission?: {
    status?: "known" | "unknown";
    agent?: string | null;
    sessionID?: string | null;
    rules?: Array<{ resource: string; decision: "allow" | "deny" | "ask" | "unknown"; source?: string }> | null;
    detail?: string;
  };
  builtinPlan?: { configured?: boolean | null; effective?: boolean | null };
};

function safeRuntimeFacts(value: unknown) {
  const facts = value && typeof value === "object" ? value as WorkplanDoctorRuntimeFacts : {};
  const permissionRules = Array.isArray(facts.permission?.rules)
    ? (facts.permission.rules as unknown[]).slice(0, 100).flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const rule = value as Record<string, unknown>;
        if (typeof rule.resource !== "string") return [];
        const decision = ["allow", "deny", "ask", "unknown"].includes(String(rule.decision)) ? rule.decision as "allow" | "deny" | "ask" | "unknown" : "unknown";
        return [{ resource: rule.resource.slice(0, 500), decision, ...(typeof rule.source === "string" ? { source: rule.source.slice(0, 200) } : {}) }];
      })
    : null;
  return {
    registrations: {
      effective: Array.isArray(facts.registrations?.effective) ? facts.registrations.effective.filter((item): item is string => typeof item === "string").slice(0, 100).map((item) => item.slice(0, 300)) : null,
      configured: Array.isArray(facts.registrations?.configured) ? facts.registrations.configured.filter((item): item is string => typeof item === "string").slice(0, 100).map((item) => item.slice(0, 300)) : null,
    },
    plugin: {
      id: typeof facts.plugin?.id === "string" ? facts.plugin.id.slice(0, 120) : null,
      configured: typeof facts.plugin?.configured === "boolean" ? facts.plugin.configured : null,
      effective: typeof facts.plugin?.effective === "boolean" ? facts.plugin.effective : null,
      canonicalLocation: typeof facts.plugin?.canonicalLocation === "string" ? facts.plugin.canonicalLocation.slice(0, 500) : null,
    },
    permission: {
      status: facts.permission?.status === "known" ? "known" : "unknown",
      agent: typeof facts.permission?.agent === "string" ? facts.permission.agent.slice(0, 120) : null,
      sessionID: typeof facts.permission?.sessionID === "string" ? facts.permission.sessionID.slice(0, 120) : null,
      rules: permissionRules,
      detail: typeof facts.permission?.detail === "string" ? facts.permission.detail.slice(0, 500) : null,
    },
    builtinPlan: {
      configured: typeof facts.builtinPlan?.configured === "boolean" ? facts.builtinPlan.configured : null,
      effective: typeof facts.builtinPlan?.effective === "boolean" ? facts.builtinPlan.effective : null,
    },
  };
}

async function inspectLock(root: string, path: string) {
  await assertSafePathAccess(root, path, "Workplan lock");
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { path, present: false, owner: null, diagnostic: null };
    return { path, present: true, owner: null, diagnostic: error instanceof Error ? error.message : String(error) };
  }
  try {
    const owner = JSON.parse(raw) as Record<string, unknown>;
    if (typeof owner.hostname !== "string" || typeof owner.pid !== "number" || typeof owner.nonce !== "string" || typeof owner.startedAt !== "string") throw new Error("owner metadata is incomplete");
    return { path, present: true, owner: { hostname: owner.hostname, pid: owner.pid, startedAt: owner.startedAt }, diagnostic: null };
  } catch (error) {
    return { path, present: true, owner: null, diagnostic: `Ambiguous lock owner: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export const workplan_doctor = tool({
  description: "Read-only diagnosis of workplan artifacts, hashes, sidecars, locks, and injected runtime facts.",
  args: workplanDoctorArgs,
  async execute(args, context) {
    const input = workplanInputSchemas.doctor.parse(args);
    const limit = input.limit ?? 50;
    const requestedRoot = resolveToolWorkspaceRoot(context, input.workspaceRoot);
    const canonicalRoot = await fs.realpath(requestedRoot).catch(() => null);
    const runtimeFacts = safeRuntimeFacts((context as typeof context & { runtimeFacts?: unknown }).runtimeFacts);
    const issues: string[] = [];
    if (canonicalRoot === null) {
      return formatOutput({ requestedRoot, canonicalRoot: null, issues: [`Workspace root is missing or unavailable: ${requestedRoot}`], runtimeFacts, readOnly: true });
    }
    const directory = workplanDirectory(canonicalRoot);
    let entries: import("node:fs").Dirent[] = [];
    let directoryMissing = false;
    try {
      await assertSafePathAccess(canonicalRoot, directory, "Workplan directory");
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") directoryMissing = true;
      else issues.push(error instanceof Error ? error.message : String(error));
    }
    if (directoryMissing) issues.push(`Workplan directory is missing: ${directory}`);

    const primaryEntries = entries.filter((entry) => classifyWorkplanArtifact(entry.name) === "plan").sort((a, b) => a.name.localeCompare(b.name));
    const normalizedId = input.id ? normalizeId(input.id) : null;
    const candidates = normalizedId ? primaryEntries.filter((entry) => basename(entry.name, ".json") === normalizedId) : primaryEntries;
    if (normalizedId && candidates.length === 0) issues.push(`Primary workplan not found: ${normalizedId}`);
    const selected = candidates.slice(0, limit);
    const plans = await Promise.all(selected.map(async (entry) => {
      const planId = basename(entry.name, ".json");
      const artifactPath = join(directory, entry.name);
      try {
        await assertSafePathAccess(canonicalRoot, artifactPath, "Workplan file");
        if (!entry.isFile()) throw new Error(`Primary plan is not a regular file: ${artifactPath}`);
        const snapshot = await readWorkplanSnapshot(canonicalRoot, planId);
        const structure = validateWorkplanStructure(snapshot.document, planId);
        const dependencyRead = validateDependencyRecords(snapshot.dependencyContent, planId, snapshot.document);
        const sidecarIssues = [...structure.issues, ...dependencyRead.issues.map((issue) => `dependencies: ${issue}`)];
        if (snapshot.missingPlanArtifacts.length) sidecarIssues.push(`Missing linked artifacts: ${snapshot.missingPlanArtifacts.join(", ")}`);
        if (snapshot.planContent !== null && !snapshot.planContent.toString("utf8").trim()) sidecarIssues.push(`Linked Markdown is empty: ${snapshot.document.planFile}`);
        for (const [specFile, content] of snapshot.specContents) if (content !== null && !content.toString("utf8").trim()) sidecarIssues.push(`Linked spec is empty: ${specFile}`);
        if (snapshot.journalContent) sidecarIssues.push(`Recovery required: .opencode/workplan/${planId}.transaction.json`);
        let checkpoint: WorkplanCheckpoint | null = null;
        let checkpointDiagnostic: string | null = null;
        if (snapshot.checkpointContent) {
          try {
            const raw = JSON.parse(snapshot.checkpointContent.toString("utf8"));
            const parsed = workplanCheckpointSchema.safeParse(raw);
            if (!parsed.success) checkpointDiagnostic = parsed.error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`).join("; ");
            else if (parsed.data.id !== planId) checkpointDiagnostic = "Checkpoint id does not match the plan filename";
            else checkpoint = parsed.data as WorkplanCheckpoint;
          } catch (error) {
            checkpointDiagnostic = error instanceof Error ? error.message : String(error);
          }
        }
        const freshness = checkpointFreshness(checkpoint, snapshot, checkpointDiagnostic);
        if (checkpointDiagnostic) sidecarIssues.push(`checkpoint: ${checkpointDiagnostic}`);
        if (freshness.freshness === "legacy-unverified" || freshness.freshness === "stale") sidecarIssues.push(`checkpoint: ${freshness.diagnostic}`);
        return {
          id: planId,
          valid: sidecarIssues.length === 0,
          issues: sidecarIssues,
          workplan: summarize(snapshot.document),
          planHash: snapshot.planHash,
          stateHash: snapshot.stateHash,
          checkpointFreshness: freshness.freshness,
          dependenciesRecorded: dependencyRead.recorded,
          recoveryRequired: snapshot.journalContent !== null,
        };
      } catch (error) {
        return { id: planId, valid: false, issues: [error instanceof Error ? error.message : String(error)], recoveryRequired: entry.name.endsWith(".transaction.json") };
      }
    }));

    const recognizedSidecars = entries.filter((entry) => !["plan", "other", "archive"].includes(classifyWorkplanArtifact(entry.name)))
      .map((entry) => ({ name: entry.name, kind: classifyWorkplanArtifact(entry.name) }));
    const allLockEntries = recognizedSidecars.filter((entry) => entry.kind === "lock");
    const lockEntries = allLockEntries.slice(0, limit);
    const locks = await Promise.all(lockEntries.map((entry) => inspectLock(canonicalRoot, join(directory, entry.name))));
    for (const lock of locks) if (lock.diagnostic) issues.push(`${lock.path}: ${lock.diagnostic}`);
    const allPendingEntries = recognizedSidecars.filter((entry) => entry.kind === "transaction");
    const pendingEntries = allPendingEntries.slice(0, limit);
    const pendingTransactions = await Promise.all(pendingEntries.map(async (entry) => {
      const path = join(directory, entry.name);
      const workplanId = entry.name.slice(0, -".transaction.json".length);
      try {
        await assertSafePathAccess(canonicalRoot, path, "Workplan transaction journal");
        const parsed = workplanJournalSchema.safeParse(JSON.parse(await fs.readFile(path, "utf8")));
        if (!parsed.success) {
          const diagnostic = parsed.error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`).join("; ");
          issues.push(`${path}: Invalid transaction journal: ${diagnostic}`);
          return { path, workplanId, valid: false };
        }
        if (parsed.data.workplanId !== workplanId) {
          issues.push(`${path}: Journal workplanId does not match its filename`);
          return { path, workplanId, valid: false };
        }
        for (const target of parsed.data.targets) {
          const targetPath = resolve(canonicalRoot, target.path);
          if (isAbsolute(target.path) || relative(canonicalRoot, targetPath).replaceAll("\\", "/") !== target.path) {
            throw new Error(`Noncanonical transaction target: ${target.path}`);
          }
          await assertSafePathAccess(canonicalRoot, targetPath, "Journal target");
        }
        return { path, workplanId, valid: true, transactionId: parsed.data.transactionId, targetCount: parsed.data.targets.length };
      } catch (error) {
        const diagnostic = error instanceof Error ? error.message : String(error);
        issues.push(`${path}: ${diagnostic}`);
        return { path, workplanId, valid: false };
      }
    }));
    const sidecars = recognizedSidecars.slice(0, limit);
    if (plans.some((plan) => plan.valid === false)) issues.push("One or more primary plans are invalid; see per-plan diagnostics");
    return formatOutput({
      requestedRoot,
      canonicalRoot,
      directory,
      planCount: primaryEntries.length,
      returnedPlans: plans.length,
      omittedPlans: Math.max(0, candidates.length - plans.length),
      plans,
      sidecars,
      sidecarCount: recognizedSidecars.length,
      omittedSidecars: Math.max(0, recognizedSidecars.length - sidecars.length),
      locks,
      lockCount: allLockEntries.length,
      omittedLocks: Math.max(0, allLockEntries.length - locks.length),
      pendingTransactions,
      pendingTransactionCount: allPendingEntries.length,
      omittedPendingTransactions: Math.max(0, allPendingEntries.length - pendingTransactions.length),
      runtimeFacts,
      issues,
      readOnly: true,
    });
  },
});
