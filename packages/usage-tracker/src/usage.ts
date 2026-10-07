import { getAuthTokens, type AuthTokens } from "./auth.ts";
import { isProviderName, type ProviderName } from "./constants.ts";
import type { UsageData } from "./format.ts";
import { fetchCopilotUsage } from "./providers/copilot.ts";
import { fetchOpenAIUsage } from "./providers/openai.ts";
import { fetchAnthropicUsage } from "./providers/anthropic.ts";
import type { ProviderRequestOptions } from "./providers/request.ts";

export type UsageResult =
  | { kind: "ok"; provider: ProviderName; providers: UsageData[] }
  | { kind: "empty"; provider: ProviderName; message: string }
  | { kind: "error"; provider: ProviderName; message: string };

export interface UsageFetchOptions extends ProviderRequestOptions {
  auth?: AuthTokens;
  readAuth?: () => Promise<AuthTokens>;
  copilot?: typeof fetchCopilotUsage;
  openai?: typeof fetchOpenAIUsage;
  anthropic?: typeof fetchAnthropicUsage;
}

function isConfigured(tokens: AuthTokens, provider: ProviderName): boolean {
  if (provider === "copilot") return Boolean(tokens.copilot?.accessToken);
  if (provider === "openai") return Boolean(tokens.openai?.accessToken);
  if (provider === "anthropic") return Boolean(tokens.anthropic?.accessToken);
  return Boolean(tokens.copilot?.accessToken || tokens.openai?.accessToken || tokens.anthropic?.accessToken);
}

function failureData(provider: string, reason: unknown): UsageData {
  return {
    provider,
    windows: [],
    // Do not copy arbitrary thrown messages: a custom transport must not be
    // able to surface an access token through the TUI.
    error: reason instanceof Error && reason.message === "Request timed out" ? "Request timed out" : "Request failed",
  };
}

/** Fetch one provider or all configured providers; failures remain visible as rows. */
export async function fetchUsageResult(
  provider: ProviderName,
  options: UsageFetchOptions = {},
): Promise<UsageResult> {
  if (!isProviderName(provider)) {
    return { kind: "error", provider: "all", message: "Unknown usage provider." };
  }

  let tokens: AuthTokens;
  try {
    tokens =
      options.auth ??
      (options.readAuth ? await options.readAuth() : await getAuthTokens());
  } catch {
    return { kind: "error", provider, message: "Unable to read authentication data." };
  }

  if (!isConfigured(tokens, provider)) {
    return {
      kind: provider === "all" ? "empty" : "error",
      provider,
      message:
        provider === "all"
          ? "No providers configured. Authenticate with Copilot, OpenAI/Codex, or Anthropic first."
          : `Provider not configured: ${provider}`,
    };
  }

  const copilot = options.copilot ?? fetchCopilotUsage;
  const openai = options.openai ?? fetchOpenAIUsage;
  const anthropic = options.anthropic ?? fetchAnthropicUsage;
  const requests: Array<{ name: string; request: Promise<UsageData> }> = [];

  if ((provider === "all" || provider === "copilot") && tokens.copilot?.accessToken) {
    requests.push({
      name: "GitHub Copilot",
      request: copilot(tokens.copilot.accessToken, options),
    });
  }
  if ((provider === "all" || provider === "openai") && tokens.openai?.accessToken) {
    requests.push({
      name: "OpenAI/Codex",
      request: openai(tokens.openai.accessToken, tokens.openai.accountId, options),
    });
  }

  if ((provider === "all" || provider === "anthropic") && tokens.anthropic?.accessToken) {
    requests.push({
      name: "Anthropic",
      request: anthropic(tokens.anthropic.accessToken, options),
    });
  }

  const providers: UsageData[] = [];
  const settled = await Promise.allSettled(requests.map(({ request }) => request));
  settled.forEach((result, index) => {
    const request = requests[index];
    if (!request) return;
    providers.push(result.status === "fulfilled" ? result.value : failureData(request.name, result.reason));
  });

  return { kind: "ok", provider, providers };
}

export { isProviderName };
export type { ProviderName };
