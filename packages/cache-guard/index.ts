import cacheGuard from "./src/index";

export * from "./src/policy";
export { createCacheGuardState, getDiagnostics, handlePromptAdmission } from "./src/admission";
export { PLUGIN_ID } from "./src/index";
export type { CacheGuardState, PromptAdmission, WarningDiagnostic } from "./src/admission";
export { CacheGuardRpc, formatWarningToast, toWarningEvent } from "./src/rpc";
export default cacheGuard;
