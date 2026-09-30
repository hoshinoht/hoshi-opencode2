import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import workplanTools from "../../packages/workplan-tools";
import { readWorkplanSnapshot } from "../../packages/workplan-tools/src/core";

type RegisteredTool = {
  name: string;
  input: { required?: string[]; properties?: Record<string, unknown> };
  options?: { codemode?: boolean };
  execute(input: unknown, context?: unknown): Promise<{ content?: string }>;
};

function seedPlan(root: string): { jsonPath: string; markdownPath: string } {
  const directory = join(root, ".opencode", "workplan");
  mkdirSync(directory, { recursive: true });
  const now = new Date().toISOString();
  const document = {
    schemaVersion: 2,
    id: "native-demo",
    kind: "software-engineering",
    title: "Native demo",
    goal: "Complete the current task",
    scope: [],
    nonGoals: [],
    constraints: [],
    relevantFiles: [],
    planFile: ".opencode/workplan/native-demo.md",
    specFiles: [],
    phases: [{
      id: "active",
      title: "Implementation",
      status: "in_progress",
      steps: [{ id: "next", title: "Do next thing", action: "Make the fix", validation: "Run the focused test", status: "in_progress" }],
    }],
    reviewFindings: [],
    notes: ["historical-note-must-not-be-returned"],
    status: "in_progress",
    createdAt: now,
    updatedAt: now,
  };
  const jsonPath = join(directory, "native-demo.json");
  const markdownPath = join(directory, "native-demo.md");
  writeFileSync(jsonPath, `${JSON.stringify(document, null, 2)}\n`);
  writeFileSync(markdownPath, "# Native demo\n\nA disposable native adapter fixture.\n");
  return { jsonPath, markdownPath };
}

function nativeToolContext(agent: string, signal: AbortSignal | undefined = new AbortController().signal) {
  return {
    sessionID: "ses_native_plugin_test",
    agent,
    messageID: "msg_native_plugin_test",
    id: "call_native_plugin_test",
    signal,
    async progress() {},
  };
}

describe("native OpenCode 2 workplan plugin", () => {
  it("registers the complete schema-derived catalog and keeps preview/read paths pure", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "workplan-native-plugin-")));
    const { jsonPath, markdownPath } = seedPlan(root);
    const beforeJson = readFileSync(jsonPath);
    const beforeMarkdown = readFileSync(markdownPath);
    const beforeFiles = readdirSync(join(root, ".opencode", "workplan")).sort();
    const registered: RegisteredTool[] = [];
    let cleanup: (() => Promise<void>) | undefined;
    try {
      const setupResult = await workplanTools.setup({
        location: { project: { directory: root } },
        rpc: {
          async register() {
            return { events: { async emit() {} }, async dispose() {} };
          },
        },
        tool: {
          async list() {
            return registered.map((tool) => ({ id: tool.name }));
          },
          async transform(edit: (editor: { add(tool: unknown): void }) => void) {
            edit({ add(tool) { registered.push(tool as RegisteredTool); } });
            return { async dispose() {} };
          },
        },
        plugin: {
          async list() {
            return {
              location: { directory: root },
              data: [{ id: "workplan-tools", source: { type: "local", path: "workplan-tools" }, features: { rpc: true }, state: { status: "active" } }],
            };
          },
        },
        agent: {
          async get() {
            return { location: { directory: root }, data: { permissions: [] } };
          },
        },
        session: {
          async get({ sessionID }: { sessionID: string }) {
            return { id: sessionID, location: { directory: root }, permissions: [] };
          },
        },
      } as never);
      if (typeof setupResult === "function") cleanup = async () => { await setupResult(); };

      expect(registered.map((tool) => tool.name).sort()).toEqual([
        "workplan_checkpoint",
        "workplan_compact",
        "workplan_compact_preview",
        "workplan_create",
        "workplan_doctor",
        "workplan_inspect",
        "workplan_list",
        "workplan_patch",
        "workplan_read",
        "workplan_reset",
        "workplan_resume",
        "workplan_update",
        "workplan_validate",
      ]);
      expect(registered.every((tool) => tool.options?.codemode === true)).toBe(true);
      expect(registered.every((tool) => !("permission" in (tool.options ?? {})))).toBe(true);
      for (const tool of registered) expect(tool.input.properties?.workspaceRoot).toBeUndefined();

      const createTool = registered.find((tool) => tool.name === "workplan_create")!;
      const checkpointTool = registered.find((tool) => tool.name === "workplan_checkpoint")!;
      const compactTool = registered.find((tool) => tool.name === "workplan_compact")!;
      const compactPreview = registered.find((tool) => tool.name === "workplan_compact_preview")!;
      const updateTool = registered.find((tool) => tool.name === "workplan_update")!;
      const resumeTool = registered.find((tool) => tool.name === "workplan_resume")!;
      const readTool = registered.find((tool) => tool.name === "workplan_read")!;
      const validateTool = registered.find((tool) => tool.name === "workplan_validate")!;
      const doctorTool = registered.find((tool) => tool.name === "workplan_doctor")!;
      expect(checkpointTool.input.required).toContain("nextAction");
      expect(compactTool.input.properties?.confirmation).toBeDefined();
      expect(compactPreview.input.properties?.mode).toBeUndefined();

      await expect(createTool.execute({}, nativeToolContext("build"))).rejects.toThrow(/plan agent or orchestrator/i);
      await expect(checkpointTool.execute({}, nativeToolContext("plan"))).rejects.toThrow(/Only the orchestrator/i);
      await expect(updateTool.execute({ id: "native-demo", recovery: "resume" }, nativeToolContext("plan")))
        .rejects.toThrow(/Only the orchestrator may recover/i);
      await expect(compactTool.execute({ id: "native-demo", mode: "apply" }, nativeToolContext("plan")))
        .rejects.toThrow(/Only the orchestrator may apply/i);
      await expect(compactPreview.execute({ id: "native-demo", archiveReason: "Preview only", mode: "apply" }, nativeToolContext("plan")))
        .rejects.toThrow(/compact_preview input/i);

      await expect(updateTool.execute({ id: "native-demo", appendNotes: ["missing hash"] }, nativeToolContext("orchestrator")))
        .rejects.toThrow(/expectedHash/i);
      const snapshot = await readWorkplanSnapshot(root, "native-demo");
      expect(snapshot.stateHash).toMatch(/^[a-f0-9]{64}$/);

      const read = await readTool.execute({ id: "native-demo", includeMarkdown: false }, nativeToolContext("tester"));
      expect(JSON.parse(read.content!).workplan.id).toBe("native-demo");
      const resumed = JSON.parse((await resumeTool.execute({ id: "native-demo" }, nativeToolContext("tester"))).content!);
      expect(resumed.currentDependencies).toBeDefined();
      expect(resumed.page).toBeDefined();
      expect(resumed.checkpoint.current.stepTitle).toBe("Do next thing");
      expect(JSON.stringify(resumed)).not.toContain("historical-note-must-not-be-returned");
      expect(JSON.parse((await validateTool.execute({ id: "native-demo" }, nativeToolContext("tester"))).content!).valid).toBe(true);

      const preview = await compactPreview.execute({ id: "native-demo", archiveReason: "Preview only" }, nativeToolContext("tester"));
      expect(JSON.parse(preview.content!).mode).toBe("preview");
      const doctor = JSON.parse((await doctorTool.execute({}, nativeToolContext("tester"))).content!);
      expect(doctor.readOnly).toBe(true);
      expect(doctor.runtimeFacts.permission.status).toBe("unknown");
      expect(doctor.runtimeFacts.registrations.effective).toContain("workplan_compact_preview");
      expect(doctor.runtimeFacts.plugin).toMatchObject({ configured: true, effective: true, canonicalLocation: root });
      expect(doctor.runtimeFacts.builtinPlan.configured).toBeNull();
      expect(readFileSync(jsonPath)).toEqual(beforeJson);
      expect(readFileSync(markdownPath)).toEqual(beforeMarkdown);
      expect(readdirSync(join(root, ".opencode", "workplan")).sort()).toEqual(beforeFiles);

      const missingSignalContext = { ...nativeToolContext("plan"), signal: undefined as never };
      await expect(createTool.execute({
        id: "denied-native-create",
        kind: "general",
        goal: "Must not publish without the invocation signal",
        overwrite: false,
      }, missingSignalContext)).rejects.toThrow(/AbortSignal/i);
      expect(existsSync(join(root, ".opencode", "workplan", "denied-native-create.json"))).toBe(false);
    } finally {
      await cleanup?.();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
