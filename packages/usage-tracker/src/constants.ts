export type ProviderName = "all" | "copilot" | "openai";

export const PROVIDER_NAMES: readonly ProviderName[] = ["all", "copilot", "openai"];

export const PLUGIN_ID = "usage-tracker";
export const TUI_PLUGIN_ID = "usage-tracker.tui";

export function providerLabel(provider: ProviderName): string {
  switch (provider) {
    case "all":
      return "All Providers";
    case "copilot":
      return "GitHub Copilot";
    case "openai":
      return "OpenAI/Codex";
  }
}

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && PROVIDER_NAMES.includes(value as ProviderName);
}
