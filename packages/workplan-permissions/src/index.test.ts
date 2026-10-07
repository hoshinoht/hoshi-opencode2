import { expect, it } from "bun:test";
import plugin from "./index";

it("blocks recovery before forwarding and preserves allowed calls and cleanup", async () => {
  const forwarded: unknown[] = [];
  const result = { content: "core response" };
  const tool = { execute: async (input: unknown, caller: unknown) => {
    forwarded.push({ input, caller });
    return result;
  } };
  let disposed = false;
  const cleanup = await plugin.setup({
    tool: { transform: async (transform: (editor: unknown) => void) => {
      transform({ list: () => [], update: (name: string, update: (tool: unknown) => void) => {
        if (name === "workplan_update") update(tool);
      } });
      return { dispose: async () => { disposed = true; } };
    } },
  } as never);
  const plan = { agent: "plan" };
  await expect(tool.execute({ recovery: "resume", agent: "orchestrator" }, plan)).rejects.toThrow("Only orchestrator");
  expect(forwarded).toEqual([]);
  const input = { appendNotes: ["progress"] };
  expect(await tool.execute(input, plan)).toBe(result);
  expect(forwarded).toEqual([{ input, caller: plan }]);
  expect(await tool.execute({ recovery: "resume" }, { agent: "orchestrator" })).toBe(result);
  expect(forwarded).toHaveLength(2);
  if (typeof cleanup !== "function") throw new Error("missing transform cleanup");
  await cleanup();
  expect(disposed).toBe(true);
});

it("keeps workplan tools searchable and pinned without changing other MCP tools", async () => {
  const workplan = { id: "workplan_read", options: { namespace: "workplan", permission: "workplan_read", codemode: false } as Record<string, unknown> };
  const other = { id: "context7_query_docs", options: { codemode: false } as Record<string, unknown> };
  const tools = [workplan, other];
  await plugin.setup({ tool: { transform: async (transform: (editor: unknown) => void) => {
    transform({ list: () => tools, update: (name: string, update: (tool: unknown) => void) => {
      const tool = tools.find((t) => t.id === name);
      if (tool) update(tool);
    } });
    return { dispose: async () => {} };
  } } } as never);
  expect(workplan.options).toEqual({ namespace: "workplan", permission: "workplan_read", codemode: true, pinned: true });
  expect(other.options).toEqual({ codemode: false });
});
