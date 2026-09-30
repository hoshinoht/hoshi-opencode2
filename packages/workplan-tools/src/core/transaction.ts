import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  assertSafePathAccess,
  isWithinWorkspaceRoot,
  normalizeId,
  normalizePlanFile,
  normalizeSpecFiles,
  workplanDirectory,
  workplanPath,
} from "./shared";
import { workplanCheckpointSchema, workplanDependenciesSchema, workplanDocumentSchema, workplanJournalSchema, workplanLockOwnerSchema, workplanPermissionIntentSchema } from "./schemas";
import { readWorkplanSnapshot, type WorkplanSnapshot } from "./snapshot";
import { validateDependencyRecords } from "./dependencies";
import type { WorkplanDocument, WorkplanManifestEntry } from "./types";
import {
  checkpointPath,
  dependencyPath,
  journalPath,
  journalStagePath,
  lockReclaimPath,
  planLockPath,
  stagePath,
  workspaceLockPath,
} from "./storage-paths";

const DEFAULT_LOCK_WAIT_MS = 5_000;
const ABANDONED_LOCK_GRACE_MS = 5 * 60_000;
const HASH = /^[a-f0-9]{64}$/;

export type WorkplanMutationIntent = {
  schemaVersion: 1;
  operation: string;
  workspaceRoot: string;
  workplanId: string;
  readPaths: string[];
  writePaths: string[];
  deletePaths: string[];
  lockPaths: string[];
  stagingPaths: string[];
  resources: string[];
};

export type WorkplanMutationInvocation = {
  directory?: string;
  worktree?: string;
  abort?: AbortSignal;
  signal?: AbortSignal;
  ask?: (input: {
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  }) => Promise<unknown>;
  authorize?: (intent: WorkplanMutationIntent, invocation: WorkplanMutationInvocation) => Promise<void>;
  fault?: (stage: string, detail?: Record<string, unknown>) => void | Promise<void>;
};

export type MutationTarget = {
  path: string;
  content: Buffer | string | null;
  before?: Buffer | null;
  mode?: number;
  label?: string;
};

export type MutationResult = {
  snapshot: WorkplanSnapshot;
  transactionId: string;
  directorySync: "supported" | "unsupported";
};

type JournalTarget = {
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
  beforeContent: string | null;
  afterContent: string | null;
  mode: number;
};

type WorkplanJournal = {
  schemaVersion: 1;
  transactionId: string;
  workplanId: string;
  operation: string;
  createdAt: string;
  targets: JournalTarget[];
};

type LockOwner = {
  hostname: string;
  pid: number;
  nonce: string;
  startedAt: string;
};

type CommitOptions = {
  workspaceRoot: string;
  id: string;
  operation: string;
  targets: MutationTarget[];
  initialSnapshot?: WorkplanSnapshot | null;
  expectedHash?: string;
  requiredAbsentPaths?: string[];
  additionalResources?: string[];
  preflight?: (snapshot: WorkplanSnapshot | null) => Promise<void>;
  transactionId?: string;
  lockWaitMs?: number;
  signal?: AbortSignal;
  invocation: WorkplanMutationInvocation;
};

export class WorkplanRecoveryRequiredError extends Error {
  readonly transactionId: string;
  readonly journalPath: string;
  readonly paths: string[];

  constructor(transactionId: string, journal: string, paths: string[], cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause);
    super(`Workplan transaction ${transactionId} requires explicit recovery at ${journal}${detail ? `: ${detail}` : ""}`);
    this.name = "WorkplanRecoveryRequiredError";
    this.transactionId = transactionId;
    this.journalPath = journal;
    this.paths = paths;
  }
}

export class WorkplanMutationAbortedError extends Error {
  constructor() {
    super("Workplan mutation aborted; no further publication was attempted");
    this.name = "WorkplanMutationAbortedError";
  }
}

function signalFor(invocation: WorkplanMutationInvocation): AbortSignal | undefined {
  return invocation.signal ?? invocation.abort;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkplanMutationAbortedError();
}

async function checked<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  const value = await promise;
  throwIfAborted(signal);
  return value;
}

async function checkedAuthorization<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  const value = await new Promise<T>((resolvePromise, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(new WorkplanMutationAbortedError());
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (result) => { cleanup(); resolvePromise(result); },
      (error) => { cleanup(); reject(error); },
    );
  });
  throwIfAborted(signal);
  return value;
}

function sha(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function bytes(value: Buffer | string | null): Buffer | null {
  if (value === null) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
}

function manifestStateHash(manifest: WorkplanManifestEntry[]): string {
  return sha(`workplan-state-v1\n${JSON.stringify([...manifest].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))}\n`);
}

async function readPath(root: string, path: string, label: string): Promise<Buffer | null> {
  await assertSafePathAccess(root, path, label);
  try {
    return await fs.readFile(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

type FileIdentity = { dev: number; ino: number };

async function fileIdentity(path: string): Promise<FileIdentity | null> {
  try {
    const stats = await fs.lstat(path);
    return { dev: stats.dev, ino: stats.ino };
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

function sameIdentity(left: FileIdentity | null, right: FileIdentity | null): boolean {
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}

function hashValue(value: Buffer | null): string | null {
  return value === null ? null : sha(value);
}

function checkExpectedHash(snapshot: WorkplanSnapshot | null, expectedHash?: string): void {
  if (expectedHash !== undefined && !HASH.test(expectedHash)) throw new Error("expectedHash must be a 64-character lowercase SHA-256 stateHash");
  if (expectedHash !== undefined && snapshot && expectedHash !== snapshot.stateHash) {
    throw new Error(`Stale expectedHash; current stateHash is ${snapshot.stateHash}. Reread the plan and recompute the mutation.`);
  }
}

function permissionPattern(worktree: string, target: string): string {
  const relativePath = relative(resolve(worktree), resolve(target)).replaceAll("\\", "/");
  return relativePath && relativePath !== ".." && !relativePath.startsWith("../")
    ? relativePath
    : resolve(target).replaceAll("\\", "/");
}

export async function authorizeWorkplanMutation(
  intent: WorkplanMutationIntent,
  invocation: WorkplanMutationInvocation,
): Promise<void> {
  const signal = signalFor(invocation);
  throwIfAborted(signal);
  const intentCheck = workplanPermissionIntentSchema.safeParse(intent);
  if (!intentCheck.success) throw new Error(`Invalid workplan permission intent: ${intentCheck.error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`).join("; ")}`);
  if (!invocation.authorize && !invocation.ask) {
    throw new Error("Workplan mutation requires an authorization callback or the legacy context.ask permission path");
  }
  if (invocation.authorize) await checkedAuthorization(invocation.authorize(intent, invocation), signal);

  if (invocation.ask) {
    const worktree = await checked(fs.realpath(resolve(invocation.worktree ?? invocation.directory ?? intent.workspaceRoot)).catch(() => resolve(invocation.worktree ?? invocation.directory ?? intent.workspaceRoot)), signal);
    const root = resolve(intent.workspaceRoot);
    if (!isWithinWorkspaceRoot(worktree, root)) {
      const pattern = `${root.replaceAll("\\", "/")}/**`;
      await checkedAuthorization(invocation.ask({
        permission: "external_directory",
        patterns: [pattern],
        always: [pattern],
        metadata: { filepath: root, parentDir: root, workplan: intent.workplanId, operation: intent.operation },
      }), signal);
    }
    const patterns = [...new Set(intent.resources.map((path) => permissionPattern(worktree, path)))];
    await checkedAuthorization(invocation.ask({
      permission: "edit",
      patterns,
      always: patterns,
      metadata: { filepath: patterns.join(", "), workplan: intent.workplanId, operation: intent.operation },
    }), signal);
  }
  throwIfAborted(signal);
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolvePromise, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new WorkplanMutationAbortedError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  throwIfAborted(signal);
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const parsed = workplanLockOwnerSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data as LockOwner : null;
  } catch {
    return null;
  }
}

function isPositivelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as { code?: string }).code === "ESRCH";
  }
}

async function reclaimDeadLock(lockPath: string, root: string, signal?: AbortSignal, nonce: string = randomUUID()): Promise<boolean> {
  const claimPath = lockReclaimPath(lockPath);
  let claimHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let claimOwned = false;
  const claimNonce = nonce;
  try {
    await assertSafePathAccess(root, claimPath, "Workplan lock reclaim claim");
    throwIfAborted(signal);
    claimHandle = await fs.open(claimPath, "wx", 0o600);
    claimOwned = true;
    throwIfAborted(signal);
    await checked(claimHandle.writeFile(claimNonce, "utf8"), signal);
    await checked(claimHandle.sync(), signal);
  } catch (error) {
    await claimHandle?.close().catch(() => undefined);
    if (claimOwned) {
      const currentClaim = await fs.readFile(claimPath, "utf8").catch(() => null);
      if (currentClaim === claimNonce || currentClaim === "") await fs.unlink(claimPath).catch(() => undefined);
    }
    if ((error as { code?: string }).code === "EEXIST") return false;
    throw error;
  } finally {
    await claimHandle?.close().catch(() => undefined);
  }

  const movedPath = `${lockPath}.dead-${claimNonce}`;
  try {
    const before = await readPath(root, lockPath, "Workplan lock");
    if (!before) return false;
    const beforeIdentity = await fileIdentity(lockPath);
    const owner = parseOwner(before.toString("utf8"));
    const startedAt = owner ? Date.parse(owner.startedAt) : Number.NaN;
    if (!owner || owner.hostname !== hostname() || !Number.isFinite(startedAt) || Date.now() - startedAt < ABANDONED_LOCK_GRACE_MS || !isPositivelyDead(owner.pid)) return false;
    const checkedAgain = await readPath(root, lockPath, "Workplan lock");
    if (!checkedAgain || !checkedAgain.equals(before) || !sameIdentity(beforeIdentity, await fileIdentity(lockPath))) return false;
    try {
      await fs.access(movedPath);
      return false;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    throwIfAborted(signal);
    await checked(fs.rename(lockPath, movedPath), signal);
    const moved = await readPath(root, movedPath, "Reclaimed workplan lock");
    if (!moved?.equals(before) || !sameIdentity(beforeIdentity, await fileIdentity(movedPath))) {
      try {
        await fs.access(lockPath);
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") await fs.rename(movedPath, lockPath);
      }
      return false;
    }
    await checked(fs.unlink(movedPath), signal);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  } finally {
    try {
      const rawClaim = await fs.readFile(claimPath, "utf8");
      if (rawClaim === claimNonce) await fs.unlink(claimPath);
    } catch {
      // A replaced reclaim claim is left for its owner.
    }
  }
}

async function acquireLock(lockPath: string, root: string, waitMs: number, signal?: AbortSignal, nonce: string = randomUUID()): Promise<{ owner: LockOwner; raw: string }> {
  const owner: LockOwner = { hostname: hostname(), pid: process.pid, nonce, startedAt: new Date().toISOString() };
  const raw = `${JSON.stringify(owner)}\n`;
  const deadline = Date.now() + waitMs;
  while (true) {
    throwIfAborted(signal);
    await assertSafePathAccess(root, lockPath, "Workplan lock");
    try {
      throwIfAborted(signal);
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        throwIfAborted(signal);
        await checked(handle.writeFile(raw, "utf8"), signal);
        await checked(handle.sync(), signal);
      } catch (error) {
        const ownedIdentity = await handle.stat().then((stats) => ({ dev: stats.dev, ino: stats.ino })).catch(() => null);
        await handle.close().catch(() => undefined);
        if (sameIdentity(ownedIdentity, await fileIdentity(lockPath))) await fs.unlink(lockPath).catch(() => undefined);
        throw error;
      } finally {
        await handle.close().catch(() => undefined);
      }
      return { owner, raw };
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      await reclaimDeadLock(lockPath, root, signal, `${nonce}-reclaim`);
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for workplan lock ${lockPath}; inspect its owner and pending recovery before retrying`);
      await pause(Math.min(50, Math.max(1, deadline - Date.now())), signal);
    }
  }
}

async function releaseLock(lockPath: string, root: string, lock: { owner: LockOwner; raw: string }): Promise<void> {
  const releasePath = `${lockPath}.release-${lock.owner.nonce}`;
  try {
    const current = await readPath(root, lockPath, "Workplan lock");
    if (!current?.equals(Buffer.from(lock.raw))) return;
    const currentIdentity = await fileIdentity(lockPath);
    try {
      await fs.access(releasePath);
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    await fs.rename(lockPath, releasePath);
    const moved = await readPath(root, releasePath, "Workplan lock release");
    if (!moved?.equals(Buffer.from(lock.raw)) || !sameIdentity(currentIdentity, await fileIdentity(releasePath))) {
      try {
        await fs.access(lockPath);
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") await fs.rename(releasePath, lockPath);
      }
      return;
    }
    await fs.unlink(releasePath);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
}

async function acquireMutationLocks(root: string, id: string, waitMs: number, signal?: AbortSignal, nonce: string = randomUUID()) {
  const deadline = Date.now() + waitMs;
  const workspaceLock = await acquireLock(workspaceLockPath(root), root, Math.max(0, deadline - Date.now()), signal, `${nonce}-workspace`);
  try {
    const planLock = await acquireLock(planLockPath(root, id), root, Math.max(0, deadline - Date.now()), signal, `${nonce}-plan`);
    return { workspaceLock, planLock };
  } catch (error) {
    await releaseLock(workspaceLockPath(root), root, workspaceLock);
    throw error;
  }
}

async function releaseMutationLocks(root: string, id: string, locks: { workspaceLock: { owner: LockOwner; raw: string }; planLock: { owner: LockOwner; raw: string } }): Promise<void> {
  await releaseLock(planLockPath(root, id), root, locks.planLock);
  await releaseLock(workspaceLockPath(root), root, locks.workspaceLock);
}

async function syncDirectory(path: string): Promise<"supported" | "unsupported"> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path, "r");
    await handle.sync();
    return "supported";
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBADF", "EISDIR"].includes(code ?? "")) return "unsupported";
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncDirectoryChecked(path: string, signal?: AbortSignal): Promise<"supported" | "unsupported"> {
  throwIfAborted(signal);
  const result = await syncDirectory(path);
  throwIfAborted(signal);
  return result;
}

async function stageContent(root: string, path: string, content: Buffer, mode: number, signal?: AbortSignal): Promise<void> {
  await assertSafePathAccess(root, dirname(path), "Workplan staging directory");
  await checked(fs.mkdir(dirname(path), { recursive: true }), signal);
  await assertSafePathAccess(root, path, "Workplan staging file");
  const handle = await checked(fs.open(path, "wx", mode), signal);
  try {
    await checked(handle.chmod(mode), signal);
    await checked(handle.writeFile(content), signal);
    await checked(handle.sync(), signal);
  } finally {
    await handle.close();
  }
}

async function publishStage(root: string, stage: string, target: string, exclusive: boolean, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await assertSafePathAccess(root, target, "Workplan mutation target");
  if (exclusive) {
    await checked(fs.link(stage, target), signal);
    await checked(fs.unlink(stage), signal);
  } else {
    await checked(fs.rename(stage, target), signal);
  }
  throwIfAborted(signal);
}

function parentDirectoryPaths(root: string, path: string): string[] {
  const result: string[] = [];
  let current = dirname(resolve(path));
  while (current !== root && isWithinWorkspaceRoot(root, current)) {
    result.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

function makeIntent(options: CommitOptions, transactionId: string): WorkplanMutationIntent {
  const root = resolve(options.workspaceRoot);
  const jPath = journalPath(root, options.id);
  const locks = [workspaceLockPath(root), planLockPath(root, options.id)];
  const stages = options.targets.flatMap((target, index) => target.content === null ? [] : [stagePath(target.path, transactionId, index)]);
  stages.push(journalStagePath(root, options.id, transactionId));
  const writePaths = options.targets.filter((target) => target.content !== null).map((target) => target.path);
  const deletePaths = options.targets.filter((target) => target.content === null).map((target) => target.path);
  const resourcePaths = [
    ...locks,
    ...locks.flatMap((lock) => [lockReclaimPath(lock), `${lock}.dead-${transactionId}-workspace-reclaim`, `${lock}.dead-${transactionId}-plan-reclaim`, `${lock}.release-${transactionId}-workspace`, `${lock}.release-${transactionId}-plan`]),
    jPath,
    ...stages,
    ...writePaths,
    ...deletePaths,
    ...(options.requiredAbsentPaths ?? []),
    ...(options.additionalResources ?? []),
    ...options.targets.map((target) => dirname(target.path)),
    dirname(jPath),
  ];
  const resources = [...new Set([...resourcePaths, ...resourcePaths.flatMap((path) => parentDirectoryPaths(root, path))])];
  return {
    schemaVersion: 1,
    operation: options.operation,
    workspaceRoot: root,
    workplanId: options.id,
    readPaths: [...new Set([
      ...(options.initialSnapshot ? options.initialSnapshot.stateManifest.map((entry) => join(root, entry.path)) : []),
      workplanDirectory(root),
      ...options.targets.map((target) => target.path),
      ...(options.requiredAbsentPaths ?? []),
      ...locks,
      ...locks.map((lock) => lockReclaimPath(lock)),
      ...(options.additionalResources ?? []),
    ])],
    writePaths: [...new Set([...writePaths, jPath, ...stages])],
    deletePaths,
    lockPaths: locks,
    stagingPaths: stages,
    resources,
  };
}

async function preflightDestinationClaim(root: string, id: string, destinationPath: string): Promise<void> {
  const directory = workplanDirectory(root);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return;
    throw error;
  }
  const destination = resolve(destinationPath);
  for (const entry of entries) {
    if (!entry.name.endsWith(".json") || entry.name.endsWith(".checkpoint.json") || entry.name.endsWith(".dependencies.json") || entry.name.endsWith(".transaction.json")) continue;
    const claimantId = entry.name.slice(0, -".json".length);
    if (claimantId === id) continue;
    const claimantPath = join(directory, entry.name);
    await assertSafePathAccess(root, claimantPath, "Workplan ownership candidate");
    if (!entry.isFile()) throw new Error(`Ambiguous workplan destination claim: ${claimantPath} is not a regular plan file`);
    let raw: string;
    try {
      raw = await fs.readFile(claimantPath, "utf8");
    } catch (error) {
      throw new Error(`Ambiguous workplan destination claim at ${claimantPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`Ambiguous workplan destination claim at invalid primary plan ${claimantPath}`);
    }
    const parsed = workplanDocumentSchema.safeParse(json);
    if (!parsed.success) throw new Error(`Ambiguous workplan destination claim at invalid primary plan ${claimantPath}`);
    if (parsed.data.id !== normalizeId(claimantId)) throw new Error(`Ambiguous workplan destination claim: id mismatch in ${claimantPath}`);
    let linked: string;
    try {
      linked = resolve(root, normalizePlanFile(root, parsed.data.planFile));
    } catch {
      throw new Error(`Ambiguous workplan destination claim: invalid planFile in ${claimantPath}`);
    }
    if (linked === destination) throw new Error(`Plan file destination is already owned by ${claimantId}: ${destination}`);
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".transaction.json") || entry.name === `${id}.transaction.json`) continue;
    const pendingPath = join(directory, entry.name);
    await assertSafePathAccess(root, pendingPath, "Pending workplan transaction");
    let journal: WorkplanJournal;
    let journalScope: JournalArtifactScope;
    try {
      const parsed = workplanJournalSchema.safeParse(JSON.parse(await fs.readFile(pendingPath, "utf8")));
      if (!parsed.success) throw new Error("shape");
      journal = validateJournal(parsed.data, root, parsed.data.workplanId);
      if (journal.workplanId !== entry.name.slice(0, -".transaction.json".length)) throw new Error("id mismatch");
      journalScope = validateJournalArtifactScope(journal, root, journal.workplanId, await readOptionalWorkplanSnapshot(root, journal.workplanId));
    } catch {
      throw new Error(`Ambiguous pending workplan destination claim at ${pendingPath}`);
    }
    if (journal.targets.some((target) => resolve(root, target.path) === destination) || journalScope.destinationClaims.some((path) => resolve(root, path) === destination)) {
      throw new Error(`Workplan destination is claimed by pending transaction ${journal.transactionId} for ${journal.workplanId}`);
    }
  }
}

export async function commitWorkplanMutation(options: CommitOptions): Promise<MutationResult> {
  const root = await fs.realpath(resolve(options.workspaceRoot));
  const id = options.id;
  const signal = options.signal ?? signalFor(options.invocation);
  throwIfAborted(signal);
  checkExpectedHash(options.initialSnapshot ?? null, options.expectedHash);
  const transactionId: string = options.transactionId ?? randomUUID();
  const request = { ...options, workspaceRoot: root };
  const intent = makeIntent(request, transactionId);
  await authorizeWorkplanMutation(intent, options.invocation);

  const waitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  await assertSafePathAccess(root, workplanDirectory(root), "Workplan directory");
  await checked(fs.mkdir(workplanDirectory(root), { recursive: true }), signal);
  const locks = await acquireMutationLocks(root, id, waitMs, signal, transactionId);
  let journalPublished = false;
  const stagedPaths: string[] = [];
  let directorySync: "supported" | "unsupported" = "supported";
  const journalFile = journalPath(root, id);
  try {
    throwIfAborted(signal);
    const currentSnapshot = options.initialSnapshot ? await checked(readWorkplanSnapshot(root, id), signal) : null;
    if (options.initialSnapshot && currentSnapshot?.stateHash !== options.initialSnapshot.stateHash) {
      throw new Error(`Workplan changed while mutation authorization was being granted; current stateHash is ${currentSnapshot?.stateHash}. Reread and retry.`);
    }
    checkExpectedHash(currentSnapshot, options.expectedHash);
    if (currentSnapshot?.journalContent) throw new WorkplanRecoveryRequiredError("pending", journalFile, [journalFile]);
    for (const absentPath of options.requiredAbsentPaths ?? []) {
      const current = await readPath(root, absentPath, "Workplan must-be-absent path");
      if (current !== null) throw new Error(`Refusing to overwrite existing workplan artifact: ${absentPath}`);
    }
    for (const target of options.targets) await assertSafePathAccess(root, target.path, target.label ?? "Workplan mutation target");
    await options.preflight?.(currentSnapshot);

    const existingJournal = await readPath(root, journalFile, "Workplan transaction journal");
    if (existingJournal) throw new WorkplanRecoveryRequiredError("pending", journalFile, [journalFile]);
    const directory = workplanDirectory(root);
    await checked(fs.mkdir(directory, { recursive: true }), signal);

    const journalTargets: JournalTarget[] = [];
    const targetStages: Array<{ target: MutationTarget; before: Buffer | null; after: Buffer | null; stage?: string; mode: number }> = [];
    for (const [index, target] of options.targets.entries()) {
      throwIfAborted(signal);
      const before = await checked(readPath(root, target.path, target.label ?? "Workplan mutation target"), signal);
      if (Object.hasOwn(target, "before")) {
        const expectedBefore = target.before ?? null;
        if ((expectedBefore === null) !== (before === null) || (expectedBefore && before && !expectedBefore.equals(before))) {
          throw new Error(`Workplan artifact changed before commit: ${target.path}`);
        }
      }
      const after = bytes(target.content);
      let mode = target.mode ?? 0o600;
      if (before) {
        const stats = await checked(fs.stat(target.path), signal);
        mode = target.mode ?? (stats.mode & 0o777);
      }
      const stage = after === null ? undefined : stagePath(target.path, transactionId, index);
      targetStages.push({ target, before, after, ...(stage ? { stage } : {}), mode });
      journalTargets.push({
        path: relative(root, target.path).replaceAll("\\", "/"),
        beforeHash: hashValue(before),
        afterHash: hashValue(after),
        beforeContent: before?.toString("base64") ?? null,
        afterContent: after?.toString("base64") ?? null,
        mode,
      });
    }
    const journal: WorkplanJournal = {
      schemaVersion: 1,
      transactionId,
      workplanId: id,
      operation: options.operation,
      createdAt: new Date().toISOString(),
      targets: journalTargets,
    };
    const journalRaw = `${JSON.stringify(journal, null, 2)}\n`;

    for (const item of targetStages) {
      if (!item.stage || item.after === null) continue;
      stagedPaths.push(item.stage);
      await stageContent(root, item.stage, item.after, item.mode, signal);
      await options.invocation.fault?.("artifact-staged", { transactionId, path: item.target.path });
      throwIfAborted(signal);
    }

    const journalStage = journalStagePath(root, id, transactionId);
    stagedPaths.push(journalStage);
    await stageContent(root, journalStage, Buffer.from(journalRaw), 0o600, signal);
    await options.invocation.fault?.("journal-staged", { transactionId, journalFile });
    throwIfAborted(signal);
    await assertSafePathAccess(root, journalFile, "Workplan transaction journal");
    throwIfAborted(signal);
    await fs.link(journalStage, journalFile);
    journalPublished = true;
    throwIfAborted(signal);
    await checked(fs.unlink(journalStage), signal);
    if (await syncDirectoryChecked(dirname(journalFile), signal) === "unsupported") directorySync = "unsupported";
    await options.invocation.fault?.("journal-published", { transactionId, journalFile });
    throwIfAborted(signal);

    for (const item of targetStages) {
      throwIfAborted(signal);
      const actual = await checked(readPath(root, item.target.path, item.target.label ?? "Workplan mutation target"), signal);
      if ((actual === null) !== (item.before === null) || (actual && item.before && !actual.equals(item.before))) {
        throw new Error(`External edit detected before publication of ${item.target.path}`);
      }
      if (item.after === null) {
        if (actual !== null) await checked(fs.unlink(item.target.path), signal);
      } else if (item.stage) {
        await publishStage(root, item.stage, item.target.path, item.before === null, signal);
      }
      if (await syncDirectoryChecked(dirname(item.target.path), signal) === "unsupported") directorySync = "unsupported";
      await options.invocation.fault?.("artifact-published", { transactionId, path: item.target.path });
      throwIfAborted(signal);
    }

    for (const item of targetStages) {
      const actual = await checked(readPath(root, item.target.path, item.target.label ?? "Workplan mutation target"), signal);
      if ((actual === null) !== (item.after === null) || (actual && item.after && !actual.equals(item.after))) {
        throw new Error(`Published workplan artifact did not match its staged content: ${item.target.path}`);
      }
    }
    throwIfAborted(signal);
    await options.invocation.fault?.("before-complete", { transactionId });
    throwIfAborted(signal);
    const journalBytes = await checked(readPath(root, journalFile, "Workplan transaction journal"), signal);
    if (!journalBytes?.equals(Buffer.from(journalRaw))) throw new Error("Transaction journal changed before completion; recovery evidence preserved");
    await checked(fs.unlink(journalFile), signal);
    journalPublished = false;
    if (await syncDirectoryChecked(dirname(journalFile), signal) === "unsupported") directorySync = "unsupported";
    throwIfAborted(signal);

    const snapshot = await checked(readWorkplanSnapshot(root, id), signal);
    return { snapshot, transactionId, directorySync };
  } catch (error) {
    if (journalPublished) {
      const remainingJournal = await readPath(root, journalFile, "Workplan transaction journal").catch(() => Buffer.from("invalid"));
      if (remainingJournal === null) journalPublished = false;
      else throw new WorkplanRecoveryRequiredError(transactionId, journalFile, options.targets.map((target) => target.path), error);
    }
    for (const path of stagedPaths) await fs.rm(path, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await releaseMutationLocks(root, id, locks);
  }
}

export async function assertNoPendingTransaction(snapshot: WorkplanSnapshot): Promise<void> {
  if (snapshot.journalContent) {
    const path = journalPath(snapshot.workspaceRoot, snapshot.id);
    throw new WorkplanRecoveryRequiredError("pending", path, [path]);
  }
}

export async function assertMarkdownDestinationUnclaimed(root: string, id: string, destinationPath: string): Promise<void> {
  await preflightDestinationClaim(root, id, destinationPath);
}

function validateJournal(value: unknown, root: string, id: string): WorkplanJournal {
  const parsed = workplanJournalSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid workplan transaction journal: ${parsed.error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`).join("; ")}`);
  const journal = parsed.data as WorkplanJournal;
  if (journal.workplanId !== id) throw new Error("Invalid workplan transaction journal: workplanId does not match the requested plan");
  if (normalizeId(id) !== id) throw new Error("Invalid workplan transaction journal: workplanId is not canonical");
  const seen = new Set<string>();
  for (const target of journal.targets) {
    if (seen.has(target.path)) throw new Error(`Invalid workplan transaction journal: duplicate target ${target.path}`);
    seen.add(target.path);
    if (isAbsolute(target.path)) throw new Error(`Invalid workplan transaction target is not relative: ${target.path}`);
    const path = resolve(root, target.path);
    if (!isWithinWorkspaceRoot(root, path)) throw new Error(`Invalid transaction target outside workspace: ${target.path}`);
    if (relative(root, path).replaceAll("\\", "/") !== target.path) throw new Error(`Invalid noncanonical transaction target: ${target.path}`);
    const before = decodeJournalContent(target.beforeContent, target.path, "before");
    const after = decodeJournalContent(target.afterContent, target.path, "after");
    if ((before === null) !== (target.beforeHash === null) || (before !== null && sha(before) !== target.beforeHash)) throw new Error(`Corrupt before image in transaction journal: ${target.path}`);
    if ((after === null) !== (target.afterHash === null) || (after !== null && sha(after) !== target.afterHash)) throw new Error(`Corrupt after image in transaction journal: ${target.path}`);
  }
  return journal;
}

type JournalPlanImage = { document: WorkplanDocument; planFile: string; bytes: Buffer };
type JournalArtifactKind = "plan" | "markdown" | "checkpoint" | "dependencies" | "archive";
type JournalArtifactScope = { destinationClaims: string[] };

function decodeJournalContent(content: string | null, path: string, side: "before" | "after"): Buffer | null {
  if (content === null) return null;
  const decoded = Buffer.from(content, "base64");
  if (decoded.toString("base64") !== content) throw new Error(`Invalid ${side} image encoding in transaction journal: ${path}`);
  return decoded;
}

function parseJournalPlanBytes(bytes: Buffer, root: string, id: string, source: string): JournalPlanImage {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Invalid ${source} plan JSON in transaction journal`);
  }
  const parsed = workplanDocumentSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid ${source} plan JSON in transaction journal: schema mismatch`);
  if (parsed.data.id !== id) throw new Error(`Invalid ${source} plan JSON in transaction journal: id does not match filename`);
  const planFile = normalizePlanFile(root, parsed.data.planFile).replaceAll("\\", "/");
  normalizeSpecFiles(root, parsed.data.specFiles);
  return {
    document: { ...parsed.data, planFile, specFiles: normalizeSpecFiles(root, parsed.data.specFiles) } as WorkplanDocument,
    planFile,
    bytes,
  };
}

function journalPlanImage(content: string | null, root: string, id: string, targetPath: string, side: "before" | "after"): JournalPlanImage | null {
  const bytes = decodeJournalContent(content, targetPath, side);
  return bytes === null ? null : parseJournalPlanBytes(bytes, root, id, side);
}

async function readOptionalWorkplanSnapshot(root: string, id: string): Promise<WorkplanSnapshot | undefined> {
  try {
    return await readWorkplanSnapshot(root, id);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`Workplan file not found: ${workplanPath(root, id)}`)) return undefined;
    throw error;
  }
}

function parseJsonImage(bytes: Buffer | null, path: string, side: "before" | "after"): unknown {
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Invalid ${side} JSON sidecar in transaction journal: ${path}`);
  }
}

function journalTextMatches(value: unknown, content: Buffer | null): boolean {
  return value === null ? content === null : typeof value === "string" && content !== null && value === content.toString("utf8");
}

function validateArchiveTarget(
  target: JournalTarget,
  journal: WorkplanJournal,
  root: string,
  id: string,
  jsonTarget: JournalTarget,
  beforePlan: JournalPlanImage | null,
  snapshot: WorkplanSnapshot | undefined,
): void {
  const archivePattern = new RegExp(`^\\.opencode/workplan/archive/${id}/state-[a-f0-9]{12}-([a-f0-9]{12})\\.json$`);
  const archivePathMatch = archivePattern.exec(target.path);
  if (!archivePathMatch || target.beforeContent !== null || target.afterContent === null) {
    throw new Error(`Invalid workplan archive transaction target: ${target.path}`);
  }
  const archiveBytes = decodeJournalContent(target.afterContent, target.path, "after");
  const archive = parseJsonImage(archiveBytes, target.path, "after");
  if (!archive || typeof archive !== "object" || Array.isArray(archive)) throw new Error("Invalid workplan archive payload in transaction journal");
  const value = archive as Record<string, unknown>;
  const token = typeof value.previewToken === "string" ? /^v1-([a-f0-9]{64})$/.exec(value.previewToken) : null;
  if (value.archiveVersion !== 1 || value.workplanId !== id || typeof value.reason !== "string" || !value.reason.trim() || !token || token[1]?.slice(0, 12) !== archivePathMatch[1] || journal.transactionId !== token[1]?.slice(0, 16)) {
    throw new Error("Invalid workplan archive identity in transaction journal");
  }
  const source = value.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Invalid workplan archive source in transaction journal");
  const removed = value.removed;
  if (!removed || typeof removed !== "object" || Array.isArray(removed)) throw new Error("Invalid workplan archive removal record in transaction journal");
  const removals = removed as Record<string, unknown>;
  const phases = removals.completedPhaseIds;
  const noteIndexes = removals.noteIndexes;
  const findingIndexes = removals.resolvedFindingIndexes;
  if (!Array.isArray(phases) || !Array.isArray(noteIndexes) || !Array.isArray(findingIndexes) || !phases.every((phase) => Boolean(phase && typeof phase === "object" && typeof (phase as Record<string, unknown>).id === "string")) || !noteIndexes.every((index) => Number.isInteger(index) && (index as number) >= 0) || !findingIndexes.every((index) => Number.isInteger(index) && (index as number) >= 0) || typeof removals.digest !== "string") {
    throw new Error("Invalid workplan archive selection in transaction journal");
  }
  const originalJson = decodeJournalContent(jsonTarget.beforeContent, jsonTarget.path, "before");
  if (!originalJson || typeof (source as Record<string, unknown>).workplanJson !== "string" || !Buffer.from((source as Record<string, unknown>).workplanJson as string, "utf8").equals(originalJson)) {
    throw new Error("Workplan archive JSON does not match its transaction before image");
  }
  const archivedPlan = parseJournalPlanBytes(originalJson, root, id, "archived");
  const phaseIds = phases.map((phase) => (phase as Record<string, unknown>).id as string);
  const removalDigest = sha(JSON.stringify({ phaseIds, noteIndexes, findingIndexes }));
  if (removals.digest !== removalDigest || phaseIds.some((phaseId) => {
    const phase = archivedPlan.document.phases.find((candidate) => candidate.id === phaseId);
    return !phase || phase.status !== "completed" || phase.steps.length === 0 || phase.steps.some((step) => step.status !== "completed");
  }) || noteIndexes.some((index) => (index as number) >= archivedPlan.document.notes.length) || findingIndexes.some((index) => {
    const finding = archivedPlan.document.reviewFindings[index as number];
    return !finding || finding.status !== "resolved";
  })) {
    throw new Error("Workplan archive removals do not match its source plan");
  }
  const originalMarkdownTarget = journal.targets.find((item) => item.path === archivedPlan.planFile);
  const markdownBytes = originalMarkdownTarget
    ? decodeJournalContent(originalMarkdownTarget.beforeContent, originalMarkdownTarget.path, "before")
    : snapshot?.planContent ?? null;
  const checkpointTarget = journal.targets.find((item) => item.path === relative(root, checkpointPath(root, id)).replaceAll("\\", "/"));
  const checkpointBytes = checkpointTarget ? decodeJournalContent(checkpointTarget.beforeContent, checkpointTarget.path, "before") : snapshot?.checkpointContent ?? null;
  const dependencyTarget = journal.targets.find((item) => item.path === relative(root, dependencyPath(root, id)).replaceAll("\\", "/"));
  const dependencyBytes = dependencyTarget ? decodeJournalContent(dependencyTarget.beforeContent, dependencyTarget.path, "before") : snapshot?.dependencyContent ?? null;
  const sourceValue = source as Record<string, unknown>;
  if (sourceValue.workplanJsonPath !== jsonTarget.path || sourceValue.linkedMarkdownPath !== archivedPlan.planFile || sourceValue.checkpointPath !== relative(root, checkpointPath(root, id)).replaceAll("\\", "/") || sourceValue.dependencyPath !== relative(root, dependencyPath(root, id)).replaceAll("\\", "/") || !journalTextMatches(sourceValue.linkedMarkdown, markdownBytes) || !journalTextMatches(sourceValue.checkpoint, checkpointBytes) || !journalTextMatches(sourceValue.dependencies, dependencyBytes)) {
    throw new Error("Workplan archive sidecars or linked Markdown do not match transaction before images");
  }
  if (beforePlan && beforePlan.planFile !== archivedPlan.planFile) throw new Error("Workplan archive does not match the plan file before compaction");
}

function validateJournalArtifactScope(journal: WorkplanJournal, root: string, id: string, snapshot?: WorkplanSnapshot): JournalArtifactScope {
  if (journal.workplanId !== id || (snapshot && snapshot.id !== id)) throw new Error("Invalid workplan transaction journal identity");
  const planPath = relative(root, workplanPath(root, id)).replaceAll("\\", "/");
  const checkpointFile = relative(root, checkpointPath(root, id)).replaceAll("\\", "/");
  const dependenciesFile = relative(root, dependencyPath(root, id)).replaceAll("\\", "/");
  const jsonTarget = journal.targets.find((target) => target.path === planPath);
  let beforePlan: JournalPlanImage | null = null;
  let afterPlan: JournalPlanImage | null = null;
  if (jsonTarget) {
    beforePlan = journalPlanImage(jsonTarget.beforeContent, root, id, jsonTarget.path, "before");
    afterPlan = journalPlanImage(jsonTarget.afterContent, root, id, jsonTarget.path, "after");
    if (!afterPlan) throw new Error("Workplan transaction cannot delete its primary plan JSON");
    if (snapshot) {
      const snapshotJson = snapshot.planManifest.find((entry) => entry.path === planPath);
      if (!snapshotJson?.sha256 || (snapshotJson.sha256 !== jsonTarget.beforeHash && snapshotJson.sha256 !== jsonTarget.afterHash)) {
        throw new Error("Journaled plan JSON does not match the trusted current snapshot");
      }
      if (![beforePlan?.planFile, afterPlan.planFile].includes(snapshot.document.planFile)) {
        throw new Error("Journaled plan linkage does not match the trusted current snapshot");
      }
    } else if (beforePlan || jsonTarget.beforeHash !== null) {
      throw new Error("A transaction with an existing plan JSON requires a trusted current snapshot");
    }
  } else if (!snapshot) {
    throw new Error("A transaction without its plan JSON requires a trusted current snapshot");
  }

  const linkedMarkdown = new Set<string>();
  if (beforePlan) linkedMarkdown.add(beforePlan.planFile);
  if (afterPlan) linkedMarkdown.add(afterPlan.planFile);
  if (snapshot) linkedMarkdown.add(normalizePlanFile(root, snapshot.document.planFile).replaceAll("\\", "/"));
  const kinds = new Set<JournalArtifactKind>();
  const semanticPaths = new Set<string>();
  const kindCounts = new Map<JournalArtifactKind, number>();
  const archiveTargets: JournalTarget[] = [];
  for (const target of journal.targets) {
    let kind: JournalArtifactKind | undefined;
    if (target.path === planPath) kind = "plan";
    else if (target.path === checkpointFile) kind = "checkpoint";
    else if (target.path === dependenciesFile) kind = "dependencies";
    else if (linkedMarkdown.has(target.path)) kind = "markdown";
    else if (new RegExp(`^\\.opencode/workplan/archive/${id}/state-[a-f0-9]{12}-[a-f0-9]{12}\\.json$`).test(target.path)) kind = "archive";
    if (!kind) throw new Error(`Invalid workplan transaction journal target is not a permitted workplan artifact: ${target.path}`);
    const semanticPath = `${kind}:${target.path}`;
    if (semanticPaths.has(semanticPath)) throw new Error(`Invalid workplan transaction journal: duplicate semantic target ${target.path}`);
    semanticPaths.add(semanticPath);
    const kindCount = (kindCounts.get(kind) ?? 0) + 1;
    if (kindCount > 1) throw new Error(`Invalid workplan transaction journal: duplicate semantic target kind ${kind}`);
    kindCounts.set(kind, kindCount);
    kinds.add(kind);
    if (kind === "archive") archiveTargets.push(target);
    if (kind === "checkpoint") {
      if (target.afterContent === null) throw new Error("Workplan transaction cannot delete its checkpoint sidecar");
      const checkpoint = workplanCheckpointSchema.safeParse(parseJsonImage(decodeJournalContent(target.afterContent, target.path, "after"), target.path, "after"));
      if (!checkpoint.success || checkpoint.data.id !== id) throw new Error("Invalid checkpoint after image in transaction journal");
    }
    if (kind === "dependencies") {
      if (target.afterContent === null) throw new Error("Workplan transaction cannot delete its dependency sidecar");
      const after = decodeJournalContent(target.afterContent, target.path, "after");
      const sidecar = workplanDependenciesSchema.safeParse(parseJsonImage(after, target.path, "after"));
      if (!sidecar.success || sidecar.data.id !== id) throw new Error("Invalid dependency after image in transaction journal");
      const plan = afterPlan?.document ?? snapshot?.document;
      if (!plan) throw new Error("Dependency transaction requires a trusted plan document");
      const dependencyCheck = validateDependencyRecords(after, id, plan);
      if (dependencyCheck.issues.length) throw new Error(`Invalid dependency after image in transaction journal: ${dependencyCheck.issues.join("; ")}`);
    }
  }

  const operation = journal.operation;
  const has = (kind: JournalArtifactKind) => kinds.has(kind);
  if (operation === "create" && (!jsonTarget || jsonTarget.beforeContent !== null || !has("plan") || !has("markdown") || has("checkpoint") || has("dependencies") || has("archive") || journal.targets.some((target) => target.path !== planPath && target.beforeContent !== null))) {
    throw new Error("Invalid create transaction artifact set");
  }
  if (operation === "create:overwrite" && (!jsonTarget || jsonTarget.beforeContent === null || !beforePlan || !afterPlan || beforePlan.planFile !== afterPlan.planFile || !has("plan") || !has("markdown") || has("checkpoint") || has("dependencies") || has("archive"))) {
    throw new Error("Invalid create:overwrite transaction artifact set");
  }
  if ((operation === "create" || operation === "create:overwrite") && (!has("plan") || !has("markdown") || has("checkpoint") || has("dependencies") || has("archive"))) {
    throw new Error(`Invalid ${operation} transaction artifact set`);
  }
  if (operation === "update" && (!jsonTarget || !beforePlan || !has("plan") || has("checkpoint") || has("archive"))) throw new Error("Invalid update transaction artifact set");
  if (operation === "patch" && (journal.targets.length !== 1 || !has("markdown") || journal.targets[0]?.beforeContent === null)) throw new Error("Invalid patch transaction artifact set");
  if (operation === "reset:draft" && (!jsonTarget || !beforePlan || !afterPlan || beforePlan.planFile !== afterPlan.planFile || !has("plan") || has("checkpoint") || has("dependencies") || has("archive"))) throw new Error("Invalid draft reset transaction artifact set");
  if (operation === "reset:markdown-only" && (journal.targets.length !== 1 || !has("markdown"))) throw new Error("Invalid Markdown-only reset transaction artifact set");
  if (operation === "checkpoint" && (journal.targets.length !== 1 || !has("checkpoint"))) throw new Error("Invalid checkpoint transaction artifact set");
  if (operation === "compact:apply") {
    const checkpointTarget = journal.targets.find((target) => target.path === checkpointFile);
    const checkpointBefore = checkpointTarget?.beforeContent === null || checkpointTarget?.beforeContent === undefined
      ? null
      : workplanCheckpointSchema.safeParse(parseJsonImage(decodeJournalContent(checkpointTarget.beforeContent, checkpointFile, "before"), checkpointFile, "before"));
    if (!jsonTarget || !beforePlan || !afterPlan || !has("plan") || !has("checkpoint") || !has("archive") || archiveTargets.length !== 1 || !checkpointBefore?.success || checkpointBefore.data.schemaVersion !== 2 || checkpointBefore.data.id !== id) {
      throw new Error("Invalid compaction transaction artifact set");
    }
  }
  if (archiveTargets.length && operation !== "compact:apply") throw new Error("Only compaction may publish a workplan archive");
  for (const archive of archiveTargets) {
    if (!jsonTarget) throw new Error("Workplan archive requires its plan JSON transaction target");
    validateArchiveTarget(archive, journal, root, id, jsonTarget, beforePlan, snapshot);
  }
  const linkedPlanMoved = Boolean(beforePlan && afterPlan && beforePlan.planFile !== afterPlan.planFile);
  if (operation === "compact:apply" && linkedPlanMoved) throw new Error("Compaction cannot move the linked plan file");
  if (linkedPlanMoved) {
    const afterMarkdown = journal.targets.find((target) => target.path === afterPlan!.planFile);
    if (!afterMarkdown || afterMarkdown.beforeContent !== null || afterMarkdown.beforeHash !== null || afterMarkdown.afterContent === null || afterMarkdown.afterHash === null) {
      throw new Error("Invalid workplan planFile move: the exact after-linked Markdown target must have an absent before image and a non-null after image");
    }
  }

  const destinationClaims = beforePlan === null && afterPlan
    ? [afterPlan.planFile]
    : beforePlan && afterPlan && beforePlan.planFile !== afterPlan.planFile
      ? [afterPlan.planFile]
      : [];
  return { destinationClaims };
}

export async function recoverWorkplanTransaction(options: {
  workspaceRoot: string;
  id: string;
  recovery: "resume" | "rollback";
  expectedHash?: string;
  initialSnapshot: WorkplanSnapshot;
  invocation: WorkplanMutationInvocation;
  lockWaitMs?: number;
}): Promise<MutationResult> {
  const root = await fs.realpath(resolve(options.workspaceRoot));
  const signal = signalFor(options.invocation);
  throwIfAborted(signal);
  const journalFile = journalPath(root, options.id);
  if (!options.initialSnapshot.journalContent) throw new Error(`No pending transaction to ${options.recovery} for ${options.id}`);
  checkExpectedHash(options.initialSnapshot, options.expectedHash);
  const journal = validateJournal(JSON.parse(options.initialSnapshot.journalContent.toString("utf8")), root, options.id);
  const journalScope = validateJournalArtifactScope(journal, root, options.id, options.initialSnapshot);
  for (const target of journal.targets) await assertSafePathAccess(root, resolve(root, target.path), "Workplan recovery target");
  const transactionId = `recovery-${randomUUID()}`;
  const paths = journal.targets.map((target) => resolve(root, target.path));
  const desired = journal.targets.map((target) => BufferFromJournal(options.recovery === "resume" ? target.afterContent : target.beforeContent));
  const recoveryStages = paths.map((path, index) => desired[index] === null ? null : stagePath(path, transactionId, index));
  const stagePaths = recoveryStages.filter((path): path is string => path !== null);
  const locksPaths = [workspaceLockPath(root), planLockPath(root, options.id)];
  const deletePaths = paths.filter((_path, index) => desired[index] === null);
  const recoveryResourcePaths = [
    ...paths,
    journalFile,
    ...stagePaths,
    ...locksPaths,
    ...locksPaths.map((lock) => lockReclaimPath(lock)),
    ...locksPaths.map((lock, index) => `${lock}.release-${transactionId}-${index === 0 ? "workspace" : "plan"}`),
    ...deletePaths,
    ...paths.map((path) => dirname(path)),
    workplanDirectory(root),
  ];
  const intent: WorkplanMutationIntent = {
    schemaVersion: 1,
    operation: `recovery:${options.recovery}`,
    workspaceRoot: root,
    workplanId: options.id,
    readPaths: [...new Set([
      ...options.initialSnapshot.stateManifest.map((entry) => join(root, entry.path)),
      ...paths,
      journalFile,
      ...locksPaths,
      ...locksPaths.map((lock) => lockReclaimPath(lock)),
      workplanDirectory(root),
    ])],
    writePaths: [...paths.filter((_path, index) => desired[index] !== null), ...stagePaths],
    deletePaths: [...deletePaths, journalFile],
    lockPaths: locksPaths,
    stagingPaths: stagePaths,
    resources: [...new Set([...recoveryResourcePaths, ...recoveryResourcePaths.flatMap((path) => parentDirectoryPaths(root, path))])],
  };
  await authorizeWorkplanMutation(intent, options.invocation);
  await fs.mkdir(workplanDirectory(root), { recursive: true });
  const locks = await acquireMutationLocks(root, options.id, options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS, signal, transactionId);
  const staged: string[] = [];
  let directorySync: "supported" | "unsupported" = "supported";
  let pending = true;
  try {
    const currentSnapshot = await checked(readWorkplanSnapshot(root, options.id), signal);
    if (currentSnapshot.stateHash !== options.initialSnapshot.stateHash) throw new Error(`Workplan changed before recovery; current stateHash is ${currentSnapshot.stateHash}`);
    checkExpectedHash(currentSnapshot, options.expectedHash);
    for (const destination of journalScope.destinationClaims) {
      await preflightDestinationClaim(root, options.id, resolve(root, destination));
    }
    const currentContents: Array<Buffer | null> = [];
    for (const target of journal.targets) {
      const targetPath = resolve(root, target.path);
      const current = await checked(readPath(root, targetPath, "Recovery target"), signal);
      const currentHash = hashValue(current);
      if (currentHash !== target.beforeHash && currentHash !== target.afterHash) {
        throw new Error(`External edit at ${target.path}; expected before or after hash, found ${currentHash ?? "missing"}; journal evidence preserved`);
      }
      currentContents.push(current);
    }
    for (const [index, target] of journal.targets.entries()) {
      const targetPath = resolve(root, target.path);
      const existing = currentContents[index] ?? null;
      const wanted = desired[index] ?? null;
      if ((existing === null) === (wanted === null) && (!existing || !wanted || existing.equals(wanted))) continue;
      const stage = recoveryStages[index];
      if (wanted) {
        if (!stage) throw new Error(`Missing authorized recovery stage for ${target.path}`);
        staged.push(stage);
        await stageContent(root, stage, wanted, target.mode, signal);
      }
    }

    for (const [index, target] of journal.targets.entries()) {
      throwIfAborted(signal);
      const targetPath = resolve(root, target.path);
      const actual = await checked(readPath(root, targetPath, "Recovery target"), signal);
      const initial = currentContents[index] ?? null;
      const wanted = desired[index] ?? null;
      if ((actual === null) === (wanted === null) && (!actual || !wanted || actual.equals(wanted))) continue;
      if ((actual === null) !== (initial === null) || (actual && initial && !actual.equals(initial))) {
        throw new Error(`Recovery target changed during publication: ${target.path}; journal evidence preserved`);
      }
      if (wanted === null) {
        if (actual) await checked(fs.unlink(targetPath), signal);
      } else {
        const stage = recoveryStages[index];
        if (!stage) throw new Error(`Missing authorized recovery stage for ${target.path}`);
        await publishStage(root, stage, targetPath, actual === null, signal);
      }
      if (await syncDirectoryChecked(dirname(targetPath), signal) === "unsupported") directorySync = "unsupported";
      await options.invocation.fault?.("recovery-artifact-published", { transactionId: journal.transactionId, path: target.path });
      throwIfAborted(signal);
    }

    const journalRaw = await checked(readPath(root, journalFile, "Workplan transaction journal"), signal);
    if (!journalRaw?.equals(options.initialSnapshot.journalContent)) throw new Error("Transaction journal changed during recovery; evidence preserved");
    throwIfAborted(signal);
    await checked(fs.unlink(journalFile), signal);
    if (await syncDirectoryChecked(dirname(journalFile), signal) === "unsupported") directorySync = "unsupported";
    pending = false;
    throwIfAborted(signal);
    const snapshot = await checked(readWorkplanSnapshot(root, options.id), signal);
    return { snapshot, transactionId: journal.transactionId, directorySync };
  } catch (error) {
    if (pending) {
      const remainingJournal = await readPath(root, journalFile, "Workplan transaction journal").catch(() => Buffer.from("invalid"));
      if (remainingJournal !== null) throw new WorkplanRecoveryRequiredError(journal.transactionId, journalFile, paths, error);
      pending = false;
    }
    throw error;
  } finally {
    if (!pending) for (const path of staged) await fs.rm(path, { force: true }).catch(() => undefined);
    await releaseMutationLocks(root, options.id, locks);
  }
}

function BufferFromJournal(value: string | null): Buffer | null {
  return value === null ? null : Buffer.from(value, "base64");
}

export function createSnapshotManifestHash(manifest: WorkplanManifestEntry[]): string {
  return manifestStateHash(manifest);
}
