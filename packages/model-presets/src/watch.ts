/**
 * Preset file watcher. Watches the file's directory rather than the file, so
 * editors that save by writing a temp file and renaming it over the original
 * (vim, VS Code, JetBrains, ...) keep triggering events; a watch on the file
 * itself would stay attached to the replaced inode. Events for other entries
 * in the directory are ignored, bursts are debounced, and a callback only
 * fires when the file content actually changed.
 */

import { readFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { PREFIX } from "./options";

export const DEBOUNCE_MS = 300;

export interface PresetWatcher {
  close(): void;
}

export interface WatchOptions {
  debounceMs?: number;
  /** Reads the file; returns undefined when it is missing or unreadable. */
  read?: (path: string) => string | undefined;
  warn?: (message: string) => void;
  /** Injectable for tests. */
  watch?: (dir: string, listener: (event: string, filename: string | Buffer | null) => void) => FSWatcher;
}

function readOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Call `onChange` (debounced) whenever the content of `path` changes,
 * including deletion and re-creation. Returns undefined when the directory
 * cannot be watched; the failure is reported through `warn`.
 */
export function watchPresetFile(path: string, onChange: () => void, options: WatchOptions = {}): PresetWatcher | undefined {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const read = options.read ?? readOrUndefined;
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const dir = dirname(path);
  const name = basename(path);
  let last = read(path);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const fire = () => {
    timer = undefined;
    if (closed) return;
    const next = read(path);
    if (next === last) return;
    last = next;
    onChange();
  };

  let watcher: FSWatcher;
  try {
    const listener = (_event: string, filename: string | Buffer | null) => {
      // Some platforms omit the filename; then any event may concern the file.
      if (filename !== null && filename !== undefined && String(filename) !== name) return;
      if (closed) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(fire, debounceMs);
    };
    watcher = options.watch ? options.watch(dir, listener) : fsWatch(dir, { persistent: false }, listener);
  } catch (error) {
    warn(`[${PREFIX}] cannot watch ${dir} for preset edits; edits apply on the next agent reload: ${String(error)}`);
    return undefined;
  }
  watcher.on?.("error", (error) => warn(`[${PREFIX}] preset file watcher error: ${String(error)}`));

  return {
    close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      watcher.close();
    },
  };
}
