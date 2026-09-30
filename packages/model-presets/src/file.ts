/**
 * Preset file loading. The file is YAML (comments allowed) and is re-read on
 * every agent reload and whenever the file watcher sees an edit; a broken
 * edit keeps the last good presets and surfaces the error with file path and
 * line.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { LineCounter, parseDocument } from "yaml";
import { PREFIX, PresetError, validatePresets, type PresetOptions } from "./options";

/**
 * Config root: the directory holding `packages/`, i.e. two levels above this
 * package (`<root>/packages/model-presets`). Local plugin paths in
 * opencode.json are relative to the same directory.
 */
export const CONFIG_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** Resolve `file` (absolute, `~/`-prefixed, or relative to `root`). */
export function resolvePresetPath(file: string, root: string = CONFIG_ROOT): string {
  if (file === "~") return homedir();
  if (file.startsWith("~/")) return join(homedir(), file.slice(2));
  return isAbsolute(file) ? file : resolve(root, file);
}

export type LoadResult = { ok: true; options: PresetOptions } | { ok: false; error: string };

function position(lines: LineCounter, offset: number | undefined): string {
  if (offset === undefined) return "";
  const { line, col } = lines.linePos(offset);
  return `:${line}:${col}`;
}

/** Parse and validate preset YAML. `path` is only used in error messages. */
export function parsePresetYaml(source: string, path: string): LoadResult {
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines, prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    return { ok: false, error: `${PREFIX}: ${path}${position(lines, first.pos?.[0])}: YAML error: ${first.message.split("\n")[0]}` };
  }
  try {
    return { ok: true, options: validatePresets(doc.toJS()) };
  } catch (error) {
    if (error instanceof PresetError) {
      // Point at the deepest node on the error path that exists in the document.
      let offset: number | undefined;
      for (let depth = error.path.length; depth > 0 && offset === undefined; depth--) {
        const node = doc.getIn(error.path.slice(0, depth), true) as { range?: [number, number, number] } | undefined;
        offset = node?.range?.[0];
        if (offset === undefined && depth === error.path.length) {
          // Unknown keys: point at the key itself via the parent mapping.
          const parent = doc.getIn(error.path.slice(0, depth - 1), true) as
            | { items?: { key?: { value?: unknown; range?: [number, number, number] } }[] }
            | undefined;
          const key = parent?.items?.find((pair) => pair.key?.value === error.path[depth - 1])?.key;
          offset = key?.range?.[0];
        }
      }
      return { ok: false, error: `${PREFIX}: ${path}${position(lines, offset)}: ${error.message.replace(`${PREFIX}: `, "")}` };
    }
    return { ok: false, error: `${PREFIX}: ${path}: ${String(error)}` };
  }
}

export function loadPresetFile(path: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): LoadResult {
  let source: string;
  try {
    source = read(path);
  } catch (error) {
    const code = (error as { code?: string }).code;
    return {
      ok: false,
      error: `${PREFIX}: ${path}: ${code === "ENOENT" ? "preset file not found" : `cannot read preset file (${String(error)})`}`,
    };
  }
  return parsePresetYaml(source, path);
}
