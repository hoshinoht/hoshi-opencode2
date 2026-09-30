import reasoningRouter from "./src/index";

export * from "./src/policy";
export {
  createRouterState,
  getDiagnostics,
  handleModelContext,
  isChildSession,
  PLUGIN_ID,
} from "./src/index";
export type { ContextEvent, RouterState, RoutingRecord, SessionReader, SessionRouting } from "./src/index";
export {
  formatEffortDisplay,
  formatToastMessage,
  ReasoningRouterRpc,
  ROUTER_RPC_ID,
  toRoutedEvent,
} from "./src/rpc";
export type { RoutedEventData } from "./src/rpc";

export default reasoningRouter;
