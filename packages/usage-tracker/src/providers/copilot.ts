import { formatRelativeTime, type UsageData } from "../format.ts";
import { requestJson, type ProviderRequestOptions, UsageRequestError } from "./request.ts";

export const COPILOT_USAGE_ENDPOINT = "https://api.github.com/copilot_internal/user";

interface QuotaSnapshot {
  quota_id?: unknown;
  remaining?: unknown;
  entitlement?: unknown;
  percent_remaining?: unknown;
  unlimited?: unknown;
}

interface CopilotUserResponse {
  copilot_plan?: unknown;
  access_type_sku?: unknown;
  quota_reset_date?: unknown;
  quota_reset_date_utc?: unknown;
  quota_snapshots?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function resetDate(data: CopilotUserResponse): Date | undefined {
  const utc = typeof data.quota_reset_date_utc === "string" ? data.quota_reset_date_utc : undefined;
  const dateOnly = typeof data.quota_reset_date === "string" ? data.quota_reset_date : undefined;
  const value = utc ?? (dateOnly ? `${dateOnly}T00:00:00Z` : undefined);
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function planType(data: CopilotUserResponse): string {
  const plan = typeof data.copilot_plan === "string" && data.copilot_plan.length > 0 ? data.copilot_plan : "Free";
  if (data.access_type_sku === "free_educational_quota") return "Education";
  if (plan === "individual") return "Pro";
  return plan;
}

function addQuotaWindow(
  windows: UsageData["windows"],
  extras: Record<string, string>,
  label: string,
  raw: unknown,
  reset: string | undefined,
  includeDetails: boolean,
): void {
  const quota = asRecord(raw) as QuotaSnapshot | undefined;
  if (!quota || quota.unlimited === true) return;
  const entitlement = finiteNumber(quota.entitlement);
  const remaining = finiteNumber(quota.remaining);
  if (entitlement === undefined || remaining === undefined || entitlement <= 0) return;

  const used = Math.max(0, entitlement - remaining);
  windows.push({ label, usedPercent: Math.max(0, Math.min(100, (used / entitlement) * 100)), resetTime: reset });
  if (includeDetails) {
    extras.Requests = `${used}/${entitlement} used`;
    extras.Remaining = `${Math.max(0, remaining)} requests`;
  }
}

/** Parse a Copilot response without network or filesystem access. */
export function parseCopilotUsage(value: unknown, now = new Date()): UsageData {
  const data = asRecord(value) as CopilotUserResponse | undefined;
  if (!data) return { provider: "GitHub Copilot", windows: [], error: "Invalid usage response" };

  const snapshots = asRecord(data.quota_snapshots);
  const reset = resetDate(data);
  const resetTime = reset ? formatRelativeTime(reset, { now }) : undefined;
  const windows: UsageData["windows"] = [];
  const extra: Record<string, string> = {};

  addQuotaWindow(windows, extra, "Premium", snapshots?.premium_interactions, resetTime, true);
  addQuotaWindow(windows, extra, "Chat", snapshots?.chat, undefined, false);
  if (windows.length === 0) extra.Status = "Unlimited";

  return {
    provider: "GitHub Copilot",
    planType: planType(data),
    windows,
    extra,
  };
}

export async function fetchCopilotUsage(
  accessToken: string,
  options: ProviderRequestOptions = {},
): Promise<UsageData> {
  try {
    const { response, data } = await requestJson(
      COPILOT_USAGE_ENDPOINT,
      {
        method: "GET",
        headers: {
          Authorization: `token ${accessToken}`,
          Accept: "application/json",
          "Editor-Version": "vscode/1.96.2",
          "X-Github-Api-Version": "2025-04-01",
          "User-Agent": "opencode-usage-tracker/1.0.0",
        },
      },
      options,
    );
    if (!response.ok) {
      return {
        provider: "GitHub Copilot",
        windows: [],
        error: response.status === 401 ? "Token expired or invalid" : `HTTP ${response.status}`,
      };
    }
    return parseCopilotUsage(data, options.now?.() ?? new Date());
  } catch (error) {
    return {
      provider: "GitHub Copilot",
      windows: [],
      error: error instanceof UsageRequestError ? error.message : "Request failed",
    };
  }
}
