import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const root = new URL("../", import.meta.url);
const config = Bun.JSONC.parse(readFileSync(new URL("opencode.json", root), "utf8")) as {
  default_agent: string;
  plugins: unknown[];
};

function agent(name: string) {
  const markdown = readFileSync(new URL(`agents/${name}.md`, root), "utf8");
  return parse(markdown.split("---")[1]) as {
    mode: string;
    permissions: { action: string; resource: string; effect: string }[];
  };
}

describe("custom agents sharing built-in IDs", () => {
  it("disables the built-in plan reminder without disabling agent or policy loading", () => {
    expect(config.plugins).toContain("-opencode.plan");
    expect(config.plugins).not.toContain("opencode.plan");
    expect(config.plugins).not.toContain("-opencode.agent");
    expect(config.plugins).not.toContain("-opencode.config.agent");
    expect(config.plugins).not.toContain("-opencode.config.policy");
  });

  it("keeps plan restricted to repository planning artifacts", () => {
    const planner = agent("plan");
    expect(planner.mode).toBe("all");
    expect(planner.permissions).toEqual(expect.arrayContaining([
      { action: "*", resource: "*", effect: "deny" },
      { action: "edit", resource: "*/.opencode/workplan/*", effect: "allow" },
      { action: "edit", resource: ".opencode/workplan/*", effect: "allow" },
      { action: "edit", resource: "*/.opencode/docs/specs/*", effect: "allow" },
      { action: "edit", resource: "~/.opencode/plan/*", effect: "deny" },
    ]));
    expect(planner.permissions).not.toContainEqual({ action: "edit", resource: "*", effect: "allow" });
    expect(planner.permissions).not.toContainEqual({ action: "shell", resource: "*", effect: "allow" });
  });

  it("keeps build as the default coding agent with access to the custom plan agent", () => {
    expect(config.default_agent).toBe("build");
    expect(agent("build").permissions).toEqual(expect.arrayContaining([
      { action: "edit", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "allow" },
      { action: "subagent", resource: "plan", effect: "allow" },
    ]));
    expect(agent("orchestrator").permissions).toContainEqual({ action: "subagent", resource: "plan", effect: "allow" });
  });
});
