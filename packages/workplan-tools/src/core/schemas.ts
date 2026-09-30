// SPDX-License-Identifier: GPL-3.0-or-later
// Zod v4 schemas for workplan tool inputs and persisted artifacts.
import { z } from "zod";

import { FINDING_SEVERITIES, WORKPLAN_STATUSES } from "./types";
import type { WorkplanDocument } from "./types";

const HASH = /^[a-f0-9]{64}$/;

const hash = () => z.string().regex(HASH, "Expected a 64-character lowercase SHA-256 hex digest");
const nonempty = () => z.string().trim().min(1);
const workplanId = () =>
  nonempty()
    .regex(/[a-z0-9]/i, "Workplan id must contain at least one letter or number")
    .describe("Workplan id; normalised to lowercase kebab-case for the filename");
const strings = () => z.array(z.string());
const status = () => z.enum(WORKPLAN_STATUSES);
const isoDatetime = () => z.iso.datetime();

const workspaceRoot = () =>
  z.string().optional().describe("Workspace root that owns .opencode/workplan; defaults to the current project root");
const expectedHash = () =>
  hash().optional().describe("The stateHash last read for this plan; the write is refused if the plan changed since");

// ---------------------------------------------------------------------------
// Tool-input sub-schemas
// ---------------------------------------------------------------------------

export const workplanStepSchema = z.object({
  id: z.string().optional().describe("Stable step id; a readable id is generated when omitted"),
  title: z.string().describe("Short step title"),
  target: z.string().optional().describe("File, module or artifact the step touches"),
  action: z.string().optional().describe("What to do in this step"),
  validation: z.string().optional().describe("How to verify the step is done"),
  status: status().optional().describe("Step status; defaults to draft"),
});

export const workplanPhaseSchema = z.object({
  id: z.string().optional().describe("Stable phase id; a readable id is generated when omitted"),
  title: z.string().describe("Short phase title"),
  status: status().optional().describe("Phase status; defaults to draft"),
  steps: z.array(workplanStepSchema).optional().describe("Ordered steps in this phase"),
});

export const workplanPhasePatchSchema = z.object({
  phaseId: z.string().describe("Id of the phase to change"),
  title: z.string().optional().describe("New phase title"),
  status: status().optional().describe("New phase status"),
});

export const workplanStepPatchSchema = z.object({
  phaseId: z.string().describe("Id of the phase holding the step"),
  stepId: z.string().describe("Id of the step to change"),
  title: z.string().optional().describe("New step title"),
  target: z.string().optional().describe("New step target"),
  action: z.string().optional().describe("New step action"),
  validation: z.string().optional().describe("New step validation"),
  status: status().optional().describe("New step status"),
});

export const workplanPhaseInsertSchema = z.object({
  afterPhaseId: z.string().optional().describe("Insert after this phase id; append when omitted"),
  phase: workplanPhaseSchema,
});

export const workplanStepInsertSchema = z.object({
  phaseId: z.string().describe("Phase that receives the new step"),
  afterStepId: z.string().optional().describe("Insert after this step id; append when omitted"),
  step: workplanStepSchema,
});

export const workplanFindingSchema = z.object({
  severity: z.enum(FINDING_SEVERITIES).describe("Finding severity"),
  title: z.string().describe("Short finding title"),
  detail: z.string().optional().describe("Longer explanation"),
  source: z.string().optional().describe("Where the finding came from, such as file:line or a reviewer"),
  status: z.enum(["open", "resolved"]).optional().describe("Finding status; defaults to open"),
});

// ---------------------------------------------------------------------------
// Storage schemas
// ---------------------------------------------------------------------------

const storedStepSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  target: z.string().optional(),
  action: z.string().optional(),
  validation: z.string().optional(),
  status: status(),
});

const storedPhaseSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  status: status(),
  steps: z.array(storedStepSchema),
});

const storedFindingSchema = z.looseObject({
  severity: z.enum(FINDING_SEVERITIES),
  title: z.string(),
  detail: z.string().optional(),
  source: z.string().optional(),
  status: z.enum(["open", "resolved"]).optional(),
});

export const workplanDocumentSchema = z.looseObject({
  schemaVersion: z.literal(2),
  id: z.string(),
  kind: z.string(),
  title: z.string().nullable(),
  goal: z.string(),
  scope: strings(),
  nonGoals: strings(),
  constraints: strings(),
  relevantFiles: strings(),
  planFile: z.string(),
  specFiles: strings().optional(),
  phases: z.array(storedPhaseSchema),
  reviewFindings: z.array(storedFindingSchema),
  notes: strings(),
  status: status(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const dependencyReferenceSchema = z.object({
  phaseId: nonempty(),
  stepId: nonempty(),
});

export const workplanDependencySchema = z.object({
  phaseId: nonempty().describe("Phase of the dependent step"),
  stepId: nonempty().describe("The dependent step"),
  dependsOn: z.array(dependencyReferenceSchema).describe("Steps that must finish first"),
});

export const workplanDependenciesSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonempty(),
  updatedAt: z.string(),
  dependencies: z.array(workplanDependencySchema),
  terminalSummaries: z
    .array(
      z.object({
        phaseId: nonempty(),
        stepId: nonempty(),
        title: z.string(),
        status: z.enum(["completed", "cancelled"]),
      }),
    )
    .optional(),
});

const checkpointFields = {
  id: nonempty(),
  sourceUpdatedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: status(),
  summary: z.string(),
  current: z
    .object({
      phaseId: nonempty(),
      phaseTitle: z.string(),
      phaseStatus: status(),
      stepId: nonempty(),
      stepTitle: z.string(),
      stepStatus: status(),
    })
    .nullable(),
  nextAction: z.string(),
  blockers: strings(),
  recentValidation: strings(),
  guardrails: strings(),
  references: strings(),
};

export const workplanCheckpointV1Schema = z.object({
  schemaVersion: z.literal(1),
  ...checkpointFields,
  sourceHash: hash(),
});

export const workplanCheckpointV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    ...checkpointFields,
    planHash: hash(),
    manifest: z.array(
      z.object({
        path: nonempty(),
        sha256: hash().optional(),
        missing: z.literal(true).optional(),
      }),
    ),
    evidenceStatus: z.literal("unverified"),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.manifest.forEach((entry, index) => {
      if (seen.has(entry.path)) {
        ctx.addIssue({ code: "custom", path: ["manifest", index, "path"], message: "Duplicate manifest path" });
      }
      seen.add(entry.path);
      const hasHash = entry.sha256 !== undefined;
      const isMissing = entry.missing === true;
      if (hasHash === isMissing) {
        ctx.addIssue({
          code: "custom",
          path: ["manifest", index],
          message: "Each manifest entry must have exactly one of sha256 or missing=true",
        });
      }
    });
  });

export const workplanCheckpointSchema = z.union([workplanCheckpointV1Schema, workplanCheckpointV2Schema]);

export const workplanJournalSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: nonempty(),
  workplanId: nonempty(),
  operation: nonempty(),
  createdAt: z.string(),
  targets: z.array(
    z.object({
      path: nonempty(),
      beforeHash: hash().nullable(),
      afterHash: hash().nullable(),
      beforeContent: z.string().nullable(),
      afterContent: z.string().nullable(),
      mode: z.number().int().min(0).max(0o777),
    }),
  ),
});

export const workplanPermissionIntentSchema = z.object({
  schemaVersion: z.literal(1),
  operation: nonempty(),
  workspaceRoot: nonempty(),
  workplanId: nonempty(),
  readPaths: strings(),
  writePaths: strings(),
  deletePaths: strings(),
  lockPaths: strings(),
  stagingPaths: strings(),
  resources: strings(),
});

export const workplanLockOwnerSchema = z.object({
  hostname: nonempty(),
  pid: z.number().int().positive(),
  nonce: nonempty(),
  startedAt: isoDatetime(),
});

export const workplanResumeCursorSchema = z.object({
  version: z.literal(1),
  stateHash: hash(),
  maxChars: z.number().int().min(4096).max(64000),
  limit: z.number().int().min(1).max(100),
  phaseId: z.string().nullable(),
  stepId: z.string().nullable(),
  offset: z.number().int().min(0),
  checksum: hash(),
});

export const workplanInspectCursorSchema = z.object({
  version: z.literal(1),
  stateHash: hash(),
  phaseId: z.string().nullable(),
  limit: z.number().int().min(1).max(500),
  offset: z.number().int().min(0),
  checksum: hash(),
});

// ---------------------------------------------------------------------------
// Tool argument shapes (raw shapes, not wrapped)
// ---------------------------------------------------------------------------

const findingList = () => z.array(workplanFindingSchema);
const phaseList = () => z.array(workplanPhaseSchema);

export const workplanCreateArgs = {
  workspaceRoot: workspaceRoot(),
  id: workplanId(),
  kind: z.string().default("general").describe("Plan kind, such as feature, bugfix or research"),
  title: z.string().optional().describe("Human-readable title"),
  goal: z.string().describe("One-paragraph goal statement"),
  scope: strings().optional().describe("In-scope items"),
  nonGoals: strings().optional().describe("Explicitly out-of-scope items"),
  constraints: strings().optional().describe("Constraints the work must respect"),
  relevantFiles: strings().optional().describe("Files relevant to the work"),
  planFile: z.string().optional().describe("Linked Markdown path under .opencode/workplan/; defaults to <id>.md"),
  planMarkdown: z.string().optional().describe("Full Markdown body; generated from the JSON when omitted"),
  specFiles: strings().optional().describe("Workspace-relative spec files the plan depends on"),
  phases: phaseList().optional().describe("Ordered execution phases"),
  reviewFindings: findingList().optional().describe("Adversarial review findings"),
  notes: strings().optional().describe("Free-form notes"),
  status: status().default("draft").describe("Overall plan status"),
  overwrite: z.boolean().default(false).describe("Replace an existing plan with the same id (requires expectedHash)"),
  expectedHash: expectedHash(),
  replaceMarkdown: z.boolean().optional().describe("Allow replacing handwritten Markdown on overwrite"),
};

export const workplanUpdateArgs = {
  workspaceRoot: workspaceRoot(),
  id: workplanId(),
  expectedHash: expectedHash(),
  recovery: z
    .enum(["resume", "rollback"])
    .optional()
    .describe("Finish (resume) or undo (rollback) an interrupted transaction; exclusive with other fields"),
  replaceMarkdown: z.boolean().optional().describe("Allow a full regeneration or replacement of handwritten Markdown"),
  title: z.string().optional().describe("New title"),
  goal: z.string().optional().describe("New goal"),
  status: status().optional().describe("New overall status; use workplan_reset to return to draft"),
  scope: strings().optional().describe("Replace the scope list"),
  nonGoals: strings().optional().describe("Replace the non-goals list"),
  constraints: strings().optional().describe("Replace the constraints list"),
  planFile: z.string().optional().describe("Move the linked Markdown to this path under .opencode/workplan/"),
  planMarkdown: z.string().optional().describe("Replace the linked Markdown with this text"),
  specFiles: strings().optional().describe("Replace the spec file list"),
  reviewFindings: findingList().optional().describe("Replace all review findings"),
  phases: phaseList().optional().describe("Replace all phases"),
  updatePhases: z.array(workplanPhasePatchSchema).optional().describe("Targeted phase field changes"),
  addPhases: z.array(workplanPhaseInsertSchema).optional().describe("Phases to insert or append"),
  updateSteps: z.array(workplanStepPatchSchema).optional().describe("Targeted step field changes"),
  addSteps: z.array(workplanStepInsertSchema).optional().describe("Steps to insert or append"),
  addRelevantFiles: strings().optional().describe("Relevant files to add"),
  addSpecFiles: strings().optional().describe("Spec files to add"),
  removeSpecFiles: strings().optional().describe("Spec files to remove"),
  addReviewFindings: findingList().optional().describe("Findings to append"),
  appendNotes: strings().optional().describe("Notes to append"),
  dependencies: z
    .array(workplanDependencySchema)
    .optional()
    .describe("Replace the whole step dependency sidecar; omit to leave it unchanged"),
};

export const workplanPatchArgs = {
  workspaceRoot: workspaceRoot(),
  id: workplanId(),
  patchText: z.string().describe("Restricted patch with exactly one Update File section for the linked Markdown"),
  validate: z.boolean().optional().describe("Run workplan_validate after patching"),
  expectedHash: expectedHash(),
};

export const workplanResetArgs = {
  workspaceRoot: workspaceRoot(),
  id: workplanId(),
  mode: z
    .enum(["draft", "markdown-only"])
    .default("draft")
    .describe("draft clears execution state; markdown-only only regenerates the Markdown"),
  preserveNotes: z.boolean().default(false).describe("Keep notes during a draft reset"),
  replaceMarkdown: z.boolean().optional().describe("Allow replacing handwritten Markdown"),
  expectedHash: expectedHash(),
};

export const workplanCheckpointArgs = {
  workspaceRoot: workspaceRoot(),
  id: workplanId(),
  summary: z.string().describe("Concise summary of the current state"),
  nextAction: z.string().describe("The immediate next action for the next session"),
  phaseId: z.string().optional().describe("Current phase id"),
  stepId: z.string().optional().describe("Current step id"),
  blockers: strings().optional().describe("Open blockers"),
  recentValidation: strings().optional().describe("Recent validation results"),
  guardrails: strings().optional().describe("Safety guardrails to keep in mind"),
  references: strings().optional().describe("Useful references"),
  expectedHash: expectedHash(),
};

export const workplanCompactArgs = {
  workspaceRoot: workspaceRoot(),
  id: workplanId(),
  mode: z.enum(["preview", "apply"]).default("preview").describe("preview first, then apply with the preview token"),
  archiveReason: z.string().describe("Why this history is being archived"),
  completedPhaseIds: strings().optional().describe("Completed phases to archive"),
  noteIndexes: z.array(z.number().int().min(0)).optional().describe("Zero-based note indexes to archive"),
  resolvedFindingIndexes: z
    .array(z.number().int().min(0))
    .optional()
    .describe("Zero-based indexes of resolved findings to archive"),
  confirmation: z.string().optional().describe("Must be ARCHIVE_SELECTED_HISTORY to apply"),
  previewToken: z.string().optional().describe("Token from the matching preview"),
  expectedHash: expectedHash(),
};

export const workplanResumeArgs = {
  workspaceRoot: workspaceRoot(),
  id: workplanId(),
  maxChars: z.number().int().min(4096).max(64000).optional().describe("Output size budget; defaults to 12000"),
  limit: z.number().int().min(1).max(100).optional().describe("Items per page; defaults to 20"),
  cursor: z.string().optional().describe("Cursor from a previous page"),
  phaseId: z.string().optional().describe("Restrict to one phase"),
  stepId: z.string().optional().describe("Restrict to one step"),
};

export const workplanReadArgs = {
  workspaceRoot: workspaceRoot(),
  id: workplanId(),
  phaseId: z.string().optional().describe("Return only this phase"),
  stepId: z.string().optional().describe("Return only this step"),
  includeMarkdown: z.boolean().optional().describe("Include the linked Markdown content; defaults to true"),
};

export const workplanInspectArgs = {
  workspaceRoot: workspaceRoot(),
  id: workplanId(),
  phaseId: z.string().optional().describe("Restrict to one phase"),
  limit: z.number().int().min(1).max(500).optional().describe("Records per page; defaults to 100"),
  cursor: z.string().optional().describe("Cursor from a previous page"),
};

export const workplanListArgs = {
  workspaceRoot: workspaceRoot(),
};

export const workplanValidateArgs = {
  workspaceRoot: workspaceRoot(),
  id: workplanId(),
};

export const workplanDoctorArgs = {
  workspaceRoot: workspaceRoot(),
  id: workplanId().optional(),
  limit: z.number().int().min(1).max(100).optional().describe("Maximum plans to diagnose; defaults to 50"),
};

export const workplanToolArgs = {
  create: workplanCreateArgs,
  update: workplanUpdateArgs,
  patch: workplanPatchArgs,
  reset: workplanResetArgs,
  checkpoint: workplanCheckpointArgs,
  compact: workplanCompactArgs,
  resume: workplanResumeArgs,
  read: workplanReadArgs,
  inspect: workplanInspectArgs,
  list: workplanListArgs,
  validate: workplanValidateArgs,
  doctor: workplanDoctorArgs,
};

export type WorkplanToolName = keyof typeof workplanToolArgs;
export type WorkplanToolInputSchema = z.ZodObject<z.ZodRawShape, z.core.$strict>;

// ---------------------------------------------------------------------------
// Core input schemas
// ---------------------------------------------------------------------------

const UPDATE_NON_ORDINARY = new Set(["workspaceRoot", "id", "expectedHash", "recovery", "replaceMarkdown"]);

export const workplanInputSchemas = {
  create: z.strictObject(workplanCreateArgs).superRefine((value, ctx) => {
    if (value.overwrite && !value.expectedHash) {
      ctx.addIssue({ code: "custom", path: ["expectedHash"], message: "overwrite requires the current stateHash" });
    }
  }),
  update: z.strictObject(workplanUpdateArgs).superRefine((value, ctx) => {
    if (value.recovery === undefined) return;
    const ordinary = Object.entries(value).filter(([key, entry]) => entry !== undefined && !UPDATE_NON_ORDINARY.has(key));
    if (ordinary.length > 0 || value.replaceMarkdown) {
      ctx.addIssue({ code: "custom", path: ["recovery"], message: "recovery is mutually exclusive with ordinary update fields" });
    }
  }),
  patch: z.strictObject(workplanPatchArgs),
  reset: z.strictObject(workplanResetArgs),
  checkpoint: z.strictObject(workplanCheckpointArgs),
  compact: z.strictObject(workplanCompactArgs).superRefine((value, ctx) => {
    if (value.mode === "apply" && !value.previewToken) {
      ctx.addIssue({ code: "custom", path: ["previewToken"], message: "apply requires the token from the matching preview" });
    }
  }),
  resume: z.strictObject(workplanResumeArgs),
  read: z.strictObject(workplanReadArgs),
  inspect: z.strictObject(workplanInspectArgs),
  list: z.strictObject(workplanListArgs),
  validate: z.strictObject(workplanValidateArgs),
  doctor: z.strictObject(workplanDoctorArgs),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type IssueLike = { path: PropertyKey[]; message: string };

function formatIssue(issue: IssueLike): string {
  const path = issue.path.map((segment) => String(segment)).join(".");
  return `${path || "$"}: ${issue.message}`;
}

export function formatWorkplanInputError(error: { issues: IssueLike[] }): string {
  return error.issues.map(formatIssue).join("; ");
}

export function parseWorkplanToolInput(name: WorkplanToolName, value: unknown): unknown {
  const result = workplanInputSchemas[name].safeParse(value);
  if (!result.success) throw new Error(`Invalid ${name} input: ${formatWorkplanInputError(result.error)}`);
  return result.data;
}

const NATIVE_RECOVERY_ALLOWED = new Set(["id", "expectedHash", "recovery"]);

export function createNativeWorkplanInputSchema(
  args: z.ZodRawShape,
  requiresExpectedHash: (input: Record<string, unknown>) => boolean = () => false,
) {
  const { workspaceRoot: _workspaceRoot, ...shape } = args;
  return z.strictObject(shape).superRefine((value, ctx) => {
    const input = value as Record<string, unknown>;
    if (requiresExpectedHash(input) && typeof input.expectedHash !== "string") {
      ctx.addIssue({ code: "custom", path: ["expectedHash"], message: "Native existing-state writes require the current stateHash" });
    }
    if (input.mode === "apply") {
      if (input.confirmation !== "ARCHIVE_SELECTED_HISTORY") {
        ctx.addIssue({ code: "custom", path: ["confirmation"], message: "Apply requires confirmation=ARCHIVE_SELECTED_HISTORY" });
      }
      if (typeof input.previewToken !== "string") {
        ctx.addIssue({ code: "custom", path: ["previewToken"], message: "Apply requires the matching preview token" });
      }
    }
    if (typeof input.recovery === "string") {
      const ordinary = Object.entries(input).some(([key, entry]) => entry !== undefined && !NATIVE_RECOVERY_ALLOWED.has(key));
      if (ordinary) {
        ctx.addIssue({ code: "custom", path: ["recovery"], message: "recovery is mutually exclusive with ordinary update fields" });
      }
    }
  });
}

const always = () => true;

export const nativeWorkplanInputSchemas = {
  create: createNativeWorkplanInputSchema(workplanCreateArgs, (input) => input.overwrite === true),
  update: createNativeWorkplanInputSchema(workplanUpdateArgs, always),
  patch: createNativeWorkplanInputSchema(workplanPatchArgs, always),
  reset: createNativeWorkplanInputSchema(workplanResetArgs, always),
  checkpoint: createNativeWorkplanInputSchema(workplanCheckpointArgs, always),
  compact: createNativeWorkplanInputSchema(workplanCompactArgs, (input) => input.mode === "apply"),
  resume: createNativeWorkplanInputSchema(workplanResumeArgs),
  read: createNativeWorkplanInputSchema(workplanReadArgs),
  inspect: createNativeWorkplanInputSchema(workplanInspectArgs),
  list: createNativeWorkplanInputSchema(workplanListArgs),
  validate: createNativeWorkplanInputSchema(workplanValidateArgs),
  doctor: createNativeWorkplanInputSchema(workplanDoctorArgs),
};

/** Accepts any zod schema; typed loosely because the native adapter passes schemas as plain objects. */
export function workplanInputJsonSchema(schema: object): Record<string, unknown> {
  return z.toJSONSchema(schema as z.ZodType, { io: "input" }) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Structural validation of a stored document
// ---------------------------------------------------------------------------

function safeNormalizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function isIsoDatetime(value: string): boolean {
  return isoDatetime().safeParse(value).success;
}

export function validateWorkplanStructure(value: unknown, expectedId?: string): { document?: WorkplanDocument; issues: string[] } {
  const parsed = workplanDocumentSchema.safeParse(value);
  if (!parsed.success) return { issues: parsed.error.issues.map(formatIssue) };

  const document = { ...parsed.data, specFiles: parsed.data.specFiles ?? [] } as WorkplanDocument;
  const issues: string[] = [];
  const blank = (text: string | undefined) => !text || text.trim() === "";

  if (blank(document.id)) issues.push("id: Must not be empty");
  if (expectedId !== undefined) {
    const normalized = safeNormalizeId(expectedId);
    if (document.id !== normalized) issues.push(`id: Does not match filename id ${normalized}`);
  }
  for (const key of ["kind", "goal", "planFile"] as const) {
    if (blank(document[key])) issues.push(`${key}: Must not be empty`);
  }
  for (const key of ["createdAt", "updatedAt"] as const) {
    if (!isIsoDatetime(document[key])) issues.push(`${key}: Invalid datetime`);
  }
  if (document.phases.length === 0) issues.push("phases: At least one phase is required");

  const phaseIds = new Set<string>();
  document.phases.forEach((phase, phaseIndex) => {
    const prefix = `phases.${phaseIndex}`;
    if (blank(phase.id)) issues.push(`${prefix}.id: Must not be empty`);
    else if (phaseIds.has(phase.id)) issues.push(`${prefix}.id: Duplicate phase id ${phase.id}`);
    phaseIds.add(phase.id);
    if (blank(phase.title)) issues.push(`${prefix}.title: Must not be empty`);
    if (phase.steps.length === 0) issues.push(`${prefix}.steps: At least one step is required`);

    const stepIds = new Set<string>();
    phase.steps.forEach((step, stepIndex) => {
      const stepPrefix = `${prefix}.steps.${stepIndex}`;
      if (blank(step.id)) issues.push(`${stepPrefix}.id: Must not be empty`);
      else if (stepIds.has(step.id)) issues.push(`${stepPrefix}.id: Duplicate step id ${step.id} in phase ${phase.id}`);
      stepIds.add(step.id);
      if (blank(step.title)) issues.push(`${stepPrefix}.title: Must not be empty`);
      if (blank(step.action)) issues.push(`${stepPrefix}.action: Required for executable workplans`);
      if (blank(step.validation)) issues.push(`${stepPrefix}.validation: Required for executable workplans`);
    });
  });

  return { document, issues };
}
