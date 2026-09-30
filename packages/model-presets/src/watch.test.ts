import { describe, expect, it } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchPresetFile } from "./watch";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `check()` is true or `timeoutMs` passes. */
async function until(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(20);
  }
  return check();
}

function tempFile(content = "active: a\n") {
  const dir = mkdtempSync(join(tmpdir(), "model-presets-watch-"));
  const path = join(dir, "model-presets.yaml");
  writeFileSync(path, content);
  return { dir, path };
}

describe("watchPresetFile (real fs)", () => {
  it("fires once for an in-place write burst, debounced", async () => {
    const { path } = tempFile();
    let calls = 0;
    const watcher = watchPresetFile(path, () => calls++, { debounceMs: 50 })!;
    try {
      await sleep(50);
      writeFileSync(path, "active: b\n");
      writeFileSync(path, "active: c\n");
      expect(await until(() => calls > 0)).toBe(true);
      await sleep(200);
      expect(calls).toBe(1);
    } finally {
      watcher.close();
    }
  });

  it("survives editors that replace the file via rename", async () => {
    const { dir, path } = tempFile();
    let calls = 0;
    const watcher = watchPresetFile(path, () => calls++, { debounceMs: 50 })!;
    try {
      await sleep(50);
      for (const [i, text] of ["active: b\n", "active: c\n"].entries()) {
        const tmp = join(dir, `.model-presets.yaml.swp${i}`);
        writeFileSync(tmp, text);
        renameSync(tmp, path);
        expect(await until(() => calls === i + 1)).toBe(true);
      }
    } finally {
      watcher.close();
    }
  });

  it("ignores other files and unchanged content, and stops after close", async () => {
    const { dir, path } = tempFile();
    let calls = 0;
    const watcher = watchPresetFile(path, () => calls++, { debounceMs: 30 })!;
    await sleep(50);
    writeFileSync(join(dir, "other.yaml"), "x");
    writeFileSync(path, "active: a\n"); // same content
    await sleep(200);
    expect(calls).toBe(0);
    watcher.close();
    writeFileSync(path, "active: z\n");
    await sleep(200);
    expect(calls).toBe(0);
  });

  it("reports deletion and re-creation as changes", async () => {
    const { path } = tempFile();
    let calls = 0;
    const watcher = watchPresetFile(path, () => calls++, { debounceMs: 30 })!;
    try {
      await sleep(50);
      rmSync(path);
      expect(await until(() => calls === 1)).toBe(true);
      writeFileSync(path, "active: a\n");
      expect(await until(() => calls === 2)).toBe(true);
    } finally {
      watcher.close();
    }
  });

  it("returns undefined and warns when the directory cannot be watched", () => {
    const warnings: string[] = [];
    const watcher = watchPresetFile("/definitely/not/here/model-presets.yaml", () => {}, {
      warn: (w) => warnings.push(w),
    });
    expect(watcher).toBeUndefined();
    expect(warnings[0]).toMatch(/cannot watch \/definitely\/not\/here/);
  });
});
