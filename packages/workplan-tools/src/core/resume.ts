import { tool } from "./tool";
import { createHash } from "node:crypto";

import { assertUniqueWorkplanIds, canonicalizeWorkspaceRoot, formatOutput, resolveToolWorkspaceRoot } from "./shared";
import { checkpointFreshness, checkpointPath, checkpointReadFromContent, readStableWorkplan, selectCheckpointPosition } from "./checkpoint-shared";
import { workplanInputSchemas, workplanResumeArgs, workplanResumeCursorSchema } from "./schemas";
import type { WorkplanStatus } from "./types";
import { validateDependencyRecords } from "./dependencies";

function terminal(status: WorkplanStatus): boolean {
  return status === "completed" || status === "cancelled";
}

function hasOmittedFindingMetadata(finding: object): boolean {
  const known = new Set(["index", "severity", "title", "detail", "source", "status"]);
  return Object.keys(finding).some((key) => !known.has(key));
}

type ResumeCursor = { version: 1; stateHash: string; maxChars: number; limit: number; phaseId: string | null; stepId: string | null; offset: number };

function encodeCursor(cursor: ResumeCursor): string {
  const checksum = createHash("sha256").update(`workplan-resume-cursor-v1\n${JSON.stringify(cursor)}`).digest("hex");
  return Buffer.from(JSON.stringify({ ...cursor, checksum })).toString("base64url");
}

function cursorFilter(value: string | null): string | null {
  return value === null ? null : `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function cursorFilterMatches(stored: string | null, current: string | null): boolean {
  return stored === current || stored === cursorFilter(current);
}

function decodeCursor(value: string): ResumeCursor {
  try {
    const parsed = workplanResumeCursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (!parsed.success) throw new Error();
    const { checksum, ...cursor } = parsed.data;
    const expected = createHash("sha256").update(`workplan-resume-cursor-v1\n${JSON.stringify(cursor)}`).digest("hex");
    if (checksum !== expected) throw new Error();
    return cursor;
  } catch {
    throw new Error("Invalid workplan resume cursor; restart without a cursor");
  }
}

function truncateStrings<T>(value: T, maxLength: number, path = "", truncated: string[] = []): T {
  if (typeof value === "string") {
    const key = path.slice(path.lastIndexOf(".") + 1).replace(/\[\d+\]$/, "");
    if (["id", "phaseId", "stepId", "planHash", "stateHash", "nextCursor", "read", "inspect", "dependencies", "overflowPointers", "status", "phaseStatus", "stepStatus", "freshness", "evidenceStatus", "sourceUpdatedAt", "updatedAt"].includes(key)) return value;
    if (value.length <= maxLength) return value;
    truncated.push(path || "$");
    let prefixLength = 0;
    for (const character of value) {
      if (prefixLength + character.length > Math.max(0, maxLength - 1)) break;
      prefixLength += character.length;
    }
    return `${value.slice(0, prefixLength)}…` as T;
  }
  if (Array.isArray(value)) return value.map((item, index) => truncateStrings(item, maxLength, `${path}[${index}]`, truncated)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, truncateStrings(item, maxLength, path ? `${path}.${key}` : key, truncated)])) as T;
  }
  return value;
}

export const workplan_resume = tool({
  description:
    "Return a compact continuation packet for an existing workplan: checkpoint, active steps, unresolved findings, and current guardrails, without dumping historical notes or completed phase details.",
  args: workplanResumeArgs,
  async execute(args, context) {
    const input = workplanInputSchemas.resume.parse(args);
    const maxChars = input.maxChars ?? 12000;
    const limit = input.limit ?? 20;
    const workspaceRoot = await canonicalizeWorkspaceRoot(resolveToolWorkspaceRoot(context, input.workspaceRoot));
    const snapshot = await readStableWorkplan(workspaceRoot, input.id);
    const { document, path } = snapshot;
    if (snapshot.journalContent) {
      context.metadata({ title: "Resume workplan", metadata: { workspaceRoot, id: document.id, recoveryRequired: true, stateHash: snapshot.stateHash } });
      return formatOutput({ recoveryRequired: true, journalPath: `.opencode/workplan/${document.id}.transaction.json`, planHash: snapshot.planHash, stateHash: snapshot.stateHash, planFresh: false });
    }
    assertUniqueWorkplanIds(document);
    const checkpointRead = checkpointReadFromContent(snapshot.checkpointContent, document.id, checkpointPath(workspaceRoot, document.id));
    const checkpoint = checkpointRead.checkpoint;
    const freshness = checkpointFreshness(checkpoint, snapshot, checkpointRead.diagnostic);
    const fresh = freshness.planFresh;
    const current = fresh && checkpoint?.schemaVersion === 2 && checkpoint.current
      ? checkpoint.current
      : selectCheckpointPosition(document);
    const currentStep = current
      ? document.phases.find((phase) => phase.id === current.phaseId)?.steps.find((step) => step.id === current.stepId)
      : undefined;
    const dependencyRead = validateDependencyRecords(snapshot.dependencyContent, document.id, document);
    const currentDependency = current
      ? dependencyRead.dependencies.find((entry) => entry.phaseId === current.phaseId && entry.stepId === current.stepId)
      : undefined;
    const recordedDependencies = currentDependency?.dependsOn ?? [];
    const pinnedKey = current ? `${current.phaseId}\u0000${current.stepId}` : "";
    const phaseFilter = input.phaseId ?? null;
    const stepFilter = input.stepId ?? null;
    if (stepFilter && !document.phases.some((phase) => (!phaseFilter || phase.id === phaseFilter) && phase.steps.some((step) => step.id === stepFilter))) {
      throw new Error(`Step not found for workplan_resume filter: ${phaseFilter ? `${phaseFilter}/` : ""}${stepFilter}`);
    }

    const allActive = document.phases.flatMap((phase) => phase.steps
      .filter((step) => !terminal(phase.status) && !terminal(step.status))
      .filter((step) => (!phaseFilter || phase.id === phaseFilter) && (!stepFilter || step.id === stepFilter))
      .map((step) => ({
        phaseId: phase.id,
        phaseTitle: phase.title,
        phaseStatus: phase.status,
        stepId: step.id,
        title: step.title,
        status: step.status,
        target: step.target ?? null,
        action: step.action ?? null,
        validation: step.validation ?? null,
      })))
      .filter((step) => `${step.phaseId}\u0000${step.stepId}` !== pinnedKey);
    const severityRank: Record<string, number> = { blocker: 0, critical: 1, major: 2, minor: 3, question: 4, note: 5 };
    const openFindings = document.reviewFindings.flatMap((finding, index) => finding.status === "resolved" ? [] : [{ index, ...finding }])
      .sort((a, b) => (severityRank[a.severity] ?? 99) - (severityRank[b.severity] ?? 99) || a.index - b.index);
    const highFindings = openFindings.filter((finding) => ["blocker", "critical", "major"].includes(finding.severity));
    const otherFindings = openFindings.filter((finding) => !["blocker", "critical", "major"].includes(finding.severity));
    const references = [
      ...document.relevantFiles.map((reference) => ({ reference, source: "current-plan" })),
      ...(checkpoint?.references ?? []).map((reference) => ({ reference, source: fresh ? "checkpoint" : "unverified-checkpoint" })),
    ];
    const pageItems = [
      ...allActive.map((item) => ({ kind: "active-work", ...item })),
      ...otherFindings.map((finding) => ({
        kind: "finding",
        index: finding.index,
        severity: finding.severity,
        title: finding.title,
        detail: finding.detail ?? null,
        source: finding.source ?? null,
        status: finding.status ?? "open",
        metadataOmitted: hasOmittedFindingMetadata(finding),
      })),
      ...references.map((reference) => ({ kind: "reference", ...reference })),
    ];
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    if (cursor && (cursor.stateHash !== snapshot.stateHash || cursor.maxChars !== maxChars || cursor.limit !== limit || !cursorFilterMatches(cursor.phaseId, phaseFilter) || !cursorFilterMatches(cursor.stepId, stepFilter))) {
      throw new Error("Stale or option-mismatched workplan resume cursor; restart from the first page");
    }
    const offset = cursor?.offset ?? 0;
    let returnedItems = pageItems.slice(offset, offset + limit);
    let skippedPageItems = 0;
    const blockers = checkpoint?.blockers ?? [];
    const maxPinned = Math.max(2, Math.min(8, Math.floor(maxChars / 900)));
    const warningCandidates = [
      ...(freshness.diagnostic ? [freshness.diagnostic] : []),
      ...dependencyRead.issues.slice(0, maxPinned).map((issue) => `Dependency metadata warning: ${issue}`),
      ...(!fresh && checkpoint ? checkpoint.guardrails.slice(0, maxPinned).map((value) => `Unverified checkpoint guardrail: ${value}`) : []),
      ...(!fresh ? blockers.slice(0, maxPinned).map((value) => `Unverified checkpoint blocker: ${value}`) : []),
      ...(!fresh && checkpoint ? checkpoint.references.slice(0, maxPinned).map((value) => `Unverified checkpoint reference: ${value}`) : []),
      ...(!fresh && checkpoint ? checkpoint.recentValidation.slice(0, maxPinned).map((value) => `Unverified checkpoint validation claim: ${value}`) : []),
    ];
    const unverifiedWarnings = warningCandidates;
    const unverifiedWarningCount = Number(Boolean(freshness.diagnostic)) + dependencyRead.issues.length +
      (!fresh ? (checkpoint?.guardrails.length ?? 0) + blockers.length + (checkpoint?.references.length ?? 0) + (checkpoint?.recentValidation.length ?? 0) : 0);
    const staleOrInvalid = !fresh;
    let safetyConstraints = document.constraints.slice(0, maxPinned);
    let safetyBlockers = blockers.slice(0, maxPinned);
    let safetyFindings = highFindings.slice(0, maxPinned);
    let safetyDependencies = recordedDependencies.slice(0, maxPinned);
    let maxText = Math.min(512, Math.floor(maxChars / 12));
    const totalItems = pageItems.length;
    const cursorFor = (returned: number) => offset + returned < totalItems
      ? encodeCursor({ version: 1, stateHash: snapshot.stateHash, maxChars, limit, phaseId: cursorFilter(phaseFilter), stepId: cursorFilter(stepFilter), offset: offset + returned })
      : null;
    const buildPacket = (overflowed: string[], minimal = false) => {
      const omittedDangerCounts = {
        constraints: document.constraints.length - safetyConstraints.length,
        blockers: blockers.length - safetyBlockers.length,
        highFindings: highFindings.length - safetyFindings.length,
        dependencies: recordedDependencies.length - safetyDependencies.length,
        guardrails: fresh ? Math.max(0, (checkpoint?.guardrails.length ?? 0) - (minimal ? 0 : maxPinned)) : 0,
        references: fresh ? Math.max(0, (checkpoint?.references.length ?? 0) - (minimal ? 0 : maxPinned)) : 0,
        scope: document.scope.length - (minimal ? 0 : Math.min(document.scope.length, maxPinned)),
        nonGoals: document.nonGoals.length - (minimal ? 0 : Math.min(document.nonGoals.length, maxPinned)),
      };
      const hasOverflow = overflowed.length > 0 || unverifiedWarningCount > warningCandidates.length || Object.values(omittedDangerCounts).some((count) => count > 0);
      return ({
      path: minimal ? "" : path,
      planFile: minimal ? "" : document.planFile,
      hashes: { planHash: snapshot.planHash, stateHash: snapshot.stateHash },
      planFresh: snapshot.missingPlanArtifacts.length === 0,
      checkpoint: {
        exists: checkpoint !== null || checkpointRead.diagnostic !== null,
        fresh,
        freshness: freshness.freshness,
        sourceUpdatedAt: checkpoint?.sourceUpdatedAt ?? null,
        summary: !minimal && fresh ? checkpoint?.summary ?? null : null,
        current: current ? {
          ...current,
          phaseTitle: minimal ? "" : current.phaseTitle,
          stepTitle: minimal ? "" : current.stepTitle,
          target: minimal ? null : currentStep?.target ?? null,
          action: minimal ? null : currentStep?.action ?? null,
          validation: minimal ? null : currentStep?.validation ?? null,
        } : null,
        nextAction: fresh ? checkpoint?.nextAction ?? null : null,
        blockers: minimal ? [] : safetyBlockers,
        blockersTotal: blockers.length,
        guardrails: minimal ? [] : fresh ? checkpoint?.guardrails.slice(0, maxPinned) ?? [] : [],
        guardrailsTotal: checkpoint?.guardrails.length ?? 0,
        references: minimal ? [] : fresh ? checkpoint?.references.slice(0, maxPinned) ?? [] : [],
        referencesTotal: checkpoint?.references.length ?? 0,
        recentValidation: minimal ? [] : fresh ? checkpoint?.recentValidation.slice(0, maxPinned) ?? [] : [],
        evidenceStatus: "unverified",
        diagnostic: checkpointRead.diagnostic,
      },
      workplan: {
        id: document.id,
        title: minimal ? "" : document.title,
        goal: minimal ? "" : document.goal,
        status: document.status,
        scope: minimal ? [] : document.scope.slice(0, maxPinned),
        scopeTotal: document.scope.length,
        nonGoals: minimal ? [] : document.nonGoals.slice(0, maxPinned),
        nonGoalsTotal: document.nonGoals.length,
        constraints: minimal ? [] : safetyConstraints,
        constraintsTotal: document.constraints.length,
        relevantFiles: minimal ? [] : document.relevantFiles.slice(0, maxPinned),
        updatedAt: document.updatedAt,
      },
      currentDependencies: {
        recorded: dependencyRead.recorded,
        valid: dependencyRead.issues.length === 0,
        total: recordedDependencies.length,
        references: minimal ? [] : safetyDependencies,
      },
      safety: {
        highFindings: minimal ? [] : safetyFindings.map((finding) => ({
          index: finding.index,
          severity: finding.severity,
          title: finding.title,
          detail: finding.detail ?? null,
          source: finding.source ?? null,
          status: finding.status ?? "open",
          metadataOmitted: hasOmittedFindingMetadata(finding),
        })),
        highFindingsTotal: highFindings.length,
        highFindingCounts: {
          blocker: highFindings.filter((finding) => finding.severity === "blocker").length,
          critical: highFindings.filter((finding) => finding.severity === "critical").length,
          major: highFindings.filter((finding) => finding.severity === "major").length,
        },
        unverifiedWarnings: minimal ? [] : unverifiedWarnings,
        unverifiedWarningCount,
        unverifiedWarningsOmitted: Math.max(0, unverifiedWarningCount - (minimal ? 0 : warningCandidates.length)),
        overflow: hasOverflow,
        truncatedDangerFieldCount: 0,
        omittedDangerCounts,
        overflowPointers: hasOverflow ? [`workplan_read:${document.id}`, `workplan_inspect:${document.id}`] : [],
      },
      page: {
        total: totalItems,
        offset,
        limit,
        returned: returnedItems.length,
        omitted: Math.max(0, totalItems - offset - returnedItems.length),
        items: returnedItems,
        nextCursor: cursorFor(returnedItems.length + skippedPageItems),
      },
      counts: {
        activeWorkTotal: allActive.length + (current ? 1 : 0),
        findingsTotal: openFindings.length,
        highFindingsTotal: highFindings.length,
        referencesTotal: references.length,
        historicalNotesOmitted: document.notes.length,
        resolvedFindingsOmitted: document.reviewFindings.length - openFindings.length,
      },
      retrieval: {
        read: `workplan_read id=${document.id}`,
        inspect: `workplan_inspect id=${document.id}`,
        dependencies: `.opencode/workplan/${document.id}.dependencies.json`,
      },
      truncatedFields: [] as string[],
      truncatedFieldCount: 0,
      truncatedFieldPathsOmitted: 0,
      instruction: staleOrInvalid
        ? "Checkpoint guidance is not fresh. Reconfirm unverified guardrails, blockers and references before relying on them; nextAction is withheld."
        : checkpoint
          ? "Start from the current step and recorded dependencies; recentValidation is evidence text marked unverified."
          : "No checkpoint exists. Use the current step, explicit constraints and listed work, then record a checkpoint before compacting.",
      });
    };

    context.metadata({ title: "Resume workplan", metadata: { workspaceRoot, id: document.id, checkpointFresh: fresh, stateHash: snapshot.stateHash } });
    let packet: ReturnType<typeof buildPacket>;
    let serialized: string;
    const overflowed: string[] = [];
    let minimal = false;
    let maxReportedTruncations = Math.max(4, Math.min(32, Math.floor(maxChars / 256)));
    while (true) {
      const truncatedFields: string[] = [];
      const bounded = truncateStrings(buildPacket(overflowed, minimal), maxText, "", truncatedFields);
      const minimalOmissions = minimal ? [
        "path", "planFile", "checkpoint.summary", "checkpoint.current.phaseTitle", "checkpoint.current.stepTitle",
        "checkpoint.current.target", "checkpoint.current.action", "checkpoint.current.validation", "checkpoint.blockers",
        "checkpoint.guardrails", "checkpoint.references", "checkpoint.recentValidation", "workplan.title", "workplan.goal",
        "workplan.scope", "workplan.nonGoals", "workplan.constraints", "workplan.relevantFiles", "currentDependencies.references",
        "safety.highFindings", "safety.unverifiedWarnings",
      ] : [];
      const skippedPaths = Array.from({ length: skippedPageItems }, (_value, index) => `page.items[${offset + index}]`);
      const omittedMetadataPaths = [
        ...returnedItems.flatMap((item, index) => "metadataOmitted" in item && item.metadataOmitted ? [`page.items[${index}].customMetadata`] : []),
        ...(!minimal ? safetyFindings.flatMap((finding, index) => hasOmittedFindingMetadata(finding) ? [`safety.highFindings[${index}].customMetadata`] : []) : []),
      ];
      const dangerPath = /^(checkpoint\.(blockers|guardrails|references|recentValidation)|workplan\.(scope|nonGoals|constraints)|currentDependencies\.references|safety\.(highFindings|unverifiedWarnings))(\.|\[|$)/;
      const allTruncatedFields = [
        ...skippedPaths,
        ...omittedMetadataPaths.filter((field) => dangerPath.test(field)),
        ...minimalOmissions.filter((field) => dangerPath.test(field)),
        ...truncatedFields.filter((field) => dangerPath.test(field)),
        ...omittedMetadataPaths.filter((field) => !dangerPath.test(field)),
        ...minimalOmissions.filter((field) => !dangerPath.test(field)),
        ...truncatedFields.filter((field) => !dangerPath.test(field)),
      ];
      packet = {
        ...bounded,
        truncatedFields: allTruncatedFields.slice(0, maxReportedTruncations),
        truncatedFieldCount: allTruncatedFields.length,
        truncatedFieldPathsOmitted: Math.max(0, allTruncatedFields.length - maxReportedTruncations),
      };
      packet.safety.truncatedDangerFieldCount = allTruncatedFields.filter((field) => dangerPath.test(field)).length;
      if (allTruncatedFields.length > 0) packet.safety.overflow = true;
      if (packet.safety.overflow && packet.safety.overflowPointers.length === 0) {
        packet.safety.overflowPointers = [`workplan_read:${document.id}`, `workplan_inspect:${document.id}`];
      }
      const pretty = formatOutput(packet);
      serialized = pretty.length <= maxChars ? pretty : JSON.stringify(packet);
      if (serialized.length <= maxChars) break;
      if (maxText > 1) {
        maxText = Math.max(1, Math.floor(maxText / 2));
        continue;
      }
      if (returnedItems.length > 1) {
        returnedItems = returnedItems.slice(0, -1);
        overflowed.push("page-items");
        continue;
      }
      if (!minimal) {
        minimal = true;
        overflowed.push("minimum-budget-fallback");
        continue;
      }
      if (returnedItems.length === 1 && skippedPageItems === 0) {
        returnedItems = [];
        skippedPageItems = 1;
        overflowed.push("page-item-details");
        continue;
      }
      if (maxReportedTruncations > 4) {
        maxReportedTruncations = Math.max(4, Math.floor(maxReportedTruncations / 2));
        continue;
      }
      throw new Error(`Unable to fit essential workplan continuation identifiers within maxChars=${maxChars}`);
    }
    return serialized;
  },
});
