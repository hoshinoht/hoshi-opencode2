// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workplan_create } from "../../packages/workplan-tools/src/core/create";
import { workplan_inspect } from "../../packages/workplan-tools/src/core/inspect";
import { workplan_list } from "../../packages/workplan-tools/src/core/list";
import { workplan_patch } from "../../packages/workplan-tools/src/core/patch";
import { workplan_read } from "../../packages/workplan-tools/src/core/read";
import { workplan_reset } from "../../packages/workplan-tools/src/core/reset";
import { workplan_update } from "../../packages/workplan-tools/src/core/update";
import { workplan_validate } from "../../packages/workplan-tools/src/core/validate";

type AskInput = { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> };
type Executable = { execute(args: never, context: never): Promise<unknown> };

function ctx(directory: string, worktree = directory, asks: AskInput[] = [], onAsk?: (input: AskInput) => unknown) {
  return {
    directory,
    worktree,
    metadata() {},
    async ask(input: AskInput) {
      asks.push(input);
      await onAsk?.(input);
    },
  };
}

function run(tool: Executable, args: Record<string, unknown>, context: ReturnType<typeof ctx>): Promise<unknown> {
  return tool.execute(args as never, context as never);
}

async function runJson<T = any>(tool: Executable, args: Record<string, unknown>, context: ReturnType<typeof ctx>): Promise<T> {
  return JSON.parse(String(await run(tool, args, context))) as T;
}

async function withWorkspace(body: (ws: string) => Promise<void>): Promise<void> {
  const ws = await mkdtemp(join(tmpdir(), "workplan-core-"));
  try {
    await mkdir(join(ws, ".opencode"), { recursive: true });
    await body(ws);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

const ID = "demo-plan";
const basic = (extra: Record<string, unknown> = {}) => ({
  id: ID,
  kind: "general",
  goal: "Ship the new workplan flow",
  status: "draft",
  overwrite: false,
  ...extra,
});
const jsonPath = (ws: string) => join(ws, ".opencode/workplan/demo-plan.json");
const mdPath = (ws: string) => join(ws, ".opencode/workplan/demo-plan.md");
const stored = async (ws: string) => JSON.parse(await readFile(jsonPath(ws), "utf8"));
const markdown = (ws: string) => readFile(mdPath(ws), "utf8");

const anchorPhase = (step: Record<string, unknown> = {}) => [{
  id: "phase-anchor",
  title: "Anchor phase",
  steps: [{ id: "step-anchor", title: "Anchor step", action: "Old action", validation: "Check it", ...step }],
}];

function patchText(target: string, ...body: string[]): string {
  return ["*** Begin Patch", `*** Update File: ${target}`, ...body, "*** End Patch"].join("\n");
}

describe("workplan core: ids, storage, targeted updates", () => {
  it("1. surfaces readable generated ids through inspect", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic({ phases: [{ title: "Build", steps: [{ title: "Do it", action: "Write code", validation: "Run tests" }] }] }), ctx(ws));
      const result = await runJson(workplan_inspect, { id: ID }, ctx(ws));
      expect(result.plan.exists).toBe(true);
      expect(result.phases).toHaveLength(1);
      expect(result.steps).toHaveLength(1);
      expect(result.phases[0].id).toMatch(/^phase-[a-z0-9]+-[a-z0-9]+-\d{6}$/);
      expect(result.steps[0].id).toMatch(/^step-[a-z0-9]+-[a-z0-9]+-\d{6}$/);
      expect(result.phases[0].markdownMarker).toContain(result.phases[0].id);
      expect(result.steps[0].markdownMarker).toContain(result.steps[0].id);
      const md = await markdown(ws);
      expect(md).toContain(result.phases[0].markdownMarker);
      expect(md).toContain(result.steps[0].markdownMarker);
    });
  });

  it("2. stores plans at the worktree rather than the nested cwd", async () => {
    await withWorkspace(async (ws) => {
      const nested = join(ws, "packages/demo");
      await mkdir(nested, { recursive: true });
      await run(workplan_create, basic(), ctx(nested, ws));
      expect(await readFile(jsonPath(ws), "utf8")).toContain('"id": "demo-plan"');
      expect(existsSync(join(nested, ".opencode/workplan/demo-plan.json"))).toBe(false);
    });
  });

  it("3. applies a targeted step update while keeping ids", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic({ phases: [{ title: "Build", steps: [{ title: "Do it", action: "Write code", validation: "Run tests" }] }] }), ctx(ws));
      const inspected = await runJson(workplan_inspect, { id: ID }, ctx(ws));
      const phaseId = inspected.phases[0].id;
      const stepId = inspected.steps[0].id;
      await run(workplan_update, { id: ID, updateSteps: [{ phaseId, stepId, status: "completed", action: "Write code with targeted patches" }] }, ctx(ws));
      const doc = await stored(ws);
      expect(doc.phases[0].id).toBe(phaseId);
      expect(doc.phases[0].steps[0].id).toBe(stepId);
      expect(doc.phases[0].steps[0].status).toBe("completed");
      expect(doc.phases[0].steps[0].action).toBe("Write code with targeted patches");
    });
  });

  it("4. ignores placeholder values while applying meaningful fields", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic({
        title: "Demo Plan",
        status: "review",
        scope: ["In scope"],
        nonGoals: ["Not a goal"],
        constraints: ["A constraint"],
        phases: anchorPhase(),
      }), ctx(ws));
      await run(workplan_update, {
        id: ID,
        title: "  ",
        goal: "",
        planFile: " ",
        planMarkdown: "   ",
        status: "draft",
        scope: [],
        nonGoals: [],
        constraints: [],
        specFiles: [],
        reviewFindings: [],
        phases: [],
        updatePhases: [],
        addPhases: [],
        updateSteps: [],
        addSteps: [],
        addRelevantFiles: [],
        addSpecFiles: [],
        removeSpecFiles: [],
        addReviewFindings: [],
        appendNotes: ["Meaningful note"],
      }, ctx(ws));
      const doc = await stored(ws);
      expect(doc.title).toBe("Demo Plan");
      expect(doc.goal).toBe("Ship the new workplan flow");
      expect(doc.status).toBe("review");
      expect(doc.scope).toEqual(["In scope"]);
      expect(doc.nonGoals).toEqual(["Not a goal"]);
      expect(doc.constraints).toEqual(["A constraint"]);
      expect(doc.planFile).toBe(".opencode/workplan/demo-plan.md");
      expect(doc.phases.map((phase: { id: string }) => phase.id)).toEqual(["phase-anchor"]);
      expect(doc.phases[0].steps[0].action).toBe("Old action");
      expect(doc.notes).toEqual(["Meaningful note"]);
      const md = await markdown(ws);
      expect(md).toContain("Meaningful note");
      expect(md).toContain("Overall status: review");
    });
  });

  it("5. ignores blank nested patch fields", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic({
        status: "review",
        phases: [{
          id: "phase-anchor",
          title: "Anchor phase",
          status: "review",
          steps: [{ id: "step-anchor", title: "Anchor step", target: "src/a.ts", action: "Old action", validation: "Check it", status: "review" }],
        }],
      }), ctx(ws));
      await run(workplan_update, {
        id: ID,
        title: "",
        status: "draft",
        scope: [],
        updateSteps: [{ phaseId: "phase-anchor", stepId: "step-anchor", title: "", target: "", action: "New action", validation: "", status: "draft" }],
      }, ctx(ws));
      const doc = await stored(ws);
      expect(doc.status).toBe("review");
      expect(doc.phases).toHaveLength(1);
      expect(doc.phases[0].id).toBe("phase-anchor");
      expect(doc.phases[0].status).toBe("review");
      expect(doc.phases[0].steps[0]).toMatchObject({
        title: "Anchor step",
        target: "src/a.ts",
        action: "New action",
        validation: "Check it",
        status: "review",
      });
    });
  });

  it("6. keeps request order for repeated after-anchor inserts", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic({ phases: anchorPhase() }), ctx(ws));
      await run(workplan_update, {
        id: ID,
        addPhases: [
          { afterPhaseId: "phase-anchor", phase: { id: "phase-b", title: "B" } },
          { afterPhaseId: "phase-anchor", phase: { id: "phase-c", title: "C" } },
        ],
        addSteps: [
          { phaseId: "phase-anchor", afterStepId: "step-anchor", step: { id: "step-b", title: "B" } },
          { phaseId: "phase-anchor", afterStepId: "step-anchor", step: { id: "step-c", title: "C" } },
        ],
      }, ctx(ws));
      const doc = await stored(ws);
      expect(doc.phases.map((phase: { id: string }) => phase.id)).toEqual(["phase-anchor", "phase-b", "phase-c"]);
      expect(doc.phases[0].steps.map((step: { id: string }) => step.id)).toEqual(["step-anchor", "step-b", "step-c"]);
    });
  });
});

describe("workplan core: plan-file moves and policy", () => {
  it("7. regenerates generated Markdown when moving the plan link", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic({ phases: anchorPhase() }), ctx(ws));
      await run(workplan_update, {
        id: ID,
        planFile: ".opencode/workplan/demo-plan-next.md",
        updateSteps: [{ phaseId: "phase-anchor", stepId: "step-anchor", action: "New action" }],
      }, ctx(ws));
      const next = await readFile(join(ws, ".opencode/workplan/demo-plan-next.md"), "utf8");
      expect(next).toContain("New action");
      expect(next).toContain("demo-plan-next.md");
      expect(next).not.toContain("Old action");
    });
  });

  it("8. rejects a plan file outside .opencode/workplan", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic(), ctx(ws));
      await expect(run(workplan_update, { id: ID, planFile: "README.md" }, ctx(ws))).rejects.toThrow(
        "Plan file must stay under .opencode/workplan/",
      );
    });
  });
});

describe("workplan core: patch", () => {
  it("9. edits only the Markdown and asks for edit permission", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic(), ctx(ws));
      const jsonBefore = await readFile(jsonPath(ws));
      const asks: AskInput[] = [];
      await run(workplan_patch, {
        id: ID,
        patchText: patchText(
          ".opencode/workplan/demo-plan.md",
          "@@",
          "-Ship the new workplan flow",
          "+Ship the new workplan flow with a Markdown-only note",
        ),
      }, ctx(ws, ws, asks));
      expect(await markdown(ws)).toContain("Ship the new workplan flow with a Markdown-only note");
      expect((await readFile(jsonPath(ws))).equals(jsonBefore)).toBe(true);
      expect(asks.some((ask) => ask.permission === "edit" && ask.patterns.includes(".opencode/workplan/demo-plan.md"))).toBe(true);
    });
  });

  it("10. prompts for an external workspaceRoot before reading it", async () => {
    const caller = await mkdtemp(join(tmpdir(), "workplan-caller-"));
    const external = await mkdtemp(join(tmpdir(), "workplan-external-"));
    try {
      const asks: AskInput[] = [];
      const onAsk = async (input: AskInput) => {
        if (input.permission !== "external_directory") return;
        await mkdir(join(external, ".opencode/workplan"), { recursive: true });
        await writeFile(join(external, ".opencode/workplan/demo-plan.json"), `${JSON.stringify({
          schemaVersion: 2,
          id: ID,
          kind: "general",
          title: null,
          goal: "External",
          scope: [],
          nonGoals: [],
          constraints: [],
          relevantFiles: [],
          planFile: ".opencode/workplan/demo-plan.md",
          phases: [],
          reviewFindings: [],
          notes: [],
          status: "draft",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }, null, 2)}\n`);
        await writeFile(join(external, ".opencode/workplan/demo-plan.md"), "Original external plan\n");
      };
      await run(workplan_patch, {
        workspaceRoot: external,
        id: ID,
        patchText: patchText(".opencode/workplan/demo-plan.md", "@@", "-Original external plan", "+Patched external plan"),
      }, ctx(caller, caller, asks, onAsk));
      const realExternal = (await realpath(external)).replaceAll("\\", "/");
      expect(asks[0]!.permission).toBe("external_directory");
      expect(asks[0]!.patterns).toEqual([`${realExternal}/**`]);
      expect(asks.some((ask) => ask.permission === "edit" && ask.patterns.includes(`${realExternal}/.opencode/workplan/demo-plan.md`))).toBe(true);
      expect(await readFile(join(external, ".opencode/workplan/demo-plan.md"), "utf8")).toBe("Patched external plan\n");
    } finally {
      await rm(caller, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  it("11. rejects a patch aimed at a file other than the linked plan", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic(), ctx(ws));
      await expect(run(workplan_patch, {
        id: ID,
        patchText: patchText("README.md", "@@", "-Ship the new workplan flow", "+Other"),
      }, ctx(ws))).rejects.toThrow("Patch target must match linked planFile");
    });
  });

  it("12. rejects unsupported patch operations", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic(), ctx(ws));
      const target = ".opencode/workplan/demo-plan.md";
      const cases: Array<[string, string]> = [
        [["*** Begin Patch", "*** Add File: new.md", "+hello", "*** End Patch"].join("\n"), "Add File"],
        [["*** Begin Patch", "*** Delete File: old.md", "*** End Patch"].join("\n"), "Delete File"],
        [["*** Begin Patch", `*** Update File: ${target}`, "*** Move to: .opencode/workplan/other.md", "@@", "-a", "+b", "*** End Patch"].join("\n"), "Move to"],
        [["*** Begin Patch", `*** Update File: ${target}`, "@@", "-a", "+b", `*** Update File: ${target}`, "@@", "-c", "+d", "*** End Patch"].join("\n"), "exactly one Update File"],
      ];
      for (const [text, message] of cases) {
        await expect(run(workplan_patch, { id: ID, patchText: text }, ctx(ws))).rejects.toThrow(message);
      }
    });
  });

  it("13. rejects no-op and mismatched hunks", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic(), ctx(ws));
      const target = ".opencode/workplan/demo-plan.md";
      await expect(run(workplan_patch, { id: ID, patchText: patchText(target, "@@", " Ship the new workplan flow") }, ctx(ws)))
        .rejects.toThrow("no additions or removals");
      await expect(run(workplan_patch, { id: ID, patchText: patchText(target, "@@", "-This line does not exist", "+Replacement") }, ctx(ws)))
        .rejects.toThrow("Failed to find expected lines");
    });
  });
});

describe("workplan core: symlink safety", () => {
  it("14. rejects symlinked Markdown and JSON", async () => {
    await withWorkspace(async (ws) => {
      const outside = await mkdtemp(join(tmpdir(), "workplan-outside-"));
      try {
        await run(workplan_create, basic(), ctx(ws));
        const originalMd = await markdown(ws);
        await writeFile(join(outside, "plan.md"), originalMd);
        await rm(mdPath(ws));
        await symlink(join(outside, "plan.md"), mdPath(ws));
        await expect(run(workplan_update, { id: ID, appendNotes: ["x"] }, ctx(ws))).rejects.toThrow("Plan file must not be a symlink");

        await rm(mdPath(ws));
        await writeFile(mdPath(ws), originalMd);
        await writeFile(join(outside, "plan.json"), await readFile(jsonPath(ws)));
        await rm(jsonPath(ws));
        await symlink(join(outside, "plan.json"), jsonPath(ws));
        await expect(run(workplan_read, { id: ID }, ctx(ws))).rejects.toThrow("Workplan file must not be a symlink");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("15. list rejects a symlinked workplan directory", async () => {
    await withWorkspace(async (ws) => {
      const outside = await mkdtemp(join(tmpdir(), "workplan-outside-"));
      try {
        await writeFile(join(outside, "outside.json"), "{}");
        await symlink(outside, join(ws, ".opencode/workplan"));
        await expect(run(workplan_list, {}, ctx(ws))).rejects.toThrow("Workplan directory must not be a symlink");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("16. list rejects a symlinked plan file", async () => {
    await withWorkspace(async (ws) => {
      const outside = await mkdtemp(join(tmpdir(), "workplan-outside-"));
      try {
        await mkdir(join(ws, ".opencode/workplan"), { recursive: true });
        await writeFile(join(outside, "evil.json"), "{}");
        await symlink(join(outside, "evil.json"), join(ws, ".opencode/workplan/evil.json"));
        await expect(run(workplan_list, {}, ctx(ws))).rejects.toThrow("Workplan file must not be a symlink");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});

describe("workplan core: spec files and findings", () => {
  it("17. normalises removeSpecFiles before filtering", async () => {
    await withWorkspace(async (ws) => {
      await mkdir(join(ws, "docs"), { recursive: true });
      await writeFile(join(ws, "docs/spec.md"), "# Spec\n");
      await run(workplan_create, basic({ specFiles: ["docs/spec.md"] }), ctx(ws));
      const doc = await stored(ws);
      doc.specFiles = ["./docs/spec.md"];
      await writeFile(jsonPath(ws), `${JSON.stringify(doc, null, 2)}\n`);
      await run(workplan_update, { id: ID, removeSpecFiles: ["./docs/spec.md"] }, ctx(ws));
      expect((await stored(ws)).specFiles).toEqual([]);
    });
  });

  it("18. de-duplicates spec files after normalisation", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic({ specFiles: ["docs/spec.md", "./docs/spec.md"] }), ctx(ws));
      expect((await stored(ws)).specFiles).toEqual(["docs/spec.md"]);
    });
  });

  it("19. resolves a finding by replacing the findings list", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic({ status: "review", reviewFindings: [{ severity: "major", title: "Fix ordering", status: "open" }] }), ctx(ws));
      await run(workplan_update, { id: ID, reviewFindings: [{ severity: "major", title: "Fix ordering", status: "resolved" }] }, ctx(ws));
      expect((await stored(ws)).reviewFindings).toEqual([{ severity: "major", title: "Fix ordering", status: "resolved" }]);
    });
  });

  it("20. blocks targeted operations on duplicate legacy ids", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic({
        phases: [{
          id: "phase-anchor",
          title: "Anchor phase",
          steps: [
            { id: "step-dup", title: "One", action: "A", validation: "V" },
            { id: "step-two", title: "Two", action: "B", validation: "V" },
          ],
        }],
      }), ctx(ws));
      const doc = await stored(ws);
      doc.phases[0].steps[1].id = "step-dup";
      await writeFile(jsonPath(ws), `${JSON.stringify(doc, null, 2)}\n`);
      await expect(run(workplan_update, { id: ID, updateSteps: [{ phaseId: "phase-anchor", stepId: "step-dup", action: "C" }] }, ctx(ws)))
        .rejects.toThrow("duplicate step id");
      await expect(run(workplan_inspect, { id: ID }, ctx(ws))).rejects.toThrow("duplicate step id");
    });
  });
});

describe("workplan core: reset", () => {
  it("21. draft reset clears execution state and regenerates Markdown", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic({
        status: "review",
        relevantFiles: ["src/app.ts"],
        specFiles: ["docs/spec.md"],
        phases: anchorPhase(),
        reviewFindings: [{ severity: "minor", title: "Nit" }],
        notes: ["A note"],
      }), ctx(ws));
      await run(workplan_reset, { id: ID, mode: "draft", preserveNotes: false }, ctx(ws));
      const doc = await stored(ws);
      expect(doc.status).toBe("draft");
      expect(doc.phases).toEqual([]);
      expect(doc.reviewFindings).toEqual([]);
      expect(doc.notes).toEqual([]);
      expect(doc.relevantFiles).toEqual(["src/app.ts"]);
      expect(doc.specFiles).toEqual(["docs/spec.md"]);
      const md = await markdown(ws);
      expect(md).toContain("_No phases defined yet._");
      expect(md).toContain("Overall status: draft");
    });
  });

  it("22. markdown-only reset leaves the JSON alone", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic({ status: "review", phases: anchorPhase() }), ctx(ws));
      await writeFile(mdPath(ws), "stale markdown\n");
      await run(workplan_reset, { id: ID, mode: "markdown-only", preserveNotes: false, replaceMarkdown: true }, ctx(ws));
      const doc = await stored(ws);
      expect(doc.status).toBe("review");
      expect(doc.phases.map((phase: { id: string }) => phase.id)).toEqual(["phase-anchor"]);
      const md = await markdown(ws);
      expect(md).toContain("workplan-phase-id");
      expect(md).toContain("Overall status: review");
      expect(md).not.toContain("stale markdown");
    });
  });
});

describe("workplan core: recommended guards", () => {
  it("23. renders the exact Markdown format", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic({
        title: "Demo Plan",
        scope: ["Scope item"],
        nonGoals: ["Non-goal item"],
        constraints: ["Constraint item"],
        relevantFiles: ["src/app.ts"],
        phases: [{
          id: "phase-one",
          title: "Phase one",
          steps: [{ id: "step-one", title: "Step one", target: "src/app.ts", action: "Do it", validation: "Check it" }],
        }],
        reviewFindings: [{ severity: "major", title: "Fix ordering", detail: "why", source: "a.ts:3" }],
        notes: ["A note"],
      }), ctx(ws));
      const expected = [
        "# Demo Plan",
        "",
        "## Goal",
        "Ship the new workplan flow",
        "",
        "## Scope",
        "- Scope item",
        "",
        "## Non-goals",
        "- Non-goal item",
        "",
        "## Constraints",
        "- Constraint item",
        "",
        "## Relevant files",
        "- src/app.ts",
        "",
        "## Spec files",
        "_None_",
        "",
        "## Execution phases",
        "### 1. Phase one <!-- workplan-phase-id: phase-one -->",
        "- Status: draft",
        "- Id: phase-one",
        "#### 1.1 Step one <!-- workplan-step-id: step-one -->",
        "- Status: draft",
        "- Id: step-one",
        "- Target: src/app.ts",
        "- Action: Do it",
        "- Validation: Check it",
        "",
        "## Adversarial review findings",
        "- [major] Fix ordering(open)— why [source: a.ts:3]",
        "",
        "## Notes",
        "- A note",
        "",
        "## Status",
        "- Overall status: draft",
        "- Metadata file: .opencode/workplan/demo-plan.json",
        "- Detailed plan file: .opencode/workplan/demo-plan.md",
        "",
      ].join("\n");
      expect(await markdown(ws)).toBe(expected);
    });
  });

  it("24. guards create conflicts", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic(), ctx(ws));
      await expect(run(workplan_create, basic(), ctx(ws))).rejects.toThrow("Workplan already exists");
      await expect(run(workplan_create, basic({ id: "missing-plan", overwrite: true }), ctx(ws)))
        .rejects.toThrow("overwrite requires the current stateHash");
      await expect(run(workplan_create, basic({ id: "missing-plan", overwrite: true, expectedHash: "a".repeat(64) }), ctx(ws)))
        .rejects.toThrow("Cannot overwrite missing workplan");
      await writeFile(join(ws, ".opencode/workplan/md-only.md"), "# Existing\n");
      await expect(run(workplan_create, basic({ id: "md-only" }), ctx(ws))).rejects.toThrow("Plan file already exists");
    });
  });

  it("25. protects handwritten Markdown", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic(), ctx(ws));
      await writeFile(mdPath(ws), "# Handwritten plan\n\nCustom text.\n");
      const handwritten = await readFile(mdPath(ws));
      await expect(run(workplan_update, { id: ID, planMarkdown: "x" }, ctx(ws)))
        .rejects.toThrow("Refusing to replace handwritten Markdown; pass replaceMarkdown=true for an explicit full replacement");
      await run(workplan_update, { id: ID, appendNotes: ["n"] }, ctx(ws));
      expect((await readFile(mdPath(ws))).equals(handwritten)).toBe(true);
      expect((await stored(ws)).notes).toEqual(["n"]);
      const reset = run(workplan_reset, { id: ID, mode: "markdown-only" }, ctx(ws));
      await expect(reset).rejects.toThrow("Refusing to replace handwritten Markdown; pass replaceMarkdown=true for an explicit replacement");
    });
  });

  it("26. patches with an anchor and a pure insertion", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic(), ctx(ws));
      await run(workplan_patch, {
        id: ID,
        patchText: patchText(".opencode/workplan/demo-plan.md", "@@ ## Notes", "+- extra one", "+- extra two"),
      }, ctx(ws));
      const md = await markdown(ws);
      expect(md).toContain("## Notes\n- extra one\n- extra two\n_None_\n");
      expect(md.endsWith("\n")).toBe(true);
      expect(md.endsWith("\n\n")).toBe(false);
    });
  });

  it("27. pages inspect output with checked cursors", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic({
        phases: [{
          id: "phase-one",
          title: "Phase one",
          steps: [1, 2, 3, 4, 5].map((n) => ({ id: `step-${n}`, title: `Step ${n}`, action: "Do", validation: "Check" })),
        }],
      }), ctx(ws));
      const first = await runJson(workplan_inspect, { id: ID, limit: 4 }, ctx(ws));
      expect(first.pagination.returned).toBe(4);
      expect(first.pagination.omitted).toBe(2);
      expect(first.pagination.total).toBe(6);
      expect(first.pagination.nextCursor).not.toBeNull();
      const second = await runJson(workplan_inspect, { id: ID, limit: 4, cursor: first.pagination.nextCursor }, ctx(ws));
      expect(second.pagination.returned).toBe(2);
      expect(second.phases.length + second.steps.length).toBe(2);
      expect(second.steps.map((step: { id: string }) => step.id)).toEqual(["step-4", "step-5"]);
      expect(second.pagination.nextCursor).toBeNull();
      await expect(run(workplan_inspect, { id: ID, limit: 3, cursor: first.pagination.nextCursor }, ctx(ws)))
        .rejects.toThrow("Stale or option-mismatched");
      const decoded = JSON.parse(Buffer.from(first.pagination.nextCursor, "base64url").toString("utf8"));
      const tampered = Buffer.from(JSON.stringify({ ...decoded, offset: 1 })).toString("base64url");
      await expect(run(workplan_inspect, { id: ID, limit: 4, cursor: tampered }, ctx(ws)))
        .rejects.toThrow("Invalid workplan inspect cursor");
    });
  });

  it("28. reports list and validate outputs", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic({
        phases: [{ id: "phase-one", title: "Phase one", steps: [{ id: "step-one", title: "Step", action: "Do", validation: "Check" }] }],
      }), ctx(ws));
      await writeFile(join(ws, ".opencode/workplan/Bad Name.json"), "{}");
      await writeFile(join(ws, ".opencode/workplan/demo-plan.checkpoint.json"), "{}");

      const listed = await runJson(workplan_list, {}, ctx(ws));
      expect(listed.count).toBe(2);
      const ids = listed.workplans.map((plan: { id: string }) => plan.id);
      expect(ids).toEqual([...ids].sort((a: string, b: string) => a.localeCompare(b)));
      const bad = listed.workplans.find((plan: { id: string }) => plan.id === "Bad Name");
      expect(bad.valid).toBe(false);
      expect(typeof bad.issue).toBe("string");
      expect(listed.sidecars).toContainEqual({ name: "demo-plan.checkpoint.json", kind: "checkpoint" });

      const valid = await runJson(workplan_validate, { id: ID }, ctx(ws));
      expect(valid).toMatchObject({ valid: true, issueCount: 0, planFresh: true, dependenciesRecorded: false });

      await rm(mdPath(ws));
      const invalid = await runJson(workplan_validate, { id: ID }, ctx(ws));
      expect(invalid.valid).toBe(false);
      expect(invalid.issues).toContain("planFile: Linked Markdown is missing or empty: .opencode/workplan/demo-plan.md");
    });
  });

  it("29. rejects recovery combined with ordinary update fields at parse time", async () => {
    await withWorkspace(async (ws) => {
      await run(workplan_create, basic(), ctx(ws));
      await expect(run(workplan_update, { id: ID, recovery: "resume", title: "x" }, ctx(ws)))
        .rejects.toThrow("recovery is mutually exclusive with ordinary update fields");
    });
  });
});
