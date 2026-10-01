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

describe("listSubagents activity and cache lines", () => {
  const MIN = 60_000;
  const histories: Record<string, unknown[]> = {
    ses_busy: [
      {
        type: "assistant",
        model: { providerID: "anthropic" },
        time: { created: NOW - 2 * MIN },
        content: [{ type: "tool", name: "shell", state: { status: "running" }, time: { created: NOW - 2 * MIN, ran: NOW - 2 * MIN } }],
      },
    ],
    ses_cold: [
      { type: "assistant", model: { providerID: "anthropic" }, time: { created: NOW - 47 * MIN, completed: NOW - 46 * MIN }, tokens: { input: 2, cache: { read: 134_000, write: 400 } } },
    ],
    ses_warm: [{ type: "assistant", model: { providerID: "openai" }, time: { created: NOW - 10 * MIN, completed: NOW - 9 * MIN }, tokens: { input: 50_000 } }],
  };
  const withContext = (base: ListPort): ListPort => ({
    ...base,
    async context(sessionID) {
      const history = histories[sessionID];
      if (!history) throw new Error("unreadable");
      return history;
    },
  });
  const children = [
    child("ses_busy", "ses_parent", "frontend-engineer", 900),
    child("ses_cold", "ses_parent", "code-writer", 3000, { outcome: "succeeded", time: { created: NOW - 50 * MIN, updated: 0, idle: NOW - 46 * MIN } }),
    child("ses_warm", "ses_parent", "explore", 1200, { outcome: "succeeded" }),
    child("ses_gone", "ses_parent", "tester", 600, { outcome: "failed" }),
  ];
  const options = { cacheTTLMinutes: { anthropic: 5, openai: 30 } };

  test("running child shows current work and last activity; idle ones show cache state", async () => {
    const out = await listSubagents(withContext(port(children, ["ses_busy"])), {}, caller, options);
    expect(out).toContain("- ses_busy | frontend-engineer | running shell for 2m, last activity 2m ago | created 15m ago");
    expect(out).toContain(
      "  cache: likely cold, last model call 47m ago (anthropic, 5m lifetime); resuming re-writes ~134k context tokens at the cache-write price",
    );
    expect(out).toContain("  cache: likely warm for ~20m more (openai, 30m lifetime)");
    expect(out).toContain("- ses_gone | tester | idle, last turn failed");
    expect(out).toContain("  activity unavailable: its message history could not be read");
    // Running children refresh their own cache, so they get no cache line.
    const busyBlock = out.split("\n- ")[1]!;
    expect(busyBlock).not.toContain("cache:");
  });

  test("without a context reader the extra lines are omitted", async () => {
    const out = await listSubagents(port(children, ["ses_busy"]), {}, caller, options);
    expect(out).toContain("- ses_busy | frontend-engineer | running | created 15m ago");
    expect(out).not.toContain("cache:");
    expect(out).not.toContain("activity unavailable");
  });
});
