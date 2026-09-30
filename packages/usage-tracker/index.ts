import usageTracker from "./src/index.ts";

export { PLUGIN_ID } from "./src/index.ts";
export {
  fetchUsageResult,
  isProviderName,
  type UsageFetchOptions,
  type UsageResult,
} from "./src/usage.ts";
export {
  formatError,
  formatNoProviders,
  formatRelativeTime,
  formatUsageResult,
  formatUsageTable,
  getUsageIndicator,
  progressBar,
  type UsageData,
  type UsageWindow,
} from "./src/format.ts";
export {
  getAuthJsonPaths,
  getAuthTokens,
  normalizeAuth,
  readAuthTokens,
  type AuthFileReader,
  type AuthPathOptions,
  type AuthTokens,
} from "./src/auth.ts";
export { fetchCopilotUsage, parseCopilotUsage } from "./src/providers/copilot.ts";
export { fetchOpenAIUsage, parseOpenAIUsage } from "./src/providers/openai.ts";
export { UsageTrackerRpc, USAGE_RPC_ID } from "./src/rpc.ts";

export default usageTracker;
