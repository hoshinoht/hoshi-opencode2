/**
 * Expand scripts/agent-permissions.yaml into the `permissions:` block of each
 * agents/<name>.md frontmatter.
 *
 * OpenCode evaluates permission rules last-match-wins, so rule order is
 * significant: fragments expand in place, exactly where they are referenced.
 *
 *   bun scripts/gen-agent-permissions.ts          rewrite agent files
 *   bun scripts/gen-agent-permissions.ts --check  exit 1 if any file is stale
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";

export type Rule = { action: string; resource: string; effect: "allow" | "ask" | "deny" };
type Entry = string | [string, string, string];
type Source = { fragments: Record<string, Entry[]>; agents: Record<string, Entry[]> };

const EFFECTS = new Set(["allow", "ask", "deny"]);
const ROOT = join(import.meta.dir, "..");

export function loadSource(path = join(ROOT, "scripts/agent-permissions.yaml")): Source {
  return parse(readFileSync(path, "utf8")) as Source;
}

export function expand(source: Source, entries: Entry[], trail: string[] = []): Rule[] {
  return entries.flatMap((entry) => {
    if (typeof entry === "string") {
      if (!entry.startsWith("@")) throw new Error(`bare string '${entry}' (fragment refs start with @)`);
      const name = entry.slice(1);
      if (trail.includes(name)) throw new Error(`fragment cycle: ${[...trail, name].join(" -> ")}`);
      const fragment = source.fragments[name];
      if (!fragment) throw new Error(`unknown fragment @${name}`);
      return expand(source, fragment, [...trail, name]);
    }
    const [action, resource, effect] = entry;
    if (!EFFECTS.has(effect)) throw new Error(`bad effect '${effect}' in [${entry.join(", ")}]`);
    return [{ action, resource, effect } as Rule];
  });
}

/** Replace the frontmatter `permissions:` block (or append one) with `rules`. */
export function renderAgent(markdown: string, rules: Rule[]): string {
  const lines = markdown.split("\n");
  if (lines[0] !== "---") throw new Error("missing frontmatter");
  const close = lines.indexOf("---", 1);
  if (close < 0) throw new Error("unterminated frontmatter");

  const block = stringify({ permissions: rules }, { lineWidth: 0 }).trimEnd().split("\n");
  const start = lines.findIndex((line, i) => i > 0 && i < close && line.startsWith("permissions:"));
  if (start < 0) return [...lines.slice(0, close), ...block, ...lines.slice(close)].join("\n");

  let end = start + 1;
  while (end < close && (lines[end] === "" || /^\s/.test(lines[end]))) end++;
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
}

export function generate(check: boolean): string[] {
  const source = loadSource();
  const stale: string[] = [];
  for (const [agent, entries] of Object.entries(source.agents)) {
    const file = join(ROOT, "agents", `${agent}.md`);
    if (!existsSync(file)) {
      console.warn(`skip ${agent}: agents/${agent}.md not found`);
      continue;
    }
    const current = readFileSync(file, "utf8");
    const next = renderAgent(current, expand(source, entries));
    if (next === current) continue;
    stale.push(agent);
    if (!check) writeFileSync(file, next);
  }
  return stale;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const stale = generate(check);
  if (check && stale.length) {
    console.error(`stale agent permissions: ${stale.join(", ")}\nrun: bun scripts/gen-agent-permissions.ts`);
    process.exit(1);
  }
  console.log(stale.length ? `${check ? "stale" : "updated"}: ${stale.join(", ")}` : "agent permissions up to date");
}
