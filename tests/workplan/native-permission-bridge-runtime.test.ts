import { expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeIt = process.env.WORKPLAN_PERMISSION_BRIDGE_RUNTIME === "1" ? it : it.skip;
const OPENCODE = "/opt/homebrew/bin/opencode";
const APPROVED_TEMP_ROOT = "/private/var/folders/h1/k8x791y54cl2t80qq8_pvz5m0000gn/T/opencode";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "native-permission-bridge-runtime");
const RUNTIME_EVIDENCE = join(APPROVED_TEMP_ROOT, "native-permission-bridge-runtime.json");

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a loopback port");
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return port;
}

async function waitForServer(baseURL: string, process: ReturnType<typeof Bun.spawn>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.exitCode !== null) throw new Error("The isolated OpenCode server exited during startup");
    try {
      const response = await fetch(`${baseURL}/api/info`);
      if (response.status < 500) return;
    } catch {
      // Startup is polled only on the test-owned loopback endpoint.
    }
    await pause(100);
  }
  throw new Error("The isolated OpenCode server did not become ready");
}

async function stopServer(process: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  const exited = await Promise.race([process.exited.then(() => true), pause(3_000).then(() => false)]);
  if (!exited) {
    process.kill("SIGKILL");
    await process.exited;
  }
}

runtimeIt("proves public permission behavior and cancellation on isolated OpenCode 2.0.19", async () => {
  mkdirSync(APPROVED_TEMP_ROOT, { recursive: true });
  const scratch = mkdtempSync(join(APPROVED_TEMP_ROOT, "native-permission-bridge-runtime-"));
  const home = join(scratch, "home");
  const configHome = join(home, ".config");
  const dataHome = join(home, ".local", "share");
  const stateHome = join(home, ".local", "state");
  const cacheHome = join(home, ".cache");
  const tempHome = join(scratch, "tmp");
  const projectDirectory = join(scratch, "project");
  mkdirSync(projectDirectory, { recursive: true });
  const projectRoot = realpathSync(projectDirectory);
  const configDirectory = join(configHome, "opencode");
  const clientDirectory = join(scratch, "external-client");
  const clientModules = join(clientDirectory, "node_modules", "@opencode");
  mkdirSync(configDirectory, { recursive: true });
  mkdirSync(dataHome, { recursive: true });
  mkdirSync(stateHome, { recursive: true });
  mkdirSync(cacheHome, { recursive: true });
  mkdirSync(tempHome, { recursive: true });
  mkdirSync(clientModules, { recursive: true });

  const env = {
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: stateHome,
    XDG_CACHE_HOME: cacheHome,
    TMPDIR: tempHome,
    PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: "en_US.UTF-8",
    NO_COLOR: "1",
  };
  let server: ReturnType<typeof Bun.spawn> | undefined;

  try {
    const versionProcess = Bun.spawn([OPENCODE, "--version"], { env, stdout: "pipe", stderr: "ignore" });
    const versionOutput = await new Response(versionProcess.stdout).text();
    const versionExit = await versionProcess.exited;
    expect(versionExit).toBe(0);
    expect(versionOutput).toContain("v2.0.19");

    writeFileSync(join(configDirectory, "opencode.json"), JSON.stringify({
      plugins: [{ package: FIXTURE_ROOT }],
    }));
    copyFileSync(join(FIXTURE_ROOT, "client.mjs"), join(clientDirectory, "client.mjs"));
    symlinkSync(
      resolve(REPO_ROOT, "packages/workplan-tools/node_modules/@opencode/client"),
      join(clientModules, "client"),
      "dir",
    );
    symlinkSync(
      resolve(REPO_ROOT, "packages/workplan-tools/node_modules/@opencode/plugin"),
      join(clientModules, "plugin"),
      "dir",
    );

    const port = await reservePort();
    const baseURL = `http://127.0.0.1:${port}`;
    server = Bun.spawn([OPENCODE, "serve", "--service", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: projectRoot,
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitForServer(baseURL, server);

    const clientProcess = Bun.spawn([process.execPath, join(clientDirectory, "client.mjs"), projectRoot], {
      cwd: clientDirectory,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(clientProcess.stdout).text();
    const exitCode = await clientProcess.exited;
    const summary = output.trim() ? JSON.parse(output.trim()) as Record<string, unknown> : {};
    expect(exitCode).toBe(0);
    expect(summary).toMatchObject({
      ok: true,
      runtimeVersion: "2.0.19",
      clientVersion: "2.0.20",
      hostBinding: "verified",
      eventStream: "ready",
      allow: "runtime-policy",
      deny: "deny",
      askGrant: "user-reply",
      askReject: "rejected",
      lateReplyContinued: false,
      continuationCount: 2,
    });
    writeFileSync(RUNTIME_EVIDENCE, `${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    if (server) await stopServer(server);
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
