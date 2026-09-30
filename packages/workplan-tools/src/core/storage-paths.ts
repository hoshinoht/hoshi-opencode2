import { basename, dirname, join } from "node:path";

import { normalizeId, workplanDirectory } from "./shared";

export function checkpointPath(workspaceRoot: string, id: string): string {
  return join(workplanDirectory(workspaceRoot), `${normalizeId(id)}.checkpoint.json`);
}

export function dependencyPath(workspaceRoot: string, id: string): string {
  return join(workplanDirectory(workspaceRoot), `${normalizeId(id)}.dependencies.json`);
}

export function journalPath(workspaceRoot: string, id: string): string {
  return join(workplanDirectory(workspaceRoot), `${normalizeId(id)}.transaction.json`);
}

export function workspaceLockPath(workspaceRoot: string): string {
  return join(workplanDirectory(workspaceRoot), ".workspace-mutation.lock");
}

export function planLockPath(workspaceRoot: string, id: string): string {
  return join(workplanDirectory(workspaceRoot), `.${normalizeId(id)}.lock`);
}

export function stagePath(targetPath: string, transactionId: string, index: number): string {
  return join(dirname(targetPath), `.${basename(targetPath)}.${transactionId}.${index}.stage`);
}

export function journalStagePath(workspaceRoot: string, id: string, transactionId: string): string {
  return join(workplanDirectory(workspaceRoot), `.${normalizeId(id)}.transaction.${transactionId}.stage`);
}

export function archivePath(workspaceRoot: string, id: string, timestamp: string, nonce: string): string {
  return join(workplanDirectory(workspaceRoot), "archive", normalizeId(id), `${timestamp}-${nonce}.json`);
}

export function lockReclaimPath(lockPath: string): string {
  return `${lockPath}.reclaim`;
}
