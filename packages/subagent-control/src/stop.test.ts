import { describe, expect, test } from "bun:test";
import { stopSubagent, type ChildSession, type SessionPort } from "./stop";

function fakeSession(sessions: Record<string, ChildSession>, running: Set<string>) {
  const interrupted: string[] = [];
  const port: SessionPort = {
    async get({ sessionID }) {
      const found = sessions[sessionID];
      if (!found) throw new Error("not found");
      return found;
    },
    async interrupt({ sessionID }) {
      interrupted.push(sessionID);
      const wasRunning = running.delete(sessionID);
      return { interrupted: wasRunning };
    },
  };
  return { port, interrupted };
}

const sessions: Record<string, ChildSession> = {
  ses_parent: { id: "ses_parent" },
  ses_child: { id: "ses_child", parentID: "ses_parent", agent: "code-writer" },
  ses_other: { id: "ses_other", parentID: "ses_someone_else", agent: "explore" },
};

describe("stopSubagent", () => {
  test("interrupts a running direct child", async () => {
    const { port, interrupted } = fakeSession(sessions, new Set(["ses_child"]));
    const out = await stopSubagent(port, { sessionID: "ses_child", reason: "superseded" }, { sessionID: "ses_parent" });
    expect(interrupted).toEqual(["ses_child"]);
    expect(out).toContain("Stopped subagent ses_child (code-writer)");
    expect(out).toContain("sessionID ses_child");
    expect(out).toContain("Reason: superseded");
  });

  test("reports an idle child without claiming a stop", async () => {
    const { port } = fakeSession(sessions, new Set());
    const out = await stopSubagent(port, { sessionID: "ses_child" }, { sessionID: "ses_parent" });
    expect(out).toContain("was not running");
  });

  test("refuses a session that is not the caller's child", async () => {
    const { port, interrupted } = fakeSession(sessions, new Set(["ses_other"]));
    await expect(stopSubagent(port, { sessionID: "ses_other" }, { sessionID: "ses_parent" })).rejects.toThrow(/not a child/);
    expect(interrupted).toEqual([]);
  });

  test("refuses the calling session itself", async () => {
    const { port, interrupted } = fakeSession(sessions, new Set(["ses_parent"]));
    await expect(stopSubagent(port, { sessionID: "ses_parent" }, { sessionID: "ses_parent" })).rejects.toThrow(/calling session/);
    expect(interrupted).toEqual([]);
  });

  test("surfaces an unreadable session", async () => {
    const { port } = fakeSession(sessions, new Set());
    await expect(stopSubagent(port, { sessionID: "ses_missing" }, { sessionID: "ses_parent" })).rejects.toThrow(/could not be read/);
  });

  test("rejects malformed input", async () => {
    const { port } = fakeSession(sessions, new Set());
    const caller = { sessionID: "ses_parent" };
    await expect(stopSubagent(port, {}, caller)).rejects.toThrow(/sessionID/);
    await expect(stopSubagent(port, { sessionID: " " }, caller)).rejects.toThrow(/sessionID/);
    await expect(stopSubagent(port, { sessionID: "ses_child", extra: 1 }, caller)).rejects.toThrow(/unknown field/);
    await expect(stopSubagent(port, "ses_child", caller)).rejects.toThrow(/expected an object/);
  });
});
