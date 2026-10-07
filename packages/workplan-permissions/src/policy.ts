export const GUARDED_TOOLS = [
  "workplan_create", "workplan_update", "workplan_patch", "workplan_reset",
  "workplan_checkpoint", "workplan_compact", "opencode_read_mcp_resource",
] as const;

export function assertWorkplanPermission(tool: string, input: unknown, agent: string): void {
  const args = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
  if (tool === "opencode_read_mcp_resource") {
    if (agent === "plan" && args.server !== "workplan") {
      throw new Error("The plan agent may only read MCP resources from the workplan server");
    }
    return;
  }
  if (["workplan_create", "workplan_update", "workplan_patch", "workplan_reset"].includes(tool)
      && agent !== "plan" && agent !== "orchestrator") {
    throw new Error("Only plan and orchestrator may author workplan lifecycle changes");
  }
  if (tool === "workplan_checkpoint" && agent !== "orchestrator") {
    throw new Error("Only orchestrator may update workplan checkpoints");
  }
  if (tool === "workplan_update" && args.recovery !== undefined && agent !== "orchestrator") {
    throw new Error("Only orchestrator may recover a workplan transaction");
  }
  if (tool === "workplan_compact" && args.mode === "apply" && agent !== "orchestrator") {
    throw new Error("Only orchestrator may apply workplan compaction");
  }
}
