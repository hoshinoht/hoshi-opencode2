import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { Rpc } from "@opencode/plugin/rpc";

const NATIVE_LIFECYCLE_TOOL_NAMES = [
  "workplan_create", "workplan_update", "workplan_inspect", "workplan_validate", "workplan_read", "workplan_list",
  "workplan_patch", "workplan_reset", "workplan_resume", "workplan_checkpoint", "workplan_compact", "workplan_doctor",
  "workplan_compact_preview",
];
const NativeLifecycleRuntimeRpc = Rpc.define({
  id: "hoshi-workplan-native-lifecycle-runtime-test",
  methods: {
    run: {
      input: {
        type: "object",
        properties: {
          toolName: { type: "string", enum: NATIVE_LIFECYCLE_TOOL_NAMES },
          args: { type: "object", additionalProperties: true },
          sessionID: { type: "string" },
          agent: { type: "string" },
          messageID: { type: "string" },
          toolCallID: { type: "string" },
        },
        required: ["toolName", "args", "sessionID", "agent", "messageID", "toolCallID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { content: { type: "string" }, completed: { type: "integer", minimum: 0 } },
        required: ["content", "completed"],
        additionalProperties: false,
      },
    },
    status: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { completed: { type: "integer", minimum: 0 }, nativeTools: { type: "array", items: { type: "string" } } },
        required: ["completed", "nativeTools"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});

let stage = "service-discovery";
let permissionAsks = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function asObject(value) {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), "unexpected object response");
  return value;
}

function parsed(response) {
  const value = JSON.parse(response.content);
  return value?.metadata && typeof value.metadata === "object" ? value.metadata : value;
}

function identity(session, agent, toolName) {
  const suffix = randomUUID().replaceAll("-", "");
  const label = toolName.replace(/[^a-z0-9_]/gi, "_");
  return {
    sessionID: session.id,
    agent,
    messageID: `msg_lifecycle_${label}_${suffix}`,
    toolCallID: `call_lifecycle_${label}_${suffix}`,
  };
}

function permissionEventWaiter(client, sessionID, projectRoot, timeout = 20_000) {
  const controller = new AbortController();
  let iterator;
  const promise = (async () => {
    iterator = client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next();
      assert(!next.done, "event stream ended before the matching permission request");
      const event = next.value;
      if (event.type !== "permission.asked" || event.data.sessionID !== sessionID) continue;
      assert(event.location?.directory === projectRoot, "permission request came from another project location");
      return event;
    }
  })();
  const timer = setTimeout(() => controller.abort(), timeout);
  return {
    promise,
    async cancel() {
      clearTimeout(timer);
      controller.abort();
      await iterator?.return?.();
    },
  };
}

function validateExactAsk(event, projectRoot, caller, expectedPaths = []) {
  assert(event.data.action === "edit", "native bridge requested an action other than edit");
  assert(event.data.source?.type === "tool", "permission request omitted its trusted tool source");
  assert(event.data.source.messageID === caller.messageID && event.data.source.id === caller.toolCallID, "permission source did not match the trusted tool call");
  assert(Array.isArray(event.data.resources) && event.data.resources.length > 0, "permission request omitted exact resources");
  const unique = new Set(event.data.resources);
  assert(unique.size === event.data.resources.length, "permission request duplicated a resource");
  for (const resource of event.data.resources) {
    assert(isAbsolute(resource) && resolve(resource) === resource, "permission request used a non-canonical resource");
    assert(!/[*?\[\]]/.test(resource), "permission request widened a resource with a glob");
    const fromRoot = relative(projectRoot, resource);
    assert(fromRoot && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`), "permission request escaped the project root");
  }
  for (const path of expectedPaths) assert(event.data.resources.includes(path), `permission request omitted intended resource ${path}`);
  const marker = event.data.metadata?.workplanToolsBridge;
  assert(typeof marker?.authorizationID === "string" && marker.agent === caller.agent && marker.version === 1, "permission request omitted trusted invocation correlation metadata");
}

async function createSession(client, projectRoot, agent, title, permissions) {
  return await client.session.create({ title, agent, location: { directory: projectRoot }, permissions });
}

async function runWithAsk(client, rpc, projectRoot, session, toolName, args, expectedPaths = [], agent = session.agent) {
  const caller = identity(session, agent, toolName);
  const waiter = permissionEventWaiter(client, session.id, projectRoot);
  try {
    const operation = rpc.run({ toolName, args, ...caller }, { location: { directory: projectRoot } })
      .then((result) => ({ kind: "result", result }), () => ({ kind: "error" }));
    const outcome = await Promise.race([
      operation,
      waiter.promise.then((event) => ({ kind: "ask", event }), () => ({ kind: "watch-ended" })),
    ]);
    assert(outcome.kind === "ask", `${toolName} did not produce a real permission.asked event`);
    const event = outcome.event;
    validateExactAsk(event, projectRoot, caller, expectedPaths);
    permissionAsks++;
    await client.permission.reply({ sessionID: session.id, requestID: event.data.id, decision: "once" });
    const result = await operation;
    assert(result.kind === "result", `${toolName} did not complete after the real one-time grant`);
    return parsed(result.result);
  } finally {
    await waiter.cancel();
  }
}

async function runReadOnly(client, rpc, projectRoot, session, toolName, args) {
  const caller = identity(session, session.agent, toolName);
  const waiter = permissionEventWaiter(client, session.id, projectRoot, 5_000);
  const askOutcome = waiter.promise.then((event) => ({ kind: "ask", event }), () => ({ kind: "watch-ended" }));
  try {
    const outcome = await Promise.race([
      rpc.run({ toolName, args, ...caller }, { location: { directory: projectRoot } })
        .then((result) => ({ kind: "result", result }), () => ({ kind: "error" })),
      askOutcome,
    ]);
    assert(outcome.kind === "result", `${toolName} unexpectedly requested edit permission`);
    const lateOutcome = await Promise.race([askOutcome, new Promise((resolveDelay) => setTimeout(() => resolveDelay({ kind: "quiet" }), 100))]);
    if (lateOutcome.kind === "ask") {
      permissionAsks++;
      await client.permission.reply({ sessionID: session.id, requestID: lateOutcome.event.data.id, decision: "reject" });
    }
    assert(lateOutcome.kind === "quiet", `${toolName} requested permission after returning`);
    return parsed(outcome.result);
  } finally {
    await waiter.cancel();
  }
}

async function expectBlocked(client, rpc, projectRoot, session, toolName, args, target, agent = session.agent) {
  const caller = identity(session, agent, toolName);
  const waiter = permissionEventWaiter(client, session.id, projectRoot, 2_000);
  const operation = rpc.run({ toolName, args, ...caller }, { location: { directory: projectRoot } })
    .then((result) => ({ kind: "result", result }), () => ({ kind: "error" }));
  try {
    const outcome = await Promise.race([operation, waiter.promise.then((event) => ({ kind: "ask", event }))]);
    if (outcome.kind === "ask") {
      validateExactAsk(outcome.event, projectRoot, caller, [target]);
      permissionAsks++;
      await client.permission.reply({ sessionID: session.id, requestID: outcome.event.data.id, decision: "reject" });
      await operation;
      return "ask-rejected";
    }
    assert(outcome.kind === "error", "the supposedly denied edit unexpectedly completed");
    const doctor = await runReadOnly(client, rpc, projectRoot, session, "workplan_doctor", { limit: 10 });
    return doctor.runtimeFacts.permission.detail.includes("permission-denied") ? "deny" : "rejected";
  } finally {
    await waiter.cancel();
  }
}

async function resultStateHash(client, rpc, root, session, id) {
  const result = await runReadOnly(client, rpc, root, session, "workplan_read", { id, includeMarkdown: false });
  assert(typeof result.stateHash === "string", "native read omitted stateHash");
  return result.stateHash;
}

async function runRejected(client, rpc, projectRoot, session, toolName, args, agent = session.agent) {
  const caller = identity(session, agent, toolName);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    await rpc.run({ toolName, args, ...caller }, { location: { directory: projectRoot }, signal: controller.signal });
    return false;
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function buildRecoveryFixture(projectRoot, workplanId) {
  const jsonPath = `${projectRoot}/.opencode/workplan/${workplanId}.json`;
  const journalPath = `${projectRoot}/.opencode/workplan/${workplanId}.transaction.json`;
  const before = await readFile(jsonPath);
  const document = JSON.parse(before.toString("utf8"));
  document.title = "Recovered journal title";
  document.updatedAt = new Date().toISOString();
  const after = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  const mode = (await stat(jsonPath)).mode & 0o777;
  const relativePath = relative(projectRoot, jsonPath).replaceAll("\\", "/");
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  await writeFile(journalPath, `${JSON.stringify({
    schemaVersion: 1,
    transactionId: "native-lifecycle-recovery-fixture",
    workplanId,
    operation: "update:fixture-partial",
    createdAt: new Date().toISOString(),
    targets: [{
      path: relativePath,
      beforeHash: sha(before),
      afterHash: sha(after),
      beforeContent: before.toString("base64"),
      afterContent: after.toString("base64"),
      mode,
    }],
  }, null, 2)}\n`);
}

function noSessionOverrides() {
  return [];
}

function createPlanInput(id, goal) {
  return {
    id,
    kind: "software-engineering",
    title: id,
    goal,
    status: "in_progress",
    notes: ["archive this runtime note"],
    reviewFindings: [{ severity: "major", title: "Resolved runtime review item", status: "resolved" }],
    phases: [
      {
        id: "completed-phase",
        title: "Completed setup",
        status: "completed",
        steps: [{ id: "completed-step", title: "Setup", action: "Set up", validation: "Ready", status: "completed" }],
      },
      {
        id: "active-phase",
        title: "Active implementation",
        status: "in_progress",
        steps: [{ id: "active-step", title: "Continue", action: "Continue work", validation: "Run tests", status: "in_progress" }],
      },
    ],
    overwrite: false,
  };
}

async function runLifecycle(projectRoot) {
  const gitfile = await readFile(`${projectRoot}/.git`, "utf8");
  assert(gitfile.startsWith("gitdir: "), "the isolated host project is not a linked Git worktree");
  const endpoint = await Service.discover();
  assert(endpoint, "Service.discover returned no isolated lifecycle host");
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const serverInfo = await client.server.info();
  assert(serverInfo.version === "2.0.19", "lifecycle host is not OpenCode 2.0.19");
  const rpc = client.rpc(NativeLifecycleRuntimeRpc);
  const catalog = asObject(await rpc.status({}, { location: { directory: projectRoot } }));
  assert(NATIVE_LIFECYCLE_TOOL_NAMES.every((name) => catalog.nativeTools.includes(name)), "the effective tool catalog is incomplete");

  stage = "session-create";
  const orchestrator = await createSession(client, projectRoot, "orchestrator", "Lifecycle orchestration", noSessionOverrides());
  const plan = await createSession(client, projectRoot, "plan", "Lifecycle authoring", noSessionOverrides());
  const jsonPath = `${projectRoot}/.opencode/workplan/lifecycle-demo.json`;
  const markdownPath = `${projectRoot}/.opencode/workplan/lifecycle-demo.md`;

  stage = "create";
  const created = await runWithAsk(client, rpc, projectRoot, plan, "workplan_create", createPlanInput("lifecycle-demo", "Native lifecycle smoke goal"), [jsonPath, markdownPath]);
  assert(typeof created.stateHash === "string", "native create omitted stateHash");

  stage = "list";
  const listed = await runReadOnly(client, rpc, projectRoot, plan, "workplan_list", {});
  assert(listed.workplans.some((entry) => entry.id === "lifecycle-demo"), "native list omitted the created workplan");

  stage = "inspect";
  const inspected = await runReadOnly(client, rpc, projectRoot, plan, "workplan_inspect", { id: "lifecycle-demo" });
  assert(inspected.workplan.id === "lifecycle-demo", "native inspect returned the wrong workplan");
  stage = "read";
  const firstRead = await runReadOnly(client, rpc, projectRoot, plan, "workplan_read", { id: "lifecycle-demo", includeMarkdown: false });
  assert(firstRead.workplan.id === "lifecycle-demo" && typeof firstRead.stateHash === "string", "native read omitted the plan or stateHash");

  stage = "update";
  const updated = await runWithAsk(client, rpc, projectRoot, plan, "workplan_update", {
    id: "lifecycle-demo",
    expectedHash: firstRead.stateHash,
    appendNotes: ["Updated through the native adapter"],
  }, [jsonPath]);
  assert(typeof updated.stateHash === "string", "native update omitted stateHash");

  stage = "patch";
  const currentMarkdown = await readFile(markdownPath, "utf8");
  const originalGoal = "Native lifecycle smoke goal";
  assert(currentMarkdown.includes(originalGoal), "generated Markdown did not contain the requested goal");
  const patchText = [
    "*** Begin Patch",
    "*** Update File: .opencode/workplan/lifecycle-demo.md",
    "@@",
    `-${originalGoal}`,
    `+${originalGoal} after the native patch`,
    "*** End Patch",
  ].join("\n");
  const patched = await runWithAsk(client, rpc, projectRoot, plan, "workplan_patch", {
    id: "lifecycle-demo",
    expectedHash: updated.stateHash,
    patchText,
  }, [markdownPath]);
  assert(typeof patched.stateHash === "string", "native patch omitted stateHash");

  stage = "validate-checkpoint";
  const validation = await runReadOnly(client, rpc, projectRoot, plan, "workplan_validate", { id: "lifecycle-demo" });
  assert(validation.valid === true, `native validation failed: ${JSON.stringify(validation.issues)}`);
  const checkpoint = await runWithAsk(client, rpc, projectRoot, orchestrator, "workplan_checkpoint", {
    id: "lifecycle-demo",
    expectedHash: patched.stateHash,
    summary: "Native lifecycle runtime test is ready.",
    nextAction: "Verify compact preview and apply.",
    phaseId: "active-phase",
    stepId: "active-step",
  }, [`${projectRoot}/.opencode/workplan/lifecycle-demo.checkpoint.json`]);
  assert(typeof checkpoint.stateHash === "string", "native checkpoint omitted stateHash");
  const continuation = await runReadOnly(client, rpc, projectRoot, plan, "workplan_resume", { id: "lifecycle-demo" });
  assert(continuation.checkpoint.current.stepId === "active-step", "native resume lost the current step");

  stage = "preview-apply";
  const preview = await runReadOnly(client, rpc, projectRoot, plan, "workplan_compact_preview", {
    id: "lifecycle-demo",
    archiveReason: "Archive only the completed lifecycle fixture history.",
    completedPhaseIds: ["completed-phase"],
    noteIndexes: [0],
    resolvedFindingIndexes: [0],
  });
  assert(preview.mode === "preview" && typeof preview.previewToken === "string", "compact preview omitted its bound token");
  const compacted = await runWithAsk(client, rpc, projectRoot, orchestrator, "workplan_compact", {
    id: "lifecycle-demo",
    mode: "apply",
    archiveReason: "Archive only the completed lifecycle fixture history.",
    completedPhaseIds: ["completed-phase"],
    noteIndexes: [0],
    resolvedFindingIndexes: [0],
    confirmation: "ARCHIVE_SELECTED_HISTORY",
    previewToken: preview.previewToken,
    expectedHash: preview.stateHash,
  }, [jsonPath, preview.archivePath]);
  assert(compacted.compacted === true, "native compact apply did not complete");

  stage = "reset-fixture";
  const resetPlan = await runWithAsk(client, rpc, projectRoot, plan, "workplan_create", createPlanInput("reset-demo", "Reset fixture"), [
    `${projectRoot}/.opencode/workplan/reset-demo.json`,
    `${projectRoot}/.opencode/workplan/reset-demo.md`,
  ]);
  const reset = await runWithAsk(client, rpc, projectRoot, plan, "workplan_reset", {
    id: "reset-demo",
    expectedHash: resetPlan.stateHash,
    mode: "draft",
    preserveNotes: false,
  }, [`${projectRoot}/.opencode/workplan/reset-demo.json`, `${projectRoot}/.opencode/workplan/reset-demo.md`]);
  assert(reset.reset === true && reset.mode === "draft", "native reset fixture did not reset to draft");

  stage = "recovery-fixture";
  const recoveryPlan = await runWithAsk(client, rpc, projectRoot, plan, "workplan_create", createPlanInput("recovery-demo", "Recovery fixture"), [
    `${projectRoot}/.opencode/workplan/recovery-demo.json`,
    `${projectRoot}/.opencode/workplan/recovery-demo.md`,
  ]);
  await buildRecoveryFixture(projectRoot, "recovery-demo");
  const pending = await runReadOnly(client, rpc, projectRoot, plan, "workplan_read", { id: "recovery-demo" });
  assert(pending.recoveryRequired === true && typeof pending.stateHash === "string", "the recovery journal fixture was not detected");
  const recovered = await runWithAsk(client, rpc, projectRoot, orchestrator, "workplan_update", {
    id: "recovery-demo",
    recovery: "resume",
    expectedHash: pending.stateHash,
  }, [
    `${projectRoot}/.opencode/workplan/recovery-demo.json`,
    `${projectRoot}/.opencode/workplan/recovery-demo.transaction.json`,
  ]);
  assert(recovered.recovered === true, "native recovery did not resume the journaled bundle");
  assert(!await readFile(`${projectRoot}/.opencode/workplan/recovery-demo.transaction.json`).then(() => true, () => false), "recovery left its transaction journal");
  const recoveredRead = await runReadOnly(client, rpc, projectRoot, plan, "workplan_read", { id: "recovery-demo", includeMarkdown: false });
  assert(recoveredRead.workplan.title === "Recovered journal title", "recovery did not publish its exact after image");

  stage = "session-deny-overrides";
  let relativeRuleFallback;
  for (const [label, target, resourcePattern, expectedEffect] of [
    ["absolute", `${projectRoot}/.opencode/workplan/deny-absolute.json`, `${projectRoot}/.opencode/workplan/deny-absolute.json`, "deny"],
    ["relative", `${projectRoot}/.opencode/workplan/deny-relative.json`, ".opencode/workplan/deny-relative.json", "ask-rejected"],
  ]) {
    const deniedSession = await createSession(client, projectRoot, "orchestrator", `Session deny ${label}`, [
      { action: "edit", resource: resourcePattern, effect: "deny" },
    ]);
    const effect = await expectBlocked(client, rpc, projectRoot, deniedSession, "workplan_create", createPlanInput(`deny-${label}`, `Deny ${label}`), target);
    assert(effect === expectedEffect, `session ${label} policy did not produce ${expectedEffect} (observed ${effect})`);
    if (label === "relative") relativeRuleFallback = effect;
    assert(!await readFile(target).then(() => true, () => false), `session ${label} deny published the target`);
  }

  stage = "caller-restrictions";
  const planner = await createSession(client, projectRoot, "plan", "Planner restriction", noSessionOverrides());
  const unauthorized = await runRejected(client, rpc, projectRoot, planner, "workplan_checkpoint", {
    id: "lifecycle-demo",
    summary: "Should be rejected",
    nextAction: "Should not run",
    expectedHash: await resultStateHash(client, rpc, projectRoot, plan, "lifecycle-demo"),
  });
  assert(unauthorized, "planner checkpoint invocation was not rejected");
  const rootOverride = await runRejected(client, rpc, projectRoot, plan, "workplan_read", {
    id: "lifecycle-demo",
    workspaceRoot: `${projectRoot}/outside` ,
  });
  assert(rootOverride, "native workspaceRoot override was not rejected");

  stage = "nested-session-location";
  const nestedDirectory = `${projectRoot}/nested-session`;
  await mkdir(nestedDirectory);
  const nestedSession = await createSession(client, nestedDirectory, "orchestrator", "Nested project location", noSessionOverrides());
  const nestedTarget = `${projectRoot}/.opencode/workplan/nested-session-demo.json`;
  assert(await runRejected(client, rpc, projectRoot, nestedSession, "workplan_create", createPlanInput("nested-session-demo", "Nested session must fail closed")), "nested session location was accepted for project-root writes");
  assert(!await readFile(nestedTarget).then(() => true, () => false), "nested session mismatch published a workplan");
  const nestedDoctor = await runReadOnly(client, rpc, projectRoot, nestedSession, "workplan_doctor", { limit: 10 });
  assert(nestedDoctor.runtimeFacts.permission.detail.includes("last failure session-location-mismatch"), "doctor hid the nested session fail-closed diagnosis");

  stage = "doctor-facts";
  const doctor = await runReadOnly(client, rpc, projectRoot, plan, "workplan_doctor", { limit: 20 });
  assert(doctor.readOnly === true, "workplan doctor did not report read-only behavior");
  assert(doctor.runtimeFacts.permission.status === "unknown", "doctor guessed that effective permission rules were known");
  assert(doctor.runtimeFacts.registrations.effective.includes("workplan_compact_preview"), "doctor omitted an effective native registration");
  assert(doctor.runtimeFacts.plugin.id === "workplan-tools" && doctor.runtimeFacts.plugin.configured === true && doctor.runtimeFacts.plugin.effective === true && doctor.runtimeFacts.plugin.canonicalLocation === projectRoot, "doctor did not report the active native plugin at its canonical project location");
  assert(doctor.runtimeFacts.builtinPlan.configured === null && doctor.runtimeFacts.builtinPlan.effective === false, "doctor did not preserve the disabled built-in Plan status as known-effective/unknown-configured");
  assert(doctor.runtimeFacts.permission.detail.includes("host verified") && doctor.runtimeFacts.permission.detail.includes("event stream ready"), "doctor omitted safe bridge capability facts");

  stage = "cancel-late-reply";
  const cancelSession = await createSession(client, projectRoot, "orchestrator", "Cancellation late reply", noSessionOverrides());
  const beforeCancel = await readFile(jsonPath);
  const filesBeforeCancel = await readdir(`${projectRoot}/.opencode/workplan`);
  const stateBeforeCancel = await resultStateHash(client, rpc, projectRoot, plan, "lifecycle-demo");
  const caller = identity(cancelSession, "orchestrator", "workplan_update");
  const waiter = permissionEventWaiter(client, cancelSession.id, projectRoot);
  const invocation = new AbortController();
  const completionBefore = (await rpc.status({}, { location: { directory: projectRoot } })).completed;
  try {
    const operation = rpc.run({
      toolName: "workplan_update",
      args: { id: "lifecycle-demo", expectedHash: stateBeforeCancel, title: "Late cancellation must not commit" },
      ...caller,
    }, { location: { directory: projectRoot }, signal: invocation.signal });
    const ask = await waiter.promise;
    permissionAsks++;
    validateExactAsk(ask, projectRoot, caller, [jsonPath]);
    invocation.abort();
    await operation.then(() => { throw new Error("cancelled mutation returned success"); }, () => {});
    await client.permission.reply({ sessionID: cancelSession.id, requestID: ask.data.id, decision: "once" });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  } finally {
    await waiter.cancel();
  }
  assert((await readFile(jsonPath)).equals(beforeCancel), "late approval changed the cancelled workplan");
  assert(JSON.stringify(await readdir(`${projectRoot}/.opencode/workplan`)) === JSON.stringify(filesBeforeCancel), "late approval left transaction artifacts");
  const completionAfter = (await rpc.status({}, { location: { directory: projectRoot } })).completed;
  assert(completionAfter === completionBefore, "a late approval continued the cancelled native tool");
  return {
    runtimeVersion: serverInfo.version,
    clientVersion: "2.0.20",
    hostProjectKind: "linked-worktree",
    nativeToolCount: catalog.nativeTools.length,
    lifecycle: ["create", "list", "inspect", "read", "update", "patch", "validate", "checkpoint", "resume", "preview", "apply", "doctor"],
    reset: reset.mode,
    recovery: recovered.recovered,
    absoluteSessionDeny: "deny",
    relativeRuleFallback,
    nestedSessionLocation: "session-location-mismatch",
    permissionAsks,
    cancellationLateReplyContinued: false,
    doctorPermissionStatus: doctor.runtimeFacts.permission.status,
    doctorPluginEffective: doctor.runtimeFacts.plugin.effective,
    doctorBuiltinPlanEffective: doctor.runtimeFacts.builtinPlan.effective,
    doctorHostBinding: doctor.runtimeFacts.permission.detail.includes("host verified"),
    doctorEventStream: doctor.runtimeFacts.permission.detail.includes("event stream ready"),
  };
}

let projectRootForErrors = "";
try {
  const projectRoot = process.argv[2];
  assert(typeof projectRoot === "string", "missing disposable project root");
  projectRootForErrors = projectRoot;
  console.log(JSON.stringify({ ok: true, ...(await runLifecycle(projectRoot)) }));
} catch (error) {
  const message = error instanceof Error ? error.message : "non-error exception";
  const redacted = message
    .replaceAll(projectRootForErrors, "[scratch-project]")
    .replace(/https?:\/\/[^\s]+/gi, "[endpoint]")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9+/=_-]+/gi, "[auth]");
  console.log(JSON.stringify({ ok: false, stage, error: redacted }));
  process.exitCode = 1;
}
