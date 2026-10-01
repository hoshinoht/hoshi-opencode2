import { describe, expect, test } from "bun:test";
import { listSubagents, type ChildInfo, type ListPort } from "./list";

const NOW = 10_000_000;

function child(id: string, parentID: string, agent: string, createdAgoSec: number, extra: Partial<ChildInfo> = {}): ChildInfo {
  return { id, parentID, agent, title: `${agent} task`, time: { created: NOW - createdAgoSec * 1000, updated: NOW - 5_000 }, ...extra };
}

function port(children: ChildInfo[], running: string[], known = ["ses_parent"]): ListPort {
  return {
    async get(sessionID) {
      if (!known.includes(sessionID)) throw new Error("not found");
      return { id: sessionID };
    },
    async children() {
      return children;
    },
    async active() {
      return new Set(running);
    },
  };
}

const caller = { sessionID: "ses_parent", now: NOW };

describe("listSubagents", () => {
  test("lists own children, running first then newest", async () => {
    const out = await listSubagents(
      port(
        [
          child("ses_old", "ses_parent", "explore", 600, { outcome: "succeeded" }),
          child("ses_new", "ses_parent", "tester", 30, { outcome: "failed", time: { created: NOW - 30_000, updated: NOW - 30_000, idle: NOW - 10_000 } }),
          child("ses_busy", "ses_parent", "code-writer", 900),
        ],
        ["ses_busy"],
      ),
      {},
      caller,
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("3 subagent(s) of this session, 1 running:");
    expect(lines[1]).toBe("- ses_busy | code-writer | running | created 15m ago");
    expect(lines[3]).toBe("- ses_new | tester | idle, last turn failed and ended 10s ago | created 30s ago");
    expect(out).not.toContain("updated");
    expect(lines[5]).toContain("- ses_old | explore | idle, last turn succeeded");
    expect(lines[2]).toBe("  code-writer task");
  });

  test("drops sessions whose parentID is not the caller", async () => {
    const out = await listSubagents(port([child("ses_x", "ses_other", "explore", 10)], ["ses_x"]), {}, caller);
    expect(out).toBe("This session has not started any subagents.");
  });

  test("running_only filters idle children", async () => {
    const children = [child("ses_a", "ses_parent", "explore", 10, { outcome: "succeeded" })];
    expect(await listSubagents(port(children, []), { running_only: true }, caller)).toBe("No subagents of this session are running.");
  });

  test("refuses when the discovered service does not hold the caller", async () => {
    await expect(listSubagents(port([], [], []), {}, caller)).rejects.toThrow(/does not hold this session/);
  });

  test("rejects malformed input", async () => {
    await expect(listSubagents(port([], []), { running_only: "yes" }, caller)).rejects.toThrow(/boolean/);
    await expect(listSubagents(port([], []), { all: true }, caller)).rejects.toThrow(/unknown field/);
  });
});
