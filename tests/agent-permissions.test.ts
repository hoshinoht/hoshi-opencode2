import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { expand, generate, loadSource, renderAgent } from "../scripts/gen-agent-permissions";

describe("agent permission generator", () => {
  it("keeps agents/*.md in sync with scripts/agent-permissions.yaml", () => {
    expect(generate(true)).toEqual([]);
  });

  it("expands fragments in place, preserving last-match-wins order", () => {
    const source = {
      fragments: { a: [["read", "*", "allow"]], b: ["@a", ["read", "*.env", "ask"]] },
      agents: {},
    } as any;
    expect(expand(source, [["*", "*", "deny"], "@b"])).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "ask" },
    ]);
  });

  it("rejects unknown fragments, cycles, and bad effects", () => {
    const source = { fragments: { x: ["@y"], y: ["@x"] }, agents: {} } as any;
    expect(() => expand(source, ["@missing"])).toThrow("unknown fragment");
    expect(() => expand(source, ["@x"])).toThrow("cycle");
    expect(() => expand(source, [["read", "*", "maybe"]] as any)).toThrow("bad effect");
  });

  it("replaces only the permissions block of the frontmatter", () => {
    const md = "---\nmode: subagent\npermissions:\n  - action: old\n    resource: x\n    effect: deny\ncolor: red\n---\nbody\n";
    const out = renderAgent(md, [{ action: "read", resource: "*", effect: "allow" }]);
    expect(out).toContain("mode: subagent\npermissions:\n  - action: read");
    expect(out).not.toContain("action: old");
    expect(out).toContain("color: red\n---\nbody\n");
  });

  it("covers every agent file", () => {
    const files = readdirSync(new URL("../agents", import.meta.url)).filter((f) => f.endsWith(".md"));
    const defined = new Set(Object.keys(loadSource().agents));
    expect(files.map((f) => f.slice(0, -3)).filter((a) => !defined.has(a))).toEqual([]);
  });
});
