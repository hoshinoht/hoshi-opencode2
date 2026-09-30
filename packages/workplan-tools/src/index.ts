import { realpath } from "node:fs/promises";
import { Plugin } from "@opencode/plugin";
import type { Info as NativeToolInfo, ToolContext } from "@opencode/plugin/promise/tool";

import {
  createNativeWorkplanInputSchema,
  formatWorkplanInputError,
  nativeWorkplanInputSchemas,
  parseWorkplanToolInput,
  workplanInputJsonSchema,
  workplanToolDefinitions,
  type WorkplanDoctorRuntimeFacts,
  type WorkplanMutationIntent,
  type WorkplanMutationInvocation,
} from "./core";
import { registerNativePermissionBridge, type NativePermissionBridge, type NativePermissionIntent } from "./permission-bridge";

type NativeCoreKey = keyof typeof nativeWorkplanInputSchemas;
type NativeCoreDefinition = {
  description: string;
  execute(args: unknown, context: unknown): Promise<unknown>;
};
type NativeExecutionContext = WorkplanMutationInvocation & {
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void;
  runtimeFacts?: WorkplanDoctorRuntimeFacts;
};

// The core definitions are legacy Zod-backed executors; shared schemas validate this boundary.
const coreDefinitions = workplanToolDefinitions as unknown as Record<string, NativeCoreDefinition>;
const nativeTools = [
  { name: "workplan_create", key: "create" },
  { name: "workplan_update", key: "update" },
  { name: "workplan_inspect", key: "inspect" },
  { name: "workplan_validate", key: "validate" },
  { name: "workplan_read", key: "read" },
  { name: "workplan_list", key: "list" },
  { name: "workplan_patch", key: "patch" },
  { name: "workplan_reset", key: "reset" },
  { name: "workplan_resume", key: "resume" },
  { name: "workplan_checkpoint", key: "checkpoint" },
  { name: "workplan_compact", key: "compact" },
  { name: "workplan_doctor", key: "doctor" },
] as const satisfies readonly { name: string; key: NativeCoreKey }[];
const nativeToolNames = [...nativeTools.map((tool) => tool.name), "workplan_compact_preview"];
const authoringTools = new Set(["workplan_create", "workplan_update", "workplan_patch", "workplan_reset"]);
const authoringAgents = new Set(["plan", "orchestrator"]);
const { mode: _compactMode, ...compactPreviewArgs } = workplanToolDefinitions.workplan_compact.args;
const compactPreviewInputSchema = createNativeWorkplanInputSchema(compactPreviewArgs);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

function inputError(name: string, error: { issues: Array<{ path: PropertyKey[]; message: string }> }): Error {
  return new Error(`Invalid ${name} input: ${formatWorkplanInputError(error)}`);
}

function parseNativeInput(name: NativeCoreKey, value: unknown): Record<string, unknown> {
  const native = nativeWorkplanInputSchemas[name].safeParse(value);
  if (!native.success) throw inputError(name, native.error);
  const parsed = parseWorkplanToolInput(name, native.data);
  if (!isRecord(parsed)) throw new Error(`Invalid ${name} input: expected an object`);
  return parsed;
}

function parseCompactPreviewInput(value: unknown): Record<string, unknown> {
  const preview = compactPreviewInputSchema.safeParse(value);
  if (!preview.success) throw inputError("compact_preview", preview.error);
  const native = nativeWorkplanInputSchemas.compact.safeParse({ ...preview.data, mode: "preview" });
  if (!native.success) throw inputError("compact_preview", native.error);
  const parsed = parseWorkplanToolInput("compact", native.data);
  if (!isRecord(parsed) || parsed.mode !== "preview") throw new Error("Compact preview only accepts mode=preview");
  return parsed;
}

function assertRole(toolName: string, rawInput: unknown, agent: string): void {
  const input = isRecord(rawInput) ? rawInput : {};
  if (authoringTools.has(toolName) && !authoringAgents.has(agent)) {
    throw new Error("Only the plan agent or orchestrator may author workplan lifecycle changes");
  }
  if (toolName === "workplan_checkpoint" && agent !== "orchestrator") {
    throw new Error("Only the orchestrator may update a workplan checkpoint");
  }
  if (toolName === "workplan_update" && input.recovery !== undefined && agent !== "orchestrator") {
    throw new Error("Only the orchestrator may recover a workplan transaction");
  }
  if (toolName === "workplan_compact" && input.mode === "apply" && agent !== "orchestrator") {
    throw new Error("Only the orchestrator may apply workplan compaction");
  }
}

function sameResources(actual: readonly string[], expected: readonly string[]): boolean {
  const expectedSorted = [...expected].sort();
  return actual.length === expectedSorted.length && actual.every((path, index) => path === expectedSorted[index]);
}

function makeInvocation(
  root: string,
  toolContext: ToolContext,
  bridge: NativePermissionBridge,
  authorizeWrites: boolean,
  runtimeFacts?: WorkplanDoctorRuntimeFacts,
): NativeExecutionContext {
  const invocation: NativeExecutionContext = {
    directory: root,
    worktree: root,
    abort: toolContext.signal,
    signal: toolContext.signal,
    metadata(metadata) {
      try {
        void toolContext.progress({ status: metadata.title ?? "workplan" }).catch(() => {});
      } catch {
        // Progress is best-effort; it does not authorize or commit a mutation.
      }
    },
  };
  if (runtimeFacts) invocation.runtimeFacts = runtimeFacts;
  if (authorizeWrites) {
    invocation.authorize = async (intent: WorkplanMutationIntent, current: WorkplanMutationInvocation) => {
      if (intent.workspaceRoot !== root) throw new Error("Native mutation intent does not match the active canonical project");
      if (current.abort !== toolContext.signal || current.signal !== toolContext.signal) {
        throw new Error("Native mutation lost its original OpenCode invocation AbortSignal");
      }
      const trustedIntent: NativePermissionIntent = {
        sessionID: toolContext.sessionID,
        agent: toolContext.agent,
        messageID: toolContext.messageID,
        toolCallID: toolContext.id,
        resources: intent.resources,
      };
      const receipt = await bridge.authorizeEdit(trustedIntent, { signal: toolContext.signal });
      if (receipt.sessionID !== trustedIntent.sessionID || receipt.agent !== trustedIntent.agent ||
        receipt.source.messageID !== trustedIntent.messageID || receipt.source.id !== trustedIntent.toolCallID ||
        !sameResources(receipt.resources, intent.resources)) {
        throw new Error("Native permission receipt no longer matches the trusted caller and exact write intent");
      }
    };
  }
  return invocation;
}

function nativeJsonSchema(schema: object): NativeToolInfo["input"] {
  return workplanInputJsonSchema(schema) as NativeToolInfo["input"];
}

function definitionFor(key: NativeCoreKey): NativeCoreDefinition {
  const definition = coreDefinitions[`workplan_${key}`];
  if (!definition) throw new Error(`Missing core workplan definition for ${key}`);
  return definition;
}

function permissionDecision(value: string): "allow" | "deny" | "ask" | "unknown" {
  return value === "allow" || value === "deny" || value === "ask" ? value : "unknown";
}

async function collectDoctorRuntimeFacts(
  ctx: Plugin.Context,
  root: string,
  toolContext: ToolContext,
  bridge: NativePermissionBridge,
): Promise<WorkplanDoctorRuntimeFacts> {
  let effectiveTools: string[] | null = null;
  let plugins: Awaited<ReturnType<Plugin.Context["plugin"]["list"]>>["data"] | null = null;
  const notes: string[] = [];
  try {
    effectiveTools = (await ctx.tool.list()).map((tool) => tool.id).filter((name) => name.startsWith("workplan_"));
  } catch {
    notes.push("Effective tool catalog is unavailable through the public plugin context.");
  }
  try {
    plugins = (await ctx.plugin.list(undefined, { signal: toolContext.signal })).data;
  } catch {
    notes.push("Active plugin facts are unavailable through the public plugin context.");
  }

  const ownPlugin = plugins?.find((plugin) => plugin.id === "workplan-tools");
  const builtinPlan = plugins?.find((plugin) => plugin.id === "opencode.plan");
  const rules: NonNullable<NonNullable<WorkplanDoctorRuntimeFacts["permission"]>["rules"]> = [];
  let agentRead = false;
  let sessionRead = false;
  try {
    const agent = (await ctx.agent.get({ agentID: toolContext.agent }, { signal: toolContext.signal })).data;
    agentRead = true;
    for (const rule of agent.permissions) rules.push({ resource: rule.resource, decision: permissionDecision(rule.effect), source: `agent:${rule.action}` });
  } catch {
    notes.push("Caller agent permission facts are unavailable.");
  }
  try {
    const session = await ctx.session.get({ sessionID: toolContext.sessionID }, { signal: toolContext.signal });
    if (await realpath(session.location.directory) === root) {
      sessionRead = true;
      for (const rule of session.permissions ?? []) rules.push({ resource: rule.resource, decision: permissionDecision(rule.effect), source: `session:${rule.action}` });
    } else {
      notes.push("The current session location differs from the canonical project; session rules are unknown.");
    }
  } catch {
    notes.push("Current session permission facts are unavailable.");
  }

  const bridgeFacts = bridge.diagnostics();
  notes.push("Effective permission remains unknown: public plugin APIs do not expose complete organization/hard-policy precedence.");
  if (effectiveTools === null) notes.push("Configured-only tool names are unknown; only a successful effective tool catalog is authoritative.");
  return {
    registrations: { effective: effectiveTools, configured: null },
    plugin: {
      id: "workplan-tools",
      configured: ownPlugin ? true : null,
      effective: plugins === null ? null : ownPlugin ? ownPlugin.state.status === "active" : false,
      canonicalLocation: root,
    },
    permission: {
      status: "unknown",
      agent: toolContext.agent,
      sessionID: toolContext.sessionID,
      rules,
      detail: [
        `Agent rules ${agentRead ? "read" : "unknown"}; session rules ${sessionRead ? "read" : "unknown"}.`,
        `Bridge client ${bridgeFacts.clientVersion}, RPC ${bridgeFacts.rpcRegistration}, service ${bridgeFacts.serviceDiscovery}, host ${bridgeFacts.hostBinding}, event stream ${bridgeFacts.eventStream}, runtime ${bridgeFacts.runtimeVersion ?? "unknown"}, last failure ${bridgeFacts.lastFailure ?? "none"}.`,
        ...notes,
      ].join(" "),
    },
    builtinPlan: {
      configured: null,
      effective: plugins === null ? null : Boolean(builtinPlan && builtinPlan.state.status === "active"),
    },
  };
}

async function executeCoreTool(
  ctx: Plugin.Context,
  key: NativeCoreKey,
  toolName: string,
  rawInput: unknown,
  toolContext: ToolContext,
  root: string,
  bridge: NativePermissionBridge,
): Promise<{ content: string }> {
  assertRole(toolName, rawInput, toolContext.agent);
  const args = parseNativeInput(key, rawInput);
  const authorizeWrites = key === "create" || key === "update" || key === "patch" || key === "reset" ||
    key === "checkpoint" || (key === "compact" && args.mode === "apply");
  const runtimeFacts = key === "doctor" ? await collectDoctorRuntimeFacts(ctx, root, toolContext, bridge) : undefined;
  const invocation = makeInvocation(root, toolContext, bridge, authorizeWrites, runtimeFacts);
  const result = await definitionFor(key).execute(args, invocation);
  return { content: resultText(result) };
}

async function executeCompactPreview(
  rawInput: unknown,
  toolContext: ToolContext,
  root: string,
  bridge: NativePermissionBridge,
): Promise<{ content: string }> {
  const args = parseCompactPreviewInput(rawInput);
  const invocation = makeInvocation(root, toolContext, bridge, false);
  const result = await definitionFor("compact").execute(args, invocation);
  return { content: resultText(result) };
}

export default Plugin.define({
  id: "workplan-tools",
  async setup(ctx) {
    const canonicalRoot = await realpath(ctx.location.project.directory);
    const bridge = await registerNativePermissionBridge(ctx);
    let disposeTools: (() => Promise<void>) | undefined;
    try {
      const registration = await ctx.tool.transform((editor) => {
        for (const spec of nativeTools) {
          const definition = definitionFor(spec.key);
          editor.add({
            name: spec.name,
            description: definition.description,
            input: nativeJsonSchema(nativeWorkplanInputSchemas[spec.key]),
            options: { codemode: true },
            execute: (input, toolContext) => executeCoreTool(ctx, spec.key, spec.name, input, toolContext, canonicalRoot, bridge),
          });
        }
        editor.add({
          name: "workplan_compact_preview",
          description: "Read-only preview of the exact workplan history selection and archive intent; this tool never applies compaction.",
          input: nativeJsonSchema(compactPreviewInputSchema),
          options: { codemode: true },
          execute: (input, toolContext) => executeCompactPreview(input, toolContext, canonicalRoot, bridge),
        });
      });
      disposeTools = () => registration.dispose();
    } catch (error) {
      await bridge.dispose();
      throw error;
    }
    return async () => {
      try {
        await disposeTools?.();
      } finally {
        await bridge.dispose();
      }
    };
  },
});
