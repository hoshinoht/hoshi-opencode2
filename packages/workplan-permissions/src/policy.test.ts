import { describe, expect, it } from "bun:test";
import { assertWorkplanPermission } from "./policy";

describe("Shiori MCP role boundaries", () => {
  it("lets plan author a plan while reserving recovery for orchestrator", () => {
    expect(() => assertWorkplanPermission("workplan_update", { appendNotes: ["progress"] }, "plan")).not.toThrow();
    for (const recovery of ["resume", "rollback"]) {
      expect(() => assertWorkplanPermission("workplan_update", { recovery, agent: "orchestrator" }, "plan")).toThrow("Only orchestrator");
      expect(() => assertWorkplanPermission("workplan_update", { recovery }, "orchestrator")).not.toThrow();
    }
  });

  it("blocks worker authoring even when the model supplies a privileged identity", () => {
    for (const agent of ["build", "document-writer", "scholar", "code-engineer", ""]) {
      for (const tool of ["workplan_create", "workplan_update", "workplan_patch", "workplan_reset"]) {
        expect(() => assertWorkplanPermission(tool, { agent: "orchestrator" }, agent)).toThrow("Only plan and orchestrator");
      }
      expect(() => assertWorkplanPermission("workplan_checkpoint", {}, agent)).toThrow("Only orchestrator");
      expect(() => assertWorkplanPermission("workplan_compact", { mode: "apply" }, agent)).toThrow("Only orchestrator");
    }
  });

  it("permits compaction previews and keeps apply and checkpoint ownership", () => {
    expect(() => assertWorkplanPermission("workplan_compact", { mode: "preview" }, "plan")).not.toThrow();
    expect(() => assertWorkplanPermission("workplan_compact", {}, "plan")).not.toThrow();
    expect(() => assertWorkplanPermission("workplan_compact", { mode: "apply" }, "plan")).toThrow("Only orchestrator");
    expect(() => assertWorkplanPermission("workplan_checkpoint", {}, "plan")).toThrow("Only orchestrator");
    expect(() => assertWorkplanPermission("workplan_compact", { mode: "apply" }, "orchestrator")).not.toThrow();
    expect(() => assertWorkplanPermission("workplan_checkpoint", {}, "orchestrator")).not.toThrow();
  });

  it("limits the plan agent's new resource grant to the workplan server", () => {
    expect(() => assertWorkplanPermission("opencode_read_mcp_resource", { server: "workplan", uri: "workplan://demo/report" }, "plan")).not.toThrow();
    for (const server of ["context7", "researcher-mcp", undefined]) {
      expect(() => assertWorkplanPermission("opencode_read_mcp_resource", { server }, "plan")).toThrow("workplan server");
    }
    expect(() => assertWorkplanPermission("opencode_read_mcp_resource", { server: "context7" }, "orchestrator")).not.toThrow();
  });
});
