import { describe, expect, test } from "bun:test";
import {
  collectImages,
  parseBytes,
  planPrune,
  pruneAll,
  pruneRequest,
  SessionPrunes,
  validateOptions,
  type Options,
} from "./budget";

/** A distinct fake base64 payload of `kb` KiB. */
function payload(kb: number, seed: string): string {
  return (seed + "A".repeat(63)).slice(0, 64).repeat(kb * 16);
}

let calls = 0;
function readTurn(kb: number, seed: string, path = `/tmp/${seed}.png`): unknown[] {
  const id = `call_${calls++}`;
  return [
    { role: "assistant", content: [{ type: "tool-call", id, name: "read", input: { filePath: path } }] },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          id,
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Image read successfully" },
              { type: "file", uri: `data:image/png;base64,${payload(kb, seed)}`, mime: "image/png" },
            ],
          },
        },
      ],
    },
  ];
}

function pasted(kb: number, seed: string): unknown {
  return {
    id: `msg_${seed}`,
    role: "user",
    content: [
      { type: "text", text: "look at this" },
      { type: "media", media: { mediaType: "image/png", source: { type: "base64", data: payload(kb, seed), mediaType: "image/png" } } },
    ],
  };
}

const opts = (over: Partial<Options> = {}): Options => ({ ...validateOptions(undefined), ...over });

function texts(messages: unknown[]): string[] {
  return JSON.stringify(messages).match(/\[Image[^\]]*\]/g) ?? [];
}

describe("validateOptions", () => {
  test("defaults", () => {
    expect(validateOptions(undefined)).toEqual({ maxImages: 12, maxImageBytes: 6 * 1024 * 1024, pruneTo: 0.5, providers: {} });
  });

  test("parses byte strings and provider overrides", () => {
    const o = validateOptions({ maxImageBytes: "8MiB", providers: { anthropic: { maxImages: 5, maxImageBytes: "512KB" } } });
    expect(o.maxImageBytes).toBe(8 * 1024 * 1024);
    expect(o.providers.anthropic).toEqual({ maxImages: 5, maxImageBytes: 512 * 1024 });
  });

  test("rejects unknown keys and bad values", () => {
    expect(() => validateOptions({ maxImage: 3 })).toThrow("unknown option(s) maxImage");
    expect(() => validateOptions({ providers: { openai: { foo: 1 } } })).toThrow("providers.openai.foo");
    expect(() => validateOptions({ pruneTo: 0 })).toThrow("pruneTo");
    expect(() => validateOptions({ maxImages: 0 })).toThrow("maxImages");
    expect(() => parseBytes("lots", "x")).toThrow("positive byte count");
  });
});

describe("collectImages", () => {
  test("finds tool-result data URIs and pasted media, with the read path", () => {
    const messages = [...readTurn(10, "a", "/x/shot.png"), pasted(5, "b")];
    const refs = collectImages(messages);
    expect(refs.map((r) => [r.pasted, r.path, r.mime])).toEqual([
      [false, "/x/shot.png", "image/png"],
      [true, undefined, "image/png"],
    ]);
    expect(refs[0]!.bytes).toBe(`data:image/png;base64,${payload(10, "a")}`.length);
    expect(refs[1]!.bytes).toBe(5 * 1024);
  });

  test("ignores non-image files and url sources", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "media", media: { mediaType: "image/png", source: { type: "url", url: "https://x/y.png" } } },
          { type: "media", media: { mediaType: "application/pdf", source: { type: "base64", data: "AAAA", mediaType: "application/pdf" } } },
        ],
      },
    ];
    expect(collectImages(messages)).toEqual([]);
  });
});

describe("pruneRequest", () => {
  const budget = { maxImages: 4, maxImageBytes: 10 * 1024 * 1024, pruneTo: 0.5 };

  test("leaves a request under budget untouched", () => {
    const messages = [...readTurn(100, "a"), ...readTurn(100, "b")];
    const before = JSON.stringify(messages);
    const out = pruneRequest(new SessionPrunes(), { sessionID: "s", model: { providerID: "openai" }, messages }, opts(budget));
    expect(out).toEqual({ images: 0, bytes: 0, changed: false });
    expect(JSON.stringify(messages)).toBe(before);
  });

  test("over the count, keeps the newest pruneTo share and notes the path to re-read", () => {
    const messages = ["a", "b", "c", "d", "e"].flatMap((s) => readTurn(10, s));
    const out = pruneRequest(new SessionPrunes(), { sessionID: "s", model: {}, messages }, opts(budget));
    expect(out.changed).toBe(true);
    expect(out.images).toBe(3);
    expect(collectImages(messages)).toHaveLength(2);
    expect(texts(messages)[0]).toContain("Read /tmp/a.png again");
  });

  test("over the bytes, prunes everything older than the cut", () => {
    // 3.75 MB of images against a 3 MB budget, pruned to 1.5 MB: the newest 1 MB fits, the next 1 MB does not.
    const messages = [...readTurn(256, "a"), ...readTurn(1024, "b"), ...readTurn(512, "c"), ...readTurn(1024, "d"), ...readTurn(1024, "e")];
    pruneRequest(new SessionPrunes(), { sessionID: "s", model: {}, messages }, opts({ ...budget, maxImages: 50, maxImageBytes: 3 * 1024 * 1024 }));
    const left = collectImages(messages).map((r) => r.bytes);
    expect(left).toHaveLength(1);
    expect(left[0]).toBeGreaterThan(1024 * 1024);
  });

  test("drops older copies of the same image", () => {
    const messages = [...readTurn(10, "a"), ...readTurn(10, "b"), ...readTurn(10, "a"), ...readTurn(10, "c"), ...readTurn(10, "d")];
    pruneRequest(new SessionPrunes(), { sessionID: "s", model: {}, messages }, opts({ ...budget, pruneTo: 1 }));
    expect(texts(messages)).toEqual(["[Image omitted: the same image appears later in this conversation.]"]);
    expect(collectImages(messages)).toHaveLength(4);
  });

  test("keeps earlier decisions so the prefix only changes on a prune turn", () => {
    const state = new SessionPrunes();
    const history = ["a", "b", "c", "d", "e"].flatMap((s) => readTurn(10, s));
    const request = () => structuredClone(history);

    const first = request();
    expect(pruneRequest(state, { sessionID: "s", model: {}, messages: first }, opts(budget)).changed).toBe(true);

    // Next turn: same history plus one new screenshot, still within budget for live images.
    history.push(...readTurn(10, "f"));
    const second = request();
    const out = pruneRequest(state, { sessionID: "s", model: {}, messages: second }, opts(budget));
    expect(out.changed).toBe(false);
    expect(out.images).toBe(3);
    // The pruned prefix is byte-identical to the previous request's.
    expect(JSON.stringify(second).startsWith(JSON.stringify(first).slice(0, -1))).toBe(true);
  });

  test("a later re-read of a pruned file is kept", () => {
    const state = new SessionPrunes();
    const history = ["a", "b", "c", "d", "e"].flatMap((s) => readTurn(10, s));
    pruneRequest(state, { sessionID: "s", model: {}, messages: structuredClone(history) }, opts(budget));
    history.push(...readTurn(10, "a"));
    const messages = structuredClone(history);
    pruneRequest(state, { sessionID: "s", model: {}, messages }, opts(budget));
    expect(collectImages(messages).at(-1)!.path).toBe("/tmp/a.png");
  });

  test("uses the provider override", () => {
    const messages = [...readTurn(10, "a"), ...readTurn(10, "b")];
    const o = validateOptions({ providers: { anthropic: { maxImages: 1 } } });
    pruneRequest(new SessionPrunes(), { sessionID: "s", model: { providerID: "anthropic" }, messages }, o);
    expect(collectImages(messages)).toHaveLength(1);
  });

  test("prunes a single image larger than the whole budget", () => {
    const messages = readTurn(64, "a");
    pruneRequest(new SessionPrunes(), { sessionID: "s", model: {}, messages }, opts({ ...budget, maxImageBytes: 32 * 1024 }));
    expect(collectImages(messages)).toEqual([]);
  });

  test("notes a pasted image as the user's", () => {
    const messages = [pasted(10, "a"), pasted(10, "b")];
    pruneRequest(new SessionPrunes(), { sessionID: "s", model: {}, messages }, opts({ ...budget, maxImages: 1 }));
    expect(texts(messages)[0]).toContain("Ask the user to attach it again");
  });
});

describe("pruneAll and SessionPrunes", () => {
  test("compaction removes every inline image", () => {
    const messages = [...readTurn(10, "a"), pasted(10, "b")];
    expect(pruneAll(messages).images).toBe(2);
    expect(collectImages(messages)).toEqual([]);
  });

  test("evicts the least recently set session past the limit", () => {
    const state = new SessionPrunes(2);
    state.set("a", new Map([["k", "budget"]]));
    state.set("b", new Map([["k", "budget"]]));
    state.set("a", new Map([["k", "budget"]]));
    state.set("c", new Map([["k", "budget"]]));
    expect(state.get("b").size).toBe(0);
    expect(state.get("a").size).toBe(1);
  });
});
