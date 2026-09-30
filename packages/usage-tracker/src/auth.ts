import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AuthTokens {
  copilot?: {
    accessToken: string;
  };
  openai?: {
    accessToken: string;
    accountId?: string;
  };
}

export interface AuthPathOptions {
  home?: string;
  xdgDataHome?: string;
  platform?: string;
}

export type AuthFileReader = (path: string, encoding: "utf8") => Promise<string>;

export interface AuthReadOptions extends AuthPathOptions {
  paths?: readonly string[];
  readFile?: AuthFileReader;
}

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as RecordValue;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function providerRecords(root: RecordValue, names: readonly string[]): RecordValue[] {
  const records: RecordValue[] = [];
  for (const name of names) {
    const record = asRecord(root[name]);
    if (record) records.push(record);
  }
  return records;
}

function firstString(records: readonly RecordValue[], names: readonly string[]): string | undefined {
  for (const record of records) {
    for (const name of names) {
      const value = nonEmptyString(record[name]);
      if (value) return value;
    }
  }
  return undefined;
}

/** Normalize a live V2 OpenAI OAuth credential resolved by the integration API. */
export function normalizeOpenAICredential(
  value: unknown,
  fallbackAccountId?: string,
): AuthTokens["openai"] | undefined {
  const credential = asRecord(value);
  if (!credential || credential.type !== "oauth") return undefined;
  const accessToken = nonEmptyString(credential.access);
  if (!accessToken) return undefined;
  const metadata = asRecord(credential.metadata);
  const accountId =
    firstString(metadata ? [metadata] : [], ["accountId", "account_id", "chatgptAccountId"]) ??
    nonEmptyString(fallbackAccountId);
  return {
    accessToken,
    ...(accountId ? { accountId } : {}),
  };
}

/** Prefer a refreshed V2 integration credential while preserving other providers. */
export function mergeRuntimeOpenAI(tokens: AuthTokens, credential: unknown): AuthTokens {
  const openai = normalizeOpenAICredential(credential, tokens.openai?.accountId);
  return openai ? { ...tokens, openai } : tokens;
}

/**
 * Normalize the provider entries used by OpenCode's auth.json without
 * retaining or printing any unrelated credential fields.
 */
export function normalizeAuth(value: unknown): AuthTokens {
  const root = asRecord(value);
  if (!root) return {};

  const copilotRecords = providerRecords(root, ["copilot", "github-copilot", "githubCopilot"]);
  const copilotAccess = firstString(copilotRecords, ["access", "accessToken", "token", "key"]);

  const openaiRecords = providerRecords(root, ["openai", "chatgpt", "openai-codex", "codex"]);
  const openaiAccess = firstString(openaiRecords, ["access", "accessToken", "token", "key"]);
  const accountId = firstString(openaiRecords, ["accountId", "account_id", "chatgptAccountId"]);

  return {
    ...(copilotAccess ? { copilot: { accessToken: copilotAccess } } : {}),
    ...(openaiAccess
      ? {
          openai: {
            accessToken: openaiAccess,
            ...(accountId ? { accountId } : {}),
          },
        }
      : {}),
  };
}

/** Return the platform-specific locations in which OpenCode stores auth.json. */
export function getAuthJsonPaths(options: AuthPathOptions = {}): string[] {
  const home = options.home ?? homedir();
  const xdgDataHome = options.xdgDataHome ?? process.env.XDG_DATA_HOME;
  const platform = options.platform ?? process.platform;
  const paths: string[] = [];

  const add = (path: string) => {
    if (!paths.includes(path)) paths.push(path);
  };

  if (platform === "darwin") add(join(home, "Library", "Application Support", "opencode", "auth.json"));
  if (xdgDataHome) add(join(xdgDataHome, "opencode", "auth.json"));
  add(join(home, ".local", "share", "opencode", "auth.json"));
  if (platform !== "darwin") add(join(home, "Library", "Application Support", "opencode", "auth.json"));

  return paths;
}

/** Read and normalize the first readable auth.json; failures intentionally fail closed. */
export async function readAuthTokens(options: AuthReadOptions = {}): Promise<AuthTokens> {
  const paths = options.paths ?? getAuthJsonPaths(options);
  const reader = options.readFile ?? (readFile as unknown as AuthFileReader);

  for (const path of paths) {
    try {
      const content = await reader(path, "utf8");
      return normalizeAuth(JSON.parse(content));
    } catch {
      // Missing, unreadable, and malformed files are indistinguishable here.
      continue;
    }
  }

  return {};
}

export const getAuthTokens = readAuthTokens;
