import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import type { ChildInfo, ListPort } from "./list";

const PAGE_LIMIT = 100;

/**
 * The plugin context's session API has no list call, so listing goes through the
 * local OpenCode service. Make one port per tool call: the service can restart between calls.
 */
export function discoveredListPort(): ListPort {
  let connected: Promise<ReturnType<typeof OpenCode.make>> | undefined;
  function client() {
    connected ??= Service.discover().then((endpoint) => {
      if (!endpoint) throw new Error("subagent_list: no running local OpenCode service was discovered.");
      return OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
    });
    return connected;
  }
  return {
    async get(sessionID, signal) {
      return (await client()).session.get({ sessionID }, signal ? { signal } : undefined);
    },
    async children(parentID, signal) {
      const page = await (await client()).session.list({ parentID, limit: PAGE_LIMIT, order: "desc" }, signal ? { signal } : undefined);
      return page.data as ChildInfo[];
    },
    async active(signal) {
      const running = await (await client()).session.active(signal ? { signal } : undefined);
      return new Set(Object.entries(running).filter(([, state]) => state.type === "running").map(([id]) => id));
    },
  };
}
