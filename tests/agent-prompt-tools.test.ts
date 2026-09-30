import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { expand, loadSource, type Rule } from "../scripts/gen-agent-permissions";

// Guards against prompts telling an agent to call a tool its generated
// permissions deny (e.g. an agent without web access told to use gofetch).

const root = new URL("../", import.meta.url);
const source = loadSource();

/** Last-match-wins, like OpenCode, for a tool invoked on an unspecified resource. */
function allows(rules: Rule[], tool: string): boolean {
  let effect: Rule["effect"] | undefined;
  for (const rule of rules) {
    if (rule.resource !== "*") continue;
    const pattern = new RegExp(`^${rule.action.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    if (pattern.test(tool)) effect = rule.effect;
  }
  return effect === "allow" || effect === "ask";
}

// Tool ids that a prompt may name in backticks. Prefix families cover MCP and plugin tools.
// `question` is also a finding severity, so it only counts when written as "`question` tool".
const TOOL = /`((?:workplan|gofetch|docs|context7|deepwiki|grep_app|lsp-tools|researcher-mcp|ats-tailor)_[a-z_]+|webfetch|websearch)`|`(question)`\s+tool/g;

function body(agent: string): string {
  const markdown = readFileSync(new URL(`agents/${agent}.md`, root), "utf8");
  return markdown.split(/^---$/m).slice(2).join("---");
}

describe("agent prompts only name tools the agent may use", () => {
  const agents = readdirSync(new URL("agents", root))
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -3));

  for (const agent of agents) {
    it(agent, () => {
      const rules = expand(source, source.agents[agent] ?? []);
      const named = [...body(agent).matchAll(TOOL)].map((match) => match[1] ?? match[2]);
      const denied = [...new Set(named)].filter((tool) => !allows(rules, tool));
      expect(denied).toEqual([]);
    });
  }
});
