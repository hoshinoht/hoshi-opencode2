import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { workplan_checkpoint } from "../../packages/workplan-tools/src/core/checkpoint";
import { workplan_compact } from "../../packages/workplan-tools/src/core/compact";
import { workplan_create } from "../../packages/workplan-tools/src/core/create";
import { workplan_doctor } from "../../packages/workplan-tools/src/core/doctor";
import { workplan_read } from "../../packages/workplan-tools/src/core/read";
import { workplan_resume } from "../../packages/workplan-tools/src/core/resume";
import { workplan_reset } from "../../packages/workplan-tools/src/core/reset";
import { workplan_update } from "../../packages/workplan-tools/src/core/update";
import { readWorkplanSnapshot } from "../../packages/workplan-tools/src/core/snapshot";
import { commitWorkplanMutation } from "../../packages/workplan-tools/src/core/transaction";
import { workspaceLockPath } from "../../packages/workplan-tools/src/core/storage-paths";
import { createNativeWorkplanInputSchema, nativeWorkplanInputSchemas, workplanCreateArgs, workplanDocumentSchema, workplanInputJsonSchema, workplanInputSchemas, validateWorkplanStructure } from "../../packages/workplan-tools/src/core/schemas";
import { WorkplanRecoveryRequiredError } from "../../packages/workplan-tools/src/core/transaction";

type Ask = { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> };
type ContextOptions = {
  ask?: (input: Ask) => void | Promise<void>;
  authorize?: (intent: unknown, invocation: unknown) => void | Promise<void>;
  abort?: AbortSignal;
  fault?: (stage: string) => void | Promise<void>;
  asks?: Ask[];
};

function context(root: string, options: ContextOptions = {}) {
  return {
    directory: root,
    worktree: root,
    abort: options.abort,
    metadata() {},
    async ask(input: Ask) {
      options.asks?.push(input);
      await options.ask?.(input);
    },
    authorize: options.authorize,
    fault: options.fault,
  };
}

function output<T>(value: unknown): T {
  const text = typeof value === "string" ? value : (value as { output?: string }).output;
  if (!text) throw new Error("Tool returned no output");
  return JSON.parse(text) as T;
}

function fixture(id: string, planFile?: string) {
  return {
    id,
    kind: "core-test",
    goal: "Exercise safe workplan mutations",
    status: "in_progress" as const,
    overwrite: false,
    ...(planFile ? { planFile } : {}),
    phases: [{
      id: "phase-main",
      title: "Main work",
      status: "in_progress" as const,
      steps: [
        { id: "step-a", title: "First", action: "Do the first thing", validation: "Check the first thing", status: "in_progress" as const },
        { id: "step-b", title: "Second", action: "Do the second thing", validation: "Check the second thing", status: "draft" as const },
      ],
    }],
  };
}

async function createFixture(root: string, id = "hardening", planFile?: string) {
  return output<{ stateHash: string; planHash: string }>(await workplan_create.execute(fixture(id, planFile), context(root) as never));
}

async function runSeparateContenders(root: string, operation: "create" | "move"): Promise<string[]> {
  const modulePath = resolve(operation === "create" ? "packages/workplan-tools/src/core/create.ts" : "packages/workplan-tools/src/core/update.ts");
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const modulePath = process.env.WORKPLAN_MODULE;
    const { ${operation === "create" ? "workplan_create" : "workplan_update"} } = await import(modulePath);
    const root = process.env.WORKPLAN_ROOT;
    const id = process.env.WORKPLAN_ID;
    const other = id === "a" ? "b" : "a";
    const authorize = async () => {
      writeFileSync(join(root, ".barrier-" + id), "ready");
      const deadline = Date.now() + 10000;
      while (!existsSync(join(root, ".barrier-" + other)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!existsSync(join(root, ".barrier-" + other))) throw new Error("test barrier timed out");
    };
    const context = { directory: root, worktree: root, metadata() {}, authorize, async ask() {} };
    try {
      if (process.env.WORKPLAN_OPERATION === "create") {
        await workplan_create.execute({ id, kind: "test", goal: "Cross process claim", overwrite: false, planFile: ".opencode/workplan/shared.md" }, context);
      } else {
        await workplan_update.execute({ id, planFile: ".opencode/workplan/shared-move.md" }, context);
      }
      process.stdout.write("WON");
    } catch (error) {
      process.stdout.write("LOST:" + (error instanceof Error ? error.message : String(error)));
    }
  `;
  const workers = ["a", "b"].map((id) => Bun.spawn([process.execPath, "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, WORKPLAN_MODULE: modulePath, WORKPLAN_ROOT: root, WORKPLAN_ID: id, WORKPLAN_OPERATION: operation },
    stdout: "pipe",
    stderr: "pipe",
  }));
  const results = await Promise.all(workers.map(async (worker) => {
    const [exitCode, stdout, stderr] = await Promise.all([worker.exited, new Response(worker.stdout).text(), new Response(worker.stderr).text()]);
    if (exitCode !== 0) throw new Error(`Concurrent ${operation} worker failed (${exitCode}): ${stderr}`);
    return stdout;
  }));
  return results;
}

function document(id = "draft") {
  return {
    schemaVersion: 2,
    id,
    kind: "legacy",
    title: null,
    goal: "A compatible incomplete draft",
    scope: [],
    nonGoals: [],
    constraints: [],
    relevantFiles: [],
    planFile: `.opencode/workplan/${id}.md`,
    phases: [],
    reviewFindings: [{ severity: "note", title: "Legacy finding" }],
    notes: [],
    status: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    customMetadata: { retained: true },
  };
}

describe("workplan core hardening", () => {
  it("shares compatible storage and strict input schemas while retaining draft and legacy metadata", () => {
    const parsed = workplanDocumentSchema.safeParse(document());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.specFiles).toBeUndefined();
    expect(parsed.data.customMetadata).toEqual({ retained: true });
    expect(parsed.data.reviewFindings[0]?.status).toBeUndefined();
    const structure = validateWorkplanStructure(parsed.data, "draft");
    expect(structure.issues).toContain("phases: At least one phase is required");

    const malformed = workplanInputSchemas.create.safeParse({ id: "bad", goal: 9 });
    expect(malformed.success).toBe(false);
    if (!malformed.success) expect(malformed.error.issues.some((issue) => issue.path[0] === "goal")).toBe(true);
    const nativeInput = createNativeWorkplanInputSchema(workplanCreateArgs, (input) => input.overwrite === true);
    const nativeResult = nativeInput.safeParse({ id: "bad", goal: "Create", overwrite: true });
    expect(nativeResult.success).toBe(false);
    if (!nativeResult.success) expect(nativeResult.error.issues.some((issue) => issue.path[0] === "expectedHash")).toBe(true);
    const jsonSchema = workplanInputJsonSchema(nativeInput);
    expect((jsonSchema.properties as Record<string, unknown>).workspaceRoot).toBeUndefined();
    expect((jsonSchema.properties as Record<string, unknown>).id).toBeDefined();
    expect(typeof (nativeInput as unknown as { "~standard"?: { validate?: unknown } })["~standard"]?.validate).toBe("function");
    const nativeUpdate = nativeWorkplanInputSchemas.update.safeParse({ id: "existing", appendNotes: ["change"] });
    expect(nativeUpdate.success).toBe(false);
    if (!nativeUpdate.success) expect(nativeUpdate.error.issues.some((issue) => issue.path[0] === "expectedHash")).toBe(true);
    const nativeCompact = nativeWorkplanInputSchemas.compact.safeParse({
      id: "existing", mode: "apply", archiveReason: "Reason", confirmation: "ARCHIVE_SELECTED_HISTORY", previewToken: "v1-token",
    });
    expect(nativeCompact.success).toBe(false);
    if (!nativeCompact.success) expect(nativeCompact.error.issues.some((issue) => issue.path[0] === "expectedHash")).toBe(true);
  });

  it("binds planHash to JSON, Markdown, and specs, and stateHash to checkpoint/dependencies", async () => {
    const root = mkdtempSync(join(tmpdir(), "workplan-hashes-"));
    try {
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs", "spec.md"), "spec one\n");
      await workplan_create.execute({ ...fixture("hash-plan"), specFiles: ["docs/spec.md"] }, context(root) as never);
      const jsonPath = join(root, ".opencode", "workplan", "hash-plan.json");
      const mdPath = join(root, ".opencode", "workplan", "hash-plan.md");
      const first = output<{ planHash: string; stateHash: string }>(await workplan_read.execute({ id: "hash-plan" }, context(root) as never));

      writeFileSync(mdPath, "handwritten bytes\n");
      const markdownChanged = output<{ planHash: string; stateHash: string }>(await workplan_read.execute({ id: "hash-plan" }, context(root) as never));
      expect(markdownChanged.planHash).not.toBe(first.planHash);

      writeFileSync(join(root, "docs", "spec.md"), "spec two\n");
      const specChanged = output<{ planHash: string; stateHash: string }>(await workplan_read.execute({ id: "hash-plan" }, context(root) as never));
      expect(specChanged.planHash).not.toBe(markdownChanged.planHash);

      const checkpoint = output<{ planHash: string; stateHash: string }>(await workplan_checkpoint.execute({
        id: "hash-plan", summary: "Current", nextAction: "Continue",
      }, context(root) as never));
      expect(checkpoint.planHash).toBe(specChanged.planHash);
      expect(checkpoint.stateHash).not.toBe(specChanged.stateHash);
      const withCheckpoint = checkpoint.stateHash;

      writeFileSync(join(root, ".opencode", "workplan", "hash-plan.dependencies.json"), `${JSON.stringify({
        schemaVersion: 1,
        id: "hash-plan",
        updatedAt: "2026-01-02T00:00:00.000Z",
        dependencies: [{ phaseId: "phase-main", stepId: "step-a", dependsOn: [{ phaseId: "phase-main", stepId: "step-b" }] }],
      }, null, 2)}\n`);
      const withDependencies = output<{ planHash: string; stateHash: string }>(await workplan_read.execute({ id: "hash-plan" }, context(root) as never));
      expect(withDependencies.planHash).toBe(specChanged.planHash);
      expect(withDependencies.stateHash).not.toBe(withCheckpoint);

      const legacy = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
      delete legacy.specFiles;
      legacy.customMetadata = { preserved: "unknown V2 field" };
      writeFileSync(jsonPath, `${JSON.stringify(legacy, null, 2)}\n`);
      const jsonChanged = output<{ planHash: string }>(await workplan_read.execute({ id: "hash-plan" }, context(root) as never));
      expect(jsonChanged.planHash).not.toBe(withDependencies.planHash);
      await workplan_update.execute({ id: "hash-plan", appendNotes: ["Keep the legacy shape"] }, context(root) as never);
      const stored = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
      expect(stored.specFiles).toBeUndefined();
      expect(stored.customMetadata).toEqual({ preserved: "unknown V2 field" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops denied and cancelled creates before directory or lock creation", async () => {
    const deniedRoot = mkdtempSync(join(tmpdir(), "workplan-denied-"));
    const abortedRoot = mkdtempSync(join(tmpdir(), "workplan-aborted-"));
    try {
      await expect(workplan_create.execute(fixture("denied"), context(deniedRoot, { ask: async () => { throw new Error("denied"); } }) as never)).rejects.toThrow("denied");
      expect(existsSync(join(deniedRoot, ".opencode", "workplan"))).toBe(false);

      const controller = new AbortController();
      await expect(workplan_create.execute(fixture("aborted"), context(abortedRoot, {
        abort: controller.signal,
        authorize: async () => { controller.abort(); },
      }) as never)).rejects.toThrow("aborted");
      expect(existsSync(join(abortedRoot, ".opencode", "workplan"))).toBe(false);
    } finally {
      rmSync(deniedRoot, { recursive: true, force: true });
      rmSync(abortedRoot, { recursive: true, force: true });
    }
  });

  it("rejects a cooperating update after an external edit during authorization", async () => {
    const root = mkdtempSync(join(tmpdir(), "workplan-auth-delay-"));
    try {
      await createFixture(root, "auth-delay");
      const jsonPath = join(root, ".opencode", "workplan", "auth-delay.json");
      const markdownPath = join(root, ".opencode", "workplan", "auth-delay.md");
      const beforeJson = readFileSync(jsonPath, "utf8");
      const edit = "External editor won during the permission prompt\n";
      await expect(workplan_update.execute({ id: "auth-delay", title: "Must not be committed" }, context(root, {
        authorize: async () => { writeFileSync(markdownPath, edit); },
      }) as never)).rejects.toThrow("changed while mutation authorization was being granted");
      expect(readFileSync(jsonPath, "utf8")).toBe(beforeJson);
      expect(readFileSync(markdownPath, "utf8")).toBe(edit);
      expect(existsSync(join(root, ".opencode", "workplan", "auth-delay.transaction.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers a journaled partial bundle and refuses rollback over an external edit", async () => {
    const root = mkdtempSync(join(tmpdir(), "workplan-recovery-"));
    const externalRoot = mkdtempSync(join(tmpdir(), "workplan-external-edit-"));
    try {
      await createFixture(root, "recover");
      const jsonPath = join(root, ".opencode", "workplan", "recover.json");
      const markdownPath = join(root, ".opencode", "workplan", "recover.md");
      await expect(workplan_update.execute({ id: "recover", title: "Partial" }, context(root, { fault: (stage) => { if (stage === "artifact-published") throw new Error("fault after first publish"); } }) as never))
        .rejects.toBeInstanceOf(WorkplanRecoveryRequiredError);
      const pending = output<{ recoveryRequired: boolean; stateHash: string }>(await workplan_read.execute({ id: "recover" }, context(root) as never));
      expect(pending.recoveryRequired).toBe(true);
      const recovered = output<{ recovered: boolean; stateHash: string }>(await workplan_update.execute({ id: "recover", recovery: "resume", expectedHash: pending.stateHash }, context(root) as never));
      expect(recovered.recovered).toBe(true);
      expect(existsSync(join(root, ".opencode", "workplan", "recover.transaction.json"))).toBe(false);
      expect(JSON.parse(readFileSync(jsonPath, "utf8")).title).toBe("Partial");
      expect(readFileSync(markdownPath, "utf8")).toContain("Partial");

      await createFixture(externalRoot, "external");
      await expect(workplan_update.execute({ id: "external", title: "External target" }, context(externalRoot, { fault: (stage) => { if (stage === "artifact-published") throw new Error("fault"); } }) as never))
        .rejects.toBeInstanceOf(WorkplanRecoveryRequiredError);
      const externalMarkdown = join(externalRoot, ".opencode", "workplan", "external.md");
      writeFileSync(externalMarkdown, "outside edit\n");
      const externalPending = output<{ stateHash: string }>(await workplan_read.execute({ id: "external" }, context(externalRoot) as never));
      await expect(workplan_update.execute({ id: "external", recovery: "rollback", expectedHash: externalPending.stateHash }, context(externalRoot) as never))
        .rejects.toBeInstanceOf(WorkplanRecoveryRequiredError);
      expect(readFileSync(externalMarkdown, "utf8")).toBe("outside edit\n");
      expect(existsSync(join(externalRoot, ".opencode", "workplan", "external.transaction.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it("rejects self-consistent journal targets outside the trusted plan artifact set before authorization", async () => {
    const cases = [
      { name: "workspace-file", target: "src/victim.ts", error: "not a permitted workplan artifact" },
      { name: "unlinked-markdown", target: ".opencode/workplan/unrelated.md", error: "not a permitted workplan artifact" },
      { name: "other-checkpoint", target: ".opencode/workplan/other.checkpoint.json", error: "not a permitted workplan artifact" },
      { name: "other-archive", target: ".opencode/workplan/archive/other/state-aaaaaaaaaaaa-bbbbbbbbbbbb.json", error: "not a permitted workplan artifact" },
      { name: "wrong-json-id", editPlan: (plan: Record<string, unknown>) => { plan.id = "other-plan"; }, error: "id does not match filename" },
      { name: "outside-plan-file", editPlan: (plan: Record<string, unknown>) => { plan.planFile = "src/victim.ts"; }, error: "Plan file must stay under .opencode/workplan" },
      { name: "malformed-plan-file", editPlan: (plan: Record<string, unknown>) => { plan.planFile = ""; }, error: "Plan file must point to a file inside the workspace root" },
    ];
    for (const testCase of cases) {
      const root = mkdtempSync(join(tmpdir(), `workplan-forged-journal-${testCase.name}-`));
      try {
        const id = "forged-scope";
        await createFixture(root, id);
        const directory = join(root, ".opencode", "workplan");
        mkdirSync(join(root, "src"), { recursive: true });
        const victimPath = join(root, "src", "victim.ts");
        writeFileSync(victimPath, "untouched\n");
        await expect(workplan_update.execute({ id, title: "Pending update" }, context(root, {
          fault: (stage) => { if (stage === "journal-published") throw new Error("leave pending journal"); },
        }) as never)).rejects.toBeInstanceOf(WorkplanRecoveryRequiredError);

        const journalPath = join(directory, `${id}.transaction.json`);
        const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
          targets: Array<{ path: string; beforeContent: string | null; afterContent: string | null; beforeHash: string | null; afterHash: string | null }>;
        };
        if (testCase.target) {
          const markdownTarget = journal.targets.find((target) => target.path.endsWith(".md"));
          if (!markdownTarget) throw new Error("Fixture transaction did not include its linked Markdown target");
          markdownTarget.path = testCase.target;
        }
        if (testCase.editPlan) {
          const jsonTarget = journal.targets.find((target) => target.path === `.opencode/workplan/${id}.json`);
          if (!jsonTarget?.afterContent) throw new Error("Fixture transaction did not include its plan JSON after image");
          const afterPlan = JSON.parse(Buffer.from(jsonTarget.afterContent, "base64").toString("utf8")) as Record<string, unknown>;
          testCase.editPlan(afterPlan);
          const afterBytes = Buffer.from(`${JSON.stringify(afterPlan, null, 2)}\n`);
          jsonTarget.afterContent = afterBytes.toString("base64");
          jsonTarget.afterHash = createHash("sha256").update(afterBytes).digest("hex");
        }
        writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
        const pending = output<{ stateHash: string }>(await workplan_read.execute({ id }, context(root) as never));
        const beforeFiles = readdirSync(directory).sort().map((name) => {
          const path = join(directory, name);
          return { name, bytes: statSync(path).isFile() ? readFileSync(path).toString("base64") : null, mtimeMs: statSync(path).mtimeMs };
        });
        const beforeDirectoryMtime = statSync(directory).mtimeMs;
        const beforeVictim = { bytes: readFileSync(victimPath, "utf8"), mtimeMs: statSync(victimPath).mtimeMs };
        const asks: Ask[] = [];
        let authorizations = 0;
        await expect(workplan_update.execute({ id, recovery: "resume", expectedHash: pending.stateHash }, context(root, {
          asks,
          authorize: async () => { authorizations += 1; },
        }) as never)).rejects.toThrow(testCase.error);
        expect(authorizations).toBe(0);
        expect(asks).toHaveLength(0);
        expect(readdirSync(directory).sort().map((name) => {
          const path = join(directory, name);
          return { name, bytes: statSync(path).isFile() ? readFileSync(path).toString("base64") : null, mtimeMs: statSync(path).mtimeMs };
        })).toEqual(beforeFiles);
        expect(statSync(directory).mtimeMs).toBe(beforeDirectoryMtime);
        expect({ bytes: readFileSync(victimPath, "utf8"), mtimeMs: statSync(victimPath).mtimeMs }).toEqual(beforeVictim);
        expect(readdirSync(directory).some((name) => name.endsWith(".lock"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects moving a missing Markdown link unless explicit nonblank Markdown is supplied", async () => {
    const root = mkdtempSync(join(tmpdir(), "workplan-missing-markdown-move-"));
    try {
      const id = "missing-markdown";
      await createFixture(root, id);
      const directory = join(root, ".opencode", "workplan");
      const jsonPath = join(directory, `${id}.json`);
      const oldMarkdownPath = join(directory, `${id}.md`);
      const nextPlanFile = `.opencode/workplan/${id}-repaired.md`;
      unlinkSync(oldMarkdownPath);
      const capture = () => ({
        files: readdirSync(directory).sort().map((name) => {
          const path = join(directory, name);
          return { name, bytes: statSync(path).isFile() ? readFileSync(path).toString("base64") : null, mtimeMs: statSync(path).mtimeMs };
        }),
        directoryMtime: statSync(directory).mtimeMs,
      });
      const before = capture();
      for (const planMarkdown of [undefined, " \n\t "]) {
        const asks: Ask[] = [];
        let authorizations = 0;
        await expect(workplan_update.execute({
          id,
          planFile: nextPlanFile,
          ...(planMarkdown === undefined ? {} : { planMarkdown }),
        }, context(root, { asks, authorize: async () => { authorizations += 1; } }) as never))
          .rejects.toThrow("source Markdown is missing; supply a nonblank planMarkdown explicitly");
        expect(authorizations).toBe(0);
        expect(asks).toHaveLength(0);
        expect(capture()).toEqual(before);
        expect(existsSync(join(root, nextPlanFile))).toBe(false);
        expect(existsSync(join(directory, `${id}.transaction.json`))).toBe(false);
      }

      await workplan_update.execute({ id, title: "Same-link metadata update" }, context(root) as never);
      expect(JSON.parse(readFileSync(jsonPath, "utf8")).planFile).toBe(`.opencode/workplan/${id}.md`);
      expect(existsSync(oldMarkdownPath)).toBe(false);

      await expect(workplan_update.execute({
        id,
        planFile: nextPlanFile,
        planMarkdown: "Explicit repair content\n",
      }, context(root, { fault: (stage) => { if (stage === "artifact-published") throw new Error("leave explicit move pending"); } }) as never))
        .rejects.toBeInstanceOf(WorkplanRecoveryRequiredError);
      const pending = output<{ stateHash: string }>(await workplan_read.execute({ id }, context(root) as never));
      await workplan_update.execute({ id, recovery: "resume", expectedHash: pending.stateHash }, context(root) as never);
      expect(JSON.parse(readFileSync(jsonPath, "utf8")).planFile).toBe(nextPlanFile);
      expect(readFileSync(join(root, nextPlanFile), "utf8")).toBe("Explicit repair content\n");
      expect(existsSync(oldMarkdownPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects forged dependency-update journals without the exact absent after-linked Markdown target", async () => {
    const cases = ["missing-after-target", "old-link-only", "deleted-after-target", "overwritten-after-target"] as const;
    for (const variant of cases) {
      const root = mkdtempSync(join(tmpdir(), `workplan-incomplete-move-${variant}-`));
      try {
        const id = "incomplete-move";
        await createFixture(root, id);
        const directory = join(root, ".opencode", "workplan");
        const oldMarkdownPath = join(directory, `${id}.md`);
        const afterPlanFile = `.opencode/workplan/${id}-invented.md`;
        const afterMarkdownPath = join(root, afterPlanFile);
        await workplan_update.execute({
          id,
          dependencies: [{ phaseId: "phase-main", stepId: "step-b", dependsOn: [{ phaseId: "phase-main", stepId: "step-a" }] }],
        }, context(root) as never);
        await expect(workplan_update.execute({
          id,
          dependencies: [{ phaseId: "phase-main", stepId: "step-a", dependsOn: [{ phaseId: "phase-main", stepId: "step-b" }] }],
        }, context(root, { fault: (stage) => { if (stage === "journal-published") throw new Error("leave dependency-only journal pending"); } }) as never))
          .rejects.toBeInstanceOf(WorkplanRecoveryRequiredError);

        const journalPath = join(directory, `${id}.transaction.json`);
        const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
          targets: Array<{ path: string; beforeContent: string | null; afterContent: string | null; beforeHash: string | null; afterHash: string | null; mode: number }>;
        };
        expect(journal.targets.some((target) => target.path === `.opencode/workplan/${id}.json`)).toBe(true);
        expect(journal.targets.some((target) => target.path === `.opencode/workplan/${id}.dependencies.json`)).toBe(true);
        expect(journal.targets.some((target) => target.path.endsWith(".md"))).toBe(false);
        const jsonTarget = journal.targets.find((target) => target.path === `.opencode/workplan/${id}.json`)!;
        const afterPlan = JSON.parse(Buffer.from(jsonTarget.afterContent!, "base64").toString("utf8")) as Record<string, unknown>;
        afterPlan.planFile = afterPlanFile;
        const afterJson = Buffer.from(`${JSON.stringify(afterPlan, null, 2)}\n`);
        jsonTarget.afterContent = afterJson.toString("base64");
        jsonTarget.afterHash = createHash("sha256").update(afterJson).digest("hex");

        if (variant === "old-link-only") {
          const beforeMarkdown = readFileSync(oldMarkdownPath);
          const afterMarkdown = Buffer.from("forged old-link rewrite\n");
          journal.targets.push({
            path: `.opencode/workplan/${id}.md`,
            beforeContent: beforeMarkdown.toString("base64"),
            afterContent: afterMarkdown.toString("base64"),
            beforeHash: createHash("sha256").update(beforeMarkdown).digest("hex"),
            afterHash: createHash("sha256").update(afterMarkdown).digest("hex"),
            mode: 0o600,
          });
        } else if (variant === "deleted-after-target") {
          journal.targets.push({ path: afterPlanFile, beforeContent: null, afterContent: null, beforeHash: null, afterHash: null, mode: 0o600 });
        } else if (variant === "overwritten-after-target") {
          const existing = Buffer.from("existing unlinked destination\n");
          const replacement = Buffer.from("forged replacement\n");
          writeFileSync(afterMarkdownPath, existing);
          journal.targets.push({
            path: afterPlanFile,
            beforeContent: existing.toString("base64"),
            afterContent: replacement.toString("base64"),
            beforeHash: createHash("sha256").update(existing).digest("hex"),
            afterHash: createHash("sha256").update(replacement).digest("hex"),
            mode: 0o600,
          });
        }
        writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
        const beforePlanBytes = readFileSync(join(directory, `${id}.json`));
        expect(JSON.parse(beforePlanBytes.toString("utf8")).planFile).toBe(`.opencode/workplan/${id}.md`);
        const pending = output<{ stateHash: string }>(await workplan_read.execute({ id }, context(root) as never));
        const capture = () => ({
          files: readdirSync(directory).sort().map((name) => {
            const path = join(directory, name);
            return { name, bytes: statSync(path).isFile() ? readFileSync(path).toString("base64") : null, mtimeMs: statSync(path).mtimeMs };
          }),
          directoryMtime: statSync(directory).mtimeMs,
        });
        const before = capture();
        for (const recovery of ["resume", "rollback"] as const) {
          const asks: Ask[] = [];
          let authorizations = 0;
          await expect(workplan_update.execute({ id, recovery, expectedHash: pending.stateHash }, context(root, {
            asks,
            authorize: async () => { authorizations += 1; },
          }) as never)).rejects.toThrow("exact after-linked Markdown target");
          expect(authorizations).toBe(0);
          expect(asks).toHaveLength(0);
          expect(capture()).toEqual(before);
          expect(readFileSync(join(directory, `${id}.json`))).toEqual(beforePlanBytes);
          expect(readdirSync(directory).some((name) => name.endsWith(".lock"))).toBe(false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("recovers only genuine create, move, sidecar, Markdown, reset, and compaction journals", async () => {
    const root = mkdtempSync(join(tmpdir(), "workplan-valid-journal-scopes-"));
    const faultAfterPublish = (stage: string) => { if (stage === "artifact-published") throw new Error("leave a genuine pending transaction"); };
    const expectRecovery = async (id: string) => {
      const pending = output<{ recoveryRequired: boolean; stateHash: string }>(await workplan_read.execute({ id }, context(root) as never));
      expect(pending.recoveryRequired).toBe(true);
      await workplan_update.execute({ id, recovery: "resume", expectedHash: pending.stateHash }, context(root) as never);
      expect(existsSync(join(root, ".opencode", "workplan", `${id}.transaction.json`))).toBe(false);
    };
    try {
      const createId = "create-recovery";
      await expect(workplan_create.execute(fixture(createId, `.opencode/workplan/${createId}.md`), context(root, { fault: faultAfterPublish }) as never))
        .rejects.toBeInstanceOf(WorkplanRecoveryRequiredError);
      await expectRecovery(createId);
      expect(existsSync(join(root, ".opencode", "workplan", `${createId}.md`))).toBe(true);

      const moveId = "move-recovery";
      await createFixture(root, moveId);
      await expect(workplan_update.execute({ id: moveId, planFile: `.opencode/workplan/${moveId}-moved.md` }, context(root, { fault: faultAfterPublish }) as never))
        .rejects.toBeInstanceOf(WorkplanRecoveryRequiredError);
      await expectRecovery(moveId);
      expect(JSON.parse(readFileSync(join(root, ".opencode", "workplan", `${moveId}.json`), "utf8")).planFile).toBe(`.opencode/workplan/${moveId}-moved.md`);

      const rollbackMoveId = "move-rollback-recovery";
      await createFixture(root, rollbackMoveId);
      let publishedArtifacts = 0;
      await expect(workplan_update.execute({ id: rollbackMoveId, planFile: `.opencode/workplan/${rollbackMoveId}-moved.md` }, context(root, {
        fault: (stage) => {
          if (stage === "artifact-published" && ++publishedArtifacts === 2) throw new Error("leave moved Markdown published");
        },
      }) as never)).rejects.toBeInstanceOf(WorkplanRecoveryRequiredError);
      const rollbackPending = output<{ stateHash: string }>(await workplan_read.execute({ id: rollbackMoveId }, context(root) as never));
      await workplan_update.execute({ id: rollbackMoveId, recovery: "rollback", expectedHash: rollbackPending.stateHash }, context(root) as never);
      expect(JSON.parse(readFileSync(join(root, ".opencode", "workplan", `${rollbackMoveId}.json`), "utf8")).planFile).toBe(`.opencode/workplan/${rollbackMoveId}.md`);
      expect(existsSync(join(root, ".opencode", "workplan", `${rollbackMoveId}.md`))).toBe(true);
      expect(existsSync(join(root, ".opencode", "workplan", `${rollbackMoveId}-moved.md`))).toBe(false);

      const checkpointId = "checkpoint-recovery";
      await createFixture(root, checkpointId);
      await expect(workplan_checkpoint.execute({ id: checkpointId, summary: "Current", nextAction: "Continue" }, context(root, { fault: faultAfterPublish }) as never))
        .rejects.toBeInstanceOf(WorkplanRecoveryRequiredError);
      await expectRecovery(checkpointId);

      const dependencyId = "dependency-recovery";
      await createFixture(root, dependencyId);
      await expect(workplan_update.execute({
        id: dependencyId,
        dependencies: [{ phaseId: "phase-main", stepId: "step-b", dependsOn: [{ phaseId: "phase-main", stepId: "step-a" }] }],
      }, context(root, { fault: faultAfterPublish }) as never)).rejects.toBeInstanceOf(WorkplanRecoveryRequiredError);
      await expectRecovery(dependencyId);
      expect(existsSync(join(root, ".opencode", "workplan", `${dependencyId}.dependencies.json`))).toBe(true);

      const normalizedLinkId = "normalized-link-recovery";
      await createFixture(root, normalizedLinkId);
      const normalizedJsonPath = join(root, ".opencode", "workplan", `${normalizedLinkId}.json`);
      const normalizedMarkdownPath = join(root, ".opencode", "workplan", `${normalizedLinkId}.md`);
      const normalizedMarkdownBefore = readFileSync(normalizedMarkdownPath);
      const absoluteLinkPlan = JSON.parse(readFileSync(normalizedJsonPath, "utf8")) as Record<string, unknown>;
      absoluteLinkPlan.planFile = join(realpathSync(root), ".opencode", "workplan", `${normalizedLinkId}.md`);
      writeFileSync(normalizedJsonPath, `${JSON.stringify(absoluteLinkPlan, null, 2)}\n`);
      await expect(workplan_update.execute({
        id: normalizedLinkId,
        dependencies: [{ phaseId: "phase-main", stepId: "step-b", dependsOn: [{ phaseId: "phase-main", stepId: "step-a" }] }],
      }, context(root, { fault: faultAfterPublish }) as never)).rejects.toBeInstanceOf(WorkplanRecoveryRequiredError);
      const normalizedPending = output<{ stateHash: string }>(await workplan_read.execute({ id: normalizedLinkId }, context(root) as never));
      const normalizedJournal = JSON.parse(readFileSync(join(root, ".opencode", "workplan", `${normalizedLinkId}.transaction.json`), "utf8")) as {
        targets: Array<{ path: string }>;
      };
      expect(normalizedJournal.targets.some((target) => target.path.endsWith(".md"))).toBe(false);
      await workplan_update.execute({ id: normalizedLinkId, recovery: "resume", expectedHash: normalizedPending.stateHash }, context(root) as never);
      expect(JSON.parse(readFileSync(normalizedJsonPath, "utf8")).planFile).toBe(`.opencode/workplan/${normalizedLinkId}.md`);
      expect(readFileSync(normalizedMarkdownPath)).toEqual(normalizedMarkdownBefore);

      const markdownId = "markdown-recovery";
      await createFixture(root, markdownId);
      await expect(workplan_reset.execute({ id: markdownId, mode: "markdown-only", preserveNotes: false }, context(root, { fault: faultAfterPublish }) as never))
        .rejects.toBeInstanceOf(WorkplanRecoveryRequiredError);
      await expectRecovery(markdownId);

      const resetId = "reset-recovery";
      await createFixture(root, resetId);
      await expect(workplan_reset.execute({ id: resetId, mode: "draft", preserveNotes: false }, context(root, { fault: faultAfterPublish }) as never))
        .rejects.toBeInstanceOf(WorkplanRecoveryRequiredError);
      await expectRecovery(resetId);

      const compactId = "compact-recovery";
      await workplan_create.execute({
        id: compactId,
        kind: "test",
        goal: "Recover a coherent archive transaction",
        status: "in_progress",
        overwrite: false,
        phases: [
          { id: "finished", title: "Finished", status: "completed", steps: [{ id: "done", title: "Done", action: "Complete", validation: "Check", status: "completed" }] },
          { id: "active", title: "Active", status: "in_progress", steps: [{ id: "todo", title: "Todo", action: "Continue", validation: "Check", status: "in_progress" }] },
        ],
      }, context(root) as never);
      await workplan_update.execute({
        id: compactId,
        dependencies: [{ phaseId: "active", stepId: "todo", dependsOn: [{ phaseId: "finished", stepId: "done" }] }],
      }, context(root) as never);
      await workplan_checkpoint.execute({ id: compactId, summary: "Current", nextAction: "Continue" }, context(root) as never);
      const preview = output<{ previewToken: string; stateHash: string }>(await workplan_compact.execute({
        id: compactId, mode: "preview", archiveReason: "Archive completed setup", completedPhaseIds: ["finished"],
      }, context(root) as never));
      await expect(workplan_compact.execute({
        id: compactId,
        mode: "apply",
        archiveReason: "Archive completed setup",
        completedPhaseIds: ["finished"],
        previewToken: preview.previewToken,
        expectedHash: preview.stateHash,
        confirmation: "ARCHIVE_SELECTED_HISTORY",
      }, context(root, { fault: faultAfterPublish }) as never)).rejects.toBeInstanceOf(WorkplanRecoveryRequiredError);
      await expectRecovery(compactId);
      expect(readdirSync(join(root, ".opencode", "workplan", "archive", compactId)).some((name) => name.endsWith(".json"))).toBe(true);
      const compactDependencies = JSON.parse(readFileSync(join(root, ".opencode", "workplan", `${compactId}.dependencies.json`), "utf8")) as {
        terminalSummaries: Array<{ phaseId: string; stepId: string; title: string; status: string }>;
      };
      expect(compactDependencies.terminalSummaries).toContainEqual({ phaseId: "finished", stepId: "done", title: "Done", status: "completed" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cleans unpublished stages and keeps journals after each durable publication boundary", async () => {
    for (const stage of ["artifact-staged", "journal-staged", "journal-published", "artifact-published", "before-complete"]) {
      const root = mkdtempSync(join(tmpdir(), `workplan-fault-${stage}-`));
      try {
        await createFixture(root, "faulted");
        const jsonPath = join(root, ".opencode", "workplan", "faulted.json");
        const markdownPath = join(root, ".opencode", "workplan", "faulted.md");
        const beforeJson = readFileSync(jsonPath, "utf8");
        const beforeMarkdown = readFileSync(markdownPath, "utf8");
        await expect(workplan_update.execute({ id: "faulted", title: "Faulted commit" }, context(root, {
          fault: (current) => { if (current === stage) throw new Error(`fault:${stage}`); },
        }) as never)).rejects.toThrow(stage === "artifact-staged" || stage === "journal-staged" ? `fault:${stage}` : "requires explicit recovery");
        const journalPath = join(root, ".opencode", "workplan", "faulted.transaction.json");
        if (stage === "artifact-staged" || stage === "journal-staged") {
          expect(existsSync(journalPath)).toBe(false);
          expect(readFileSync(jsonPath, "utf8")).toBe(beforeJson);
          expect(readFileSync(markdownPath, "utf8")).toBe(beforeMarkdown);
          expect(readdirSync(join(root, ".opencode", "workplan")).some((name) => name.endsWith(".stage"))).toBe(false);
        } else {
          expect(existsSync(journalPath)).toBe(true);
          const pending = output<{ recoveryRequired: boolean; stateHash: string }>(await workplan_read.execute({ id: "faulted" }, context(root) as never));
          expect(pending.recoveryRequired).toBe(true);
          await workplan_update.execute({ id: "faulted", recovery: "resume", expectedHash: pending.stateHash }, context(root) as never);
          expect(existsSync(journalPath)).toBe(false);
          expect(JSON.parse(readFileSync(jsonPath, "utf8")).title).toBe("Faulted commit");
          expect(readFileSync(markdownPath, "utf8")).toContain("Faulted commit");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("binds compaction to exact selections and emits bounded deterministic resume pages", async () => {
    const root = mkdtempSync(join(tmpdir(), "workplan-paging-"));
    try {
      await workplan_create.execute({
        id: "paged",
        kind: "test",
        goal: "Large goal ".repeat(2000),
        status: "in_progress",
        overwrite: false,
        phases: [{ id: "phase", title: "Phase", status: "in_progress", steps: Array.from({ length: 1200 }, (_value, index) => ({
          id: `step-${index}`,
          title: `Step ${index} ` + "x".repeat(500),
          action: "Execute " + "a".repeat(500),
          validation: "Check " + "v".repeat(500),
          status: "in_progress" as const,
        })) }],
        reviewFindings: [{ severity: "major", title: "High finding " + "h".repeat(1000) }],
      }, context(root) as never);
      const firstRaw = await workplan_resume.execute({ id: "paged", maxChars: 4096, limit: 20 }, context(root) as never);
      const firstText = typeof firstRaw === "string" ? firstRaw : (firstRaw as { output: string }).output;
      const secondRaw = await workplan_resume.execute({ id: "paged", maxChars: 4096, limit: 20 }, context(root) as never);
      const secondText = typeof secondRaw === "string" ? secondRaw : (secondRaw as { output: string }).output;
      expect(firstText.length).toBeLessThanOrEqual(4096);
      expect(secondText).toBe(firstText);
      const defaultRaw = await workplan_resume.execute({ id: "paged" }, context(root) as never);
      const defaultText = typeof defaultRaw === "string" ? defaultRaw : (defaultRaw as { output: string }).output;
      expect(defaultText.length).toBeLessThanOrEqual(12000);
      const maximumRaw = await workplan_resume.execute({ id: "paged", maxChars: 64000, limit: 100 }, context(root) as never);
      const maximumText = typeof maximumRaw === "string" ? maximumRaw : (maximumRaw as { output: string }).output;
      expect(maximumText.length).toBeLessThanOrEqual(64000);
      expect(workplanInputSchemas.resume.safeParse({ id: "paged", maxChars: 4095 }).success).toBe(false);
      const firstPage = JSON.parse(firstText) as { page: { items: Array<{ stepId?: string }>; nextCursor: string | null }; safety: { highFindingCounts: { major: number } } };
      expect(firstPage.safety.highFindingCounts.major).toBe(1);
      expect(firstPage.page.items.length).toBeGreaterThan(0);
      expect(firstPage.page.nextCursor).not.toBeNull();
      const nextRaw = await workplan_resume.execute({ id: "paged", maxChars: 4096, limit: 20, cursor: firstPage.page.nextCursor! }, context(root) as never);
      const nextPage = JSON.parse(typeof nextRaw === "string" ? nextRaw : (nextRaw as { output: string }).output) as { page: { items: Array<{ stepId?: string }> } };
      const firstIds = new Set(firstPage.page.items.map((item) => item.stepId).filter(Boolean));
      expect(nextPage.page.items.some((item) => item.stepId && firstIds.has(item.stepId))).toBe(false);
      const forgedCursor = JSON.parse(Buffer.from(firstPage.page.nextCursor!, "base64url").toString("utf8")) as { offset: number };
      forgedCursor.offset += 1;
      await expect(workplan_resume.execute({ id: "paged", maxChars: 4096, limit: 20, cursor: Buffer.from(JSON.stringify(forgedCursor)).toString("base64url") }, context(root) as never)).rejects.toThrow("Invalid workplan resume cursor");
      await workplan_update.execute({ id: "paged", appendNotes: ["State changed"] }, context(root) as never);
      await expect(workplan_resume.execute({ id: "paged", maxChars: 4096, limit: 20, cursor: firstPage.page.nextCursor! }, context(root) as never)).rejects.toThrow("Stale or option-mismatched");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds realistic fresh, stale, legacy, and corrupt continuation packets without touching artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "workplan-resume-budget-"));
    try {
      const id = "resume-budget";
      const longText = (label: string) => `${label} \"quoted\" 😀 \u0001\n${"é/\\\"".repeat(90)}`;
      await workplan_create.execute({
        id,
        kind: "test",
        goal: longText("Goal"),
        title: longText("Continuation budget"),
        status: "in_progress",
        overwrite: false,
        scope: Array.from({ length: 8 }, (_value, index) => longText(`scope-${index}`)),
        nonGoals: Array.from({ length: 5 }, (_value, index) => longText(`non-goal-${index}`)),
        constraints: Array.from({ length: 13 }, (_value, index) => longText(`constraint-${index}`)),
        relevantFiles: Array.from({ length: 30 }, (_value, index) => `${"nested/".repeat(24)}file-${index}-${"x".repeat(90)}.ts`),
        phases: Array.from({ length: 3 }, (_value, phaseIndex) => ({
          id: `phase-${String.fromCharCode(65 + phaseIndex).toLowerCase().repeat(100)}`,
          title: longText(`Phase ${phaseIndex}`),
          status: "in_progress" as const,
          steps: Array.from({ length: 3 }, (_step, stepIndex) => ({
            id: `step-${String.fromCharCode(97 + stepIndex).repeat(100)}-${phaseIndex}`,
            title: longText(`Step ${phaseIndex}/${stepIndex}`),
            action: longText("Action"),
            validation: longText("Validation"),
            status: "in_progress" as const,
          })),
        })),
        reviewFindings: [
          { severity: "blocker", title: longText("Blocker"), detail: longText("Blocker detail") },
          { severity: "major", title: longText("Major"), detail: longText("Major detail") },
          { severity: "minor", title: longText("Minor"), detail: longText("Minor detail") },
        ],
      }, context(root) as never);
      const directory = join(root, ".opencode", "workplan");
      const jsonPath = join(directory, `${id}.json`);
      const markdownPath = join(directory, `${id}.md`);
      const checkpointPath = join(directory, `${id}.checkpoint.json`);
      const storedPlan = JSON.parse(readFileSync(jsonPath, "utf8")) as {
        phases: Array<{ id: string; steps: Array<{ id: string }> }>;
        reviewFindings: Array<Record<string, unknown>>;
      };
      storedPlan.reviewFindings[0]!.producerMetadata = Array.from({ length: 128 }, (_value, index) => longText(`producer-${index}`));
      writeFileSync(jsonPath, `${JSON.stringify(storedPlan, null, 2)}\n`);
      const phaseId = storedPlan.phases[0]!.id;
      const stepId = storedPlan.phases[0]!.steps[0]!.id;
      await workplan_checkpoint.execute({
        id,
        summary: longText("Fresh checkpoint"),
        nextAction: longText("Fresh next action"),
        phaseId,
        stepId,
        blockers: Array.from({ length: 8 }, (_value, index) => longText(`blocker-${index}`)),
        recentValidation: Array.from({ length: 8 }, (_value, index) => longText(`validation-${index}`)),
        guardrails: Array.from({ length: 12 }, (_value, index) => longText(`guardrail-${index}`)),
        references: Array.from({ length: 12 }, (_value, index) => `${"very/deep/path/".repeat(20)}ref-${index}-${"r".repeat(80)}`),
      }, context(root) as never);

      const capture = () => ({
        files: [jsonPath, markdownPath, checkpointPath].map((path) => ({
          bytes: readFileSync(path).toString("base64"),
          mtimeMs: statSync(path).mtimeMs,
        })),
        directoryMtime: statSync(directory).mtimeMs,
      });
      const readPacket = async (maxChars: number, selectedPhaseId = phaseId) => {
        const raw = await workplan_resume.execute({ id, maxChars, limit: 1, phaseId: selectedPhaseId }, context(root) as never);
        const text = typeof raw === "string" ? raw : (raw as { output: string }).output;
        return { text, packet: JSON.parse(text) as {
          hashes: { planHash: string; stateHash: string };
          checkpoint: { fresh: boolean; nextAction: string | null; evidenceStatus: string; current: { phaseId: string; stepId: string; phaseStatus: string; stepStatus: string } | null };
          safety: { overflow: boolean; omittedDangerCounts: Record<string, number>; highFindingCounts: { blocker: number; critical: number; major: number }; highFindings: Array<{ metadataOmitted?: boolean }>; unverifiedWarningCount: number; overflowPointers: string[]; truncatedDangerFieldCount: number };
          page: { total: number; offset: number; returned: number; items: Array<{ stepId?: string }>; nextCursor: string | null };
          retrieval: { read: string; inspect: string; dependencies: string };
          truncatedFieldCount: number;
          truncatedFields: string[];
        } };
      };

      let before = capture();
      const fresh = await readPacket(4096);
      expect(fresh.text.length).toBeLessThanOrEqual(4096);
      expect(fresh.packet.hashes.planHash).toMatch(/^[a-f0-9]{64}$/);
      expect(fresh.packet.hashes.stateHash).toMatch(/^[a-f0-9]{64}$/);
      expect(fresh.packet.checkpoint.fresh).toBe(true);
      expect(fresh.packet.checkpoint.current).toMatchObject({ phaseId, stepId, phaseStatus: "in_progress", stepStatus: "in_progress" });
      expect(fresh.packet.checkpoint.evidenceStatus).toBe("unverified");
      expect(fresh.packet.safety.highFindingCounts).toEqual({ blocker: 1, critical: 0, major: 1 });
      expect(fresh.packet.safety.highFindings[0]?.metadataOmitted).toBe(true);
      expect(fresh.packet.truncatedFields).toContain("safety.highFindings[0].customMetadata");
      expect(fresh.packet.safety.overflow).toBe(true);
      expect(fresh.packet.safety.omittedDangerCounts.constraints).toBeGreaterThan(0);
      expect(fresh.packet.safety.truncatedDangerFieldCount).toBeGreaterThan(0);
      expect(fresh.packet.safety.overflowPointers).toEqual([`workplan_read:${id}`, `workplan_inspect:${id}`]);
      expect(fresh.packet.retrieval).toEqual({ read: `workplan_read id=${id}`, inspect: `workplan_inspect id=${id}`, dependencies: `.opencode/workplan/${id}.dependencies.json` });
      expect(fresh.packet.page.returned).toBe(1);
      expect(fresh.packet.page.nextCursor).not.toBeNull();
      expect(fresh.packet.page.nextCursor!.length).toBeLessThan(512);
      const decodedCursor = JSON.parse(Buffer.from(fresh.packet.page.nextCursor!, "base64url").toString("utf8")) as { phaseId: string; stateHash: string };
      expect(decodedCursor.phaseId).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(decodedCursor.phaseId).not.toBe(phaseId);
      expect(decodedCursor.stateHash).toBe(fresh.packet.hashes.stateHash);
      expect(capture()).toEqual(before);

      const repeated = await readPacket(4096);
      expect(repeated.text).toBe(fresh.text);
      const nextRaw = await workplan_resume.execute({ id, maxChars: 4096, limit: 1, phaseId, cursor: fresh.packet.page.nextCursor! }, context(root) as never);
      const nextText = typeof nextRaw === "string" ? nextRaw : (nextRaw as { output: string }).output;
      const nextPage = JSON.parse(nextText) as { page: { offset: number; returned: number; items: Array<{ stepId?: string }>; nextCursor: string | null } };
      expect(nextText.length).toBeLessThanOrEqual(4096);
      expect(nextPage.page.offset).toBe(1);
      expect(nextPage.page.returned).toBe(1);
      expect(nextPage.page.items[0]?.stepId).not.toBe(fresh.packet.page.items[0]?.stepId);
      expect(nextPage.page.nextCursor?.length ?? 0).toBeLessThan(512);
      expect(capture()).toEqual(before);

      const larger = await readPacket(12000);
      expect(larger.text.length).toBeLessThanOrEqual(12000);
      const maximum = await readPacket(64000);
      expect(maximum.text.length).toBeLessThanOrEqual(64000);
      expect(capture()).toEqual(before);

      await workplan_update.execute({ id, appendNotes: ["Make the checkpoint stale"] }, context(root) as never);
      before = capture();
      const stale = await readPacket(4096);
      expect(stale.text.length).toBeLessThanOrEqual(4096);
      expect(stale.packet.checkpoint.fresh).toBe(false);
      expect(stale.packet.checkpoint.nextAction).toBeNull();
      expect(stale.packet.safety.unverifiedWarningCount).toBeGreaterThan(0);
      expect(stale.packet.safety.overflow).toBe(true);
      expect(capture()).toEqual(before);

      writeFileSync(checkpointPath, `${JSON.stringify({
        schemaVersion: 1,
        id,
        sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
        sourceHash: "a".repeat(64),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        status: "in_progress",
        summary: longText("Legacy summary"),
        current: null,
        nextAction: longText("Unverified legacy action"),
        blockers: [longText("Legacy blocker")],
        recentValidation: [longText("Legacy validation")],
        guardrails: Array.from({ length: 24 }, (_value, index) => longText(`legacy-guardrail-${index}`)),
        references: Array.from({ length: 24 }, (_value, index) => `${"legacy/deep/path/".repeat(20)}-${index}`),
      }, null, 2)}\n`);
      before = capture();
      const legacy = await readPacket(4096);
      expect(legacy.text.length).toBeLessThanOrEqual(4096);
      expect(legacy.packet.checkpoint.fresh).toBe(false);
      expect(legacy.packet.checkpoint.nextAction).toBeNull();
      expect(legacy.packet.safety.unverifiedWarningCount).toBeGreaterThan(0);
      expect(legacy.packet.safety.overflow).toBe(true);
      expect(capture()).toEqual(before);

      writeFileSync(checkpointPath, "not-json\n");
      before = capture();
      const corrupt = await readPacket(4096);
      expect(corrupt.text.length).toBeLessThanOrEqual(4096);
      expect(corrupt.packet.checkpoint.fresh).toBe(false);
      expect(corrupt.packet.safety.overflow).toBe(true);
      expect(capture()).toEqual(before);

      const longPlan = JSON.parse(readFileSync(jsonPath, "utf8")) as { phases: Array<{ id: string; steps: Array<{ id: string }> }> };
      const longPhaseId = `phase-${"p".repeat(600)}`;
      const longCurrentStepId = `step-${"s".repeat(600)}`;
      const longOtherStepId = `step-${"t".repeat(600)}`;
      longPlan.phases[0]!.id = longPhaseId;
      longPlan.phases[0]!.steps[0]!.id = longCurrentStepId;
      longPlan.phases[0]!.steps[1]!.id = longOtherStepId;
      writeFileSync(jsonPath, `${JSON.stringify(longPlan, null, 2)}\n`);
      before = capture();
      const longIds = await readPacket(4096, longPhaseId);
      expect(longIds.text.length).toBeLessThanOrEqual(4096);
      expect(longIds.packet.checkpoint.current).toMatchObject({ phaseId: longPhaseId, stepId: longCurrentStepId });
      expect(longIds.packet.hashes.planHash).toMatch(/^[a-f0-9]{64}$/);
      expect(longIds.packet.safety.overflow).toBe(true);
      expect(longIds.packet.page.total).toBeGreaterThan(1);
      expect(longIds.packet.page.nextCursor).not.toBeNull();
      expect(longIds.packet.page.nextCursor!.length).toBeLessThan(512);
      const longCursor = JSON.parse(Buffer.from(longIds.packet.page.nextCursor!, "base64url").toString("utf8")) as { offset: number; phaseId: string; stateHash: string };
      expect(longCursor.offset).toBe(1);
      expect(longCursor.phaseId).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(longCursor.stateHash).toBe(longIds.packet.hashes.stateHash);
      if (longIds.packet.page.returned === 0) expect(longIds.packet.truncatedFields.some((field) => field.startsWith("page.items["))).toBe(true);
      expect(capture()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps doctor read-only and reports invalid primary documents without treating sidecars as plans", async () => {
    const root = mkdtempSync(join(tmpdir(), "workplan-doctor-"));
    try {
      await createFixture(root, "diagnostic");
      const directory = join(root, ".opencode", "workplan");
      writeFileSync(join(directory, "broken.json"), "{\"schemaVersion\":1}\n");
      writeFileSync(join(directory, "diagnostic.dependencies.json"), "{\"broken\":true}\n");
      const before = readdirSync(directory).sort().map((name) => {
        const path = join(directory, name);
        return { name, bytes: existsSync(path) && statSync(path).isFile() ? readFileSync(path) : null, mtime: statSync(path).mtimeMs };
      });
      const directoryMtime = statSync(directory).mtimeMs;
      const report = output<{ readOnly: boolean; plans: Array<{ id: string; valid: boolean }>; sidecars: Array<{ name: string }>; runtimeFacts: { permission: { status: string } } }>(await workplan_doctor.execute({ limit: 10 }, context(root) as never));
      expect(report.readOnly).toBe(true);
      expect(report.plans.some((plan) => plan.id === "broken" && !plan.valid)).toBe(true);
      expect(report.plans.some((plan) => plan.id === "diagnostic.dependencies")).toBe(false);
      expect(report.sidecars.some((sidecar) => sidecar.name === "diagnostic.dependencies.json")).toBe(true);
      expect(report.runtimeFacts.permission.status).toBe("unknown");
      const after = readdirSync(directory).sort().map((name) => {
        const path = join(directory, name);
        return { name, bytes: existsSync(path) && statSync(path).isFile() ? readFileSync(path) : null, mtime: statSync(path).mtimeMs };
      });
      expect(after).toEqual(before);
      expect(statSync(directory).mtimeMs).toBe(directoryMtime);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes cross-process create and move claims for one shared Markdown destination", async () => {
    const createRoot = mkdtempSync(join(tmpdir(), "workplan-create-race-"));
    const moveRoot = mkdtempSync(join(tmpdir(), "workplan-move-race-"));
    try {
      const createResults = await runSeparateContenders(createRoot, "create");
      expect(createResults.filter((result) => result === "WON")).toHaveLength(1);
      expect(createResults.filter((result) => result.startsWith("LOST:")).length).toBe(1);
      expect(existsSync(join(createRoot, ".opencode", "workplan", "shared.md"))).toBe(true);
      const createdPlans = ["a", "b"].filter((id) => existsSync(join(createRoot, ".opencode", "workplan", `${id}.json`)));
      expect(createdPlans).toHaveLength(1);

      await createFixture(moveRoot, "a");
      await createFixture(moveRoot, "b");
      const moveResults = await runSeparateContenders(moveRoot, "move");
      expect(moveResults.filter((result) => result === "WON")).toHaveLength(1);
      expect(moveResults.filter((result) => result.startsWith("LOST:")).length).toBe(1);
      const owners = ["a", "b"].filter((id) => (JSON.parse(readFileSync(join(moveRoot, ".opencode", "workplan", `${id}.json`), "utf8")) as { planFile: string }).planFile === ".opencode/workplan/shared-move.md");
      expect(owners).toHaveLength(1);
      expect(existsSync(join(moveRoot, ".opencode", "workplan", "shared-move.md"))).toBe(true);
    } finally {
      rmSync(createRoot, { recursive: true, force: true });
      rmSync(moveRoot, { recursive: true, force: true });
    }
  });

  it("times out on live or foreign locks, reclaims a positively dead owner, and never releases a replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "workplan-locks-"));
    try {
      await createFixture(root, "lock-test");
      const snapshot = await readWorkplanSnapshot(root, "lock-test");
      const lockPath = workspaceLockPath(snapshot.workspaceRoot);
      const stale = new Date(Date.now() - 10 * 60_000).toISOString();
      const writeAttempt = (lockWaitMs: number, fault?: (stage: string) => void) => commitWorkplanMutation({
        workspaceRoot: snapshot.workspaceRoot,
        id: snapshot.id,
        operation: "lock-safety-test",
        initialSnapshot: snapshot,
        expectedHash: snapshot.stateHash,
        targets: [{
          path: snapshot.path,
          content: `${JSON.stringify({ ...snapshot.document, goal: "Lock-checked update" }, null, 2)}\n`,
          before: Buffer.from(snapshot.raw),
          label: "Workplan file",
        }],
        lockWaitMs,
        invocation: context(root, { fault }) as never,
      });

      const liveLock = `${JSON.stringify({ hostname: hostname(), pid: process.pid, nonce: "live-lock", startedAt: stale })}\n`;
      writeFileSync(lockPath, liveLock, { mode: 0o600 });
      await expect(writeAttempt(25)).rejects.toThrow("Timed out waiting for workplan lock");
      expect(readFileSync(lockPath, "utf8")).toBe(liveLock);
      unlinkSync(lockPath);

      const deadLock = `${JSON.stringify({ hostname: hostname(), pid: 99_999_999, nonce: "dead-lock", startedAt: stale })}\n`;
      writeFileSync(lockPath, deadLock, { mode: 0o600 });
      await writeAttempt(500);
      expect(existsSync(lockPath)).toBe(false);
      const updatedSnapshot = await readWorkplanSnapshot(root, "lock-test");
      const foreignLock = `${JSON.stringify({ hostname: "foreign-host", pid: 99_999_999, nonce: "foreign-lock", startedAt: stale })}\n`;
      writeFileSync(lockPath, foreignLock, { mode: 0o600 });
      await expect(commitWorkplanMutation({
        workspaceRoot: updatedSnapshot.workspaceRoot,
        id: updatedSnapshot.id,
        operation: "foreign-lock-test",
        initialSnapshot: updatedSnapshot,
        targets: [{ path: updatedSnapshot.path, content: `${JSON.stringify({ ...updatedSnapshot.document, goal: "Blocked" }, null, 2)}\n`, before: Buffer.from(updatedSnapshot.raw) }],
        lockWaitMs: 25,
        invocation: context(root) as never,
      })).rejects.toThrow("Timed out waiting for workplan lock");
      expect(readFileSync(lockPath, "utf8")).toBe(foreignLock);
      unlinkSync(lockPath);

      const replacementLock = `${JSON.stringify({ hostname: hostname(), pid: process.pid, nonce: "replacement", startedAt: new Date().toISOString() })}\n`;
      const finalSnapshot = await readWorkplanSnapshot(root, "lock-test");
      await commitWorkplanMutation({
        workspaceRoot: finalSnapshot.workspaceRoot,
        id: finalSnapshot.id,
        operation: "replacement-release-test",
        initialSnapshot: finalSnapshot,
        targets: [{ path: finalSnapshot.path, content: `${JSON.stringify({ ...finalSnapshot.document, goal: "Release checked" }, null, 2)}\n`, before: Buffer.from(finalSnapshot.raw) }],
        invocation: context(root, { fault: (stage) => {
          if (stage !== "before-complete") return;
          unlinkSync(lockPath);
          writeFileSync(lockPath, replacementLock, { mode: 0o600 });
        } }) as never,
      });
      expect(readFileSync(lockPath, "utf8")).toBe(replacementLock);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps checkpoint v1 unverified, diagnoses corrupt checkpoints, and rejects altered preview tokens", async () => {
    const root = mkdtempSync(join(tmpdir(), "workplan-preview-token-"));
    try {
      await workplan_create.execute({
        id: "compact-token",
        kind: "test",
        goal: "Bound a compact operation",
        status: "in_progress",
        overwrite: false,
        phases: [
          { id: "finished", title: "Finished", status: "completed", steps: [{ id: "done", title: "Done", action: "Complete", validation: "Check", status: "completed" }] },
          { id: "active", title: "Active", status: "in_progress", steps: [{ id: "todo", title: "Todo", action: "Do", validation: "Check", status: "in_progress" }] },
        ],
        notes: ["first exact note", "second exact note"],
        reviewFindings: [{ severity: "minor", title: "Resolved", status: "resolved" }],
      }, context(root) as never);
      const markdownPath = join(root, ".opencode", "workplan", "compact-token.md");
      const handwrittenMarkdown = "Handwritten continuation details survive compaction.\n";
      writeFileSync(markdownPath, handwrittenMarkdown);
      const cpPath = join(root, ".opencode", "workplan", "compact-token.checkpoint.json");
      writeFileSync(cpPath, `${JSON.stringify({
        schemaVersion: 1,
        id: "compact-token",
        sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
        sourceHash: "a".repeat(64),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        status: "in_progress",
        summary: "Legacy checkpoint",
        current: null,
        nextAction: "Never trusted until refreshed",
        blockers: ["Old blocker"],
        recentValidation: [],
        guardrails: ["Keep the legacy guardrail"],
        references: ["old-reference"],
      }, null, 2)}\n`);
      const legacyBytes = readFileSync(cpPath, "utf8");
      const legacyResume = output<{ checkpoint: { fresh: boolean; nextAction: null }; safety: { unverifiedWarnings: string[] } }>(await workplan_resume.execute({ id: "compact-token" }, context(root) as never));
      expect(legacyResume.checkpoint.fresh).toBe(false);
      expect(legacyResume.checkpoint.nextAction).toBeNull();
      expect(legacyResume.safety.unverifiedWarnings.some((warning) => warning.includes("legacy guardrail"))).toBe(true);
      expect(readFileSync(cpPath, "utf8")).toBe(legacyBytes);

      writeFileSync(cpPath, "not-json\n");
      const corruptBytes = readFileSync(cpPath, "utf8");
      const corruptResume = output<{ checkpoint: { fresh: boolean; diagnostic: string | null } }>(await workplan_resume.execute({ id: "compact-token" }, context(root) as never));
      expect(corruptResume.checkpoint.fresh).toBe(false);
      expect(corruptResume.checkpoint.diagnostic).toContain("Invalid workplan checkpoint JSON");
      expect(readFileSync(cpPath, "utf8")).toBe(corruptBytes);

      rmSync(cpPath);
      await workplan_checkpoint.execute({ id: "compact-token", summary: "Current", nextAction: "Continue" }, context(root) as never);
      const jsonPath = join(root, ".opencode", "workplan", "compact-token.json");
      const beforeJson = readFileSync(jsonPath, "utf8");
      const beforeTimes = [statSync(jsonPath).mtimeMs, statSync(markdownPath).mtimeMs, statSync(cpPath).mtimeMs];
      const selection = { id: "compact-token", archiveReason: "Move exact historical entries", completedPhaseIds: ["finished"], noteIndexes: [0, 1], resolvedFindingIndexes: [0] };
      const preview = output<{ previewToken: string; stateHash: string }>(await workplan_compact.execute({ ...selection, mode: "preview" }, context(root) as never));
      expect([statSync(jsonPath).mtimeMs, statSync(markdownPath).mtimeMs, statSync(cpPath).mtimeMs]).toEqual(beforeTimes);
      await expect(workplan_compact.execute({
        ...selection,
        mode: "apply",
        archiveReason: "Changed after preview",
        previewToken: preview.previewToken,
        expectedHash: preview.stateHash,
        confirmation: "ARCHIVE_SELECTED_HISTORY",
      }, context(root) as never)).rejects.toThrow("previewToken does not match");
      await expect(workplan_compact.execute({
        ...selection,
        noteIndexes: [1, 0],
        mode: "apply",
        previewToken: preview.previewToken,
        expectedHash: preview.stateHash,
        confirmation: "ARCHIVE_SELECTED_HISTORY",
      }, context(root) as never)).rejects.toThrow("previewToken does not match");
      expect(readFileSync(jsonPath, "utf8")).toBe(beforeJson);
      expect(existsSync(join(root, ".opencode", "workplan", "archive"))).toBe(false);

      const beforeCycle = readFileSync(jsonPath, "utf8");
      await expect(workplan_update.execute({
        id: "compact-token",
        dependencies: [
          { phaseId: "active", stepId: "todo", dependsOn: [{ phaseId: "finished", stepId: "done" }] },
          { phaseId: "finished", stepId: "done", dependsOn: [{ phaseId: "active", stepId: "todo" }] },
        ],
      }, context(root) as never)).rejects.toThrow("Cycle detected");
      expect(readFileSync(jsonPath, "utf8")).toBe(beforeCycle);

      await workplan_update.execute({
        id: "compact-token",
        dependencies: [{ phaseId: "active", stepId: "todo", dependsOn: [{ phaseId: "finished", stepId: "done" }] }],
      }, context(root) as never);
      await workplan_checkpoint.execute({ id: "compact-token", summary: "Fresh before apply", nextAction: "Continue the active step" }, context(root) as never);
      const dependencyPreview = output<{ previewToken: string; stateHash: string; linkedMarkdownTreatment: string }>(await workplan_compact.execute({
        id: "compact-token", mode: "preview", archiveReason: "Archive completed prerequisite", completedPhaseIds: ["finished"],
      }, context(root) as never));
      expect(dependencyPreview.linkedMarkdownTreatment).toBe("preserved");
      const dependencyApply = output<{ compacted: boolean; archivePath: string }>(await workplan_compact.execute({
        id: "compact-token",
        mode: "apply",
        archiveReason: "Archive completed prerequisite",
        completedPhaseIds: ["finished"],
        previewToken: dependencyPreview.previewToken,
        expectedHash: dependencyPreview.stateHash,
        confirmation: "ARCHIVE_SELECTED_HISTORY",
      }, context(root) as never));
      expect(dependencyApply.compacted).toBe(true);
      expect(readFileSync(markdownPath, "utf8")).toBe(handwrittenMarkdown);
      const dependencySidecar = JSON.parse(readFileSync(join(root, ".opencode", "workplan", "compact-token.dependencies.json"), "utf8")) as {
        dependencies: Array<{ phaseId: string; stepId: string; dependsOn: Array<{ phaseId: string; stepId: string }> }>;
        terminalSummaries: Array<{ phaseId: string; stepId: string; title: string; status: string }>;
      };
      expect(dependencySidecar.dependencies[0]?.dependsOn).toEqual([{ phaseId: "finished", stepId: "done" }]);
      expect(dependencySidecar.terminalSummaries).toContainEqual({ phaseId: "finished", stepId: "done", title: "Done", status: "completed" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
