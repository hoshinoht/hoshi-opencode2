import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { Rpc } from "@opencode/plugin/rpc";

const NativePermissionBridgeRuntimeRpc = Rpc.define({
  id: "hoshi-workplan-permission-bridge-runtime-test",
  methods: {
    authorize: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          agent: { type: "string" },
          messageID: { type: "string" },
          toolCallID: { type: "string" },
          resources: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["sessionID", "agent", "messageID", "toolCallID", "resources"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          decision: { type: "string", enum: ["allow"] },
          via: { type: "string", enum: ["runtime-policy", "user-reply"] },
          continuations: { type: "integer", minimum: 0 },
        },
        required: ["decision", "via", "continuations"],
        additionalProperties: false,
      },
    },
    status: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          continuations: { type: "integer", minimum: 0 },
          clientVersion: { type: "string" },
          runtimeVersion: { type: "string" },
          rpcRegistration: { type: "string" },
          hostBinding: { type: "string" },
          eventStream: { type: "string" },
          permissionDecision: { type: "string" },
        },
        required: [
          "continuations",
          "clientVersion",
          "runtimeVersion",
          "rpcRegistration",
          "hostBinding",
          "eventStream",
          "permissionDecision",
        ],
        additionalProperties: false,
      },
    },
  },
  events: {},
});

let stage = "service-discovery";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function asRecord(value) {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), "unexpected response shape");
  return value;
}

async function waitForAsk(client, sessionID, projectRoot) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const iterator = client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
  try {
    while (true) {
      const result = await iterator.next();
      assert(!result.done, "event stream ended before permission.asked");
      const event = result.value;
      if (event.type !== "permission.asked" || event.data.sessionID !== sessionID) continue;
      assert(event.location?.directory === projectRoot, "permission.asked came from another project location");
      return event.data.id;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    await iterator.return?.();
  }
}

async function createSession(client, projectRoot, label, resource, effect) {
  return await client.session.create({
    title: `Native workplan permission ${label}`,
    agent: "build",
    location: { directory: projectRoot },
    permissions: [{ action: "edit", resource, effect }],
  });
}

async function authorize(rpc, projectRoot, sessionID, resource, signal) {
  return await rpc.authorize({
    sessionID,
    agent: "build",
    messageID: `msg_native_permission_${sessionID}`,
    toolCallID: `call_native_permission_${sessionID}`,
    resources: [resource],
  }, { signal, location: { directory: projectRoot } });
}

async function expectFailure(operation, stageName) {
  let rejected = false;
  try {
    await operation;
  } catch {
    rejected = true;
  }
  assert(rejected, `${stageName} unexpectedly authorized`);
}

async function run(projectRoot) {
  const endpoint = await Service.discover();
  assert(endpoint, "Service.discover returned no disposable test host");
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const serverInfo = await client.server.info();
  assert(serverInfo.version === "2.0.19", "the disposable host was not OpenCode 2.0.19");
  const rpc = client.rpc(NativePermissionBridgeRuntimeRpc);
  const file = (name) => `${projectRoot}/${name}`;

  stage = "policy-allow";
  const allowResource = file("allow-target.txt");
  const allowSession = await createSession(client, projectRoot, "allow", allowResource, "allow");
  const allowResult = asRecord(await authorize(rpc, projectRoot, allowSession.id, allowResource, new AbortController().signal));
  assert(allowResult.decision === "allow" && allowResult.via === "runtime-policy", "exact runtime allow did not authorize");

  stage = "policy-deny";
  const denyResource = file("deny-target.txt");
  const denySession = await createSession(client, projectRoot, "deny", denyResource, "deny");
  await expectFailure(authorize(rpc, projectRoot, denySession.id, denyResource, new AbortController().signal), "exact runtime deny");
  const denyStatus = asRecord(await rpc.status({}, { location: { directory: projectRoot } }));
  assert(denyStatus.permissionDecision === "deny", "host did not return a definitive deny result");

  stage = "ask-grant";
  const grantResource = file("ask-grant-target.txt");
  const grantSession = await createSession(client, projectRoot, "ask grant", grantResource, "ask");
  const grantEvent = waitForAsk(client, grantSession.id, projectRoot);
  const grantOperation = authorize(rpc, projectRoot, grantSession.id, grantResource, new AbortController().signal);
  const grantRequestID = await grantEvent;
  await client.permission.reply({ sessionID: grantSession.id, requestID: grantRequestID, decision: "once" });
  const grantResult = asRecord(await grantOperation);
  assert(grantResult.decision === "allow" && grantResult.via === "user-reply", "the real one-time grant was not accepted");

  stage = "ask-reject";
  const rejectResource = file("ask-reject-target.txt");
  const rejectSession = await createSession(client, projectRoot, "ask reject", rejectResource, "ask");
  const rejectEvent = waitForAsk(client, rejectSession.id, projectRoot);
  const rejectOperation = authorize(rpc, projectRoot, rejectSession.id, rejectResource, new AbortController().signal);
  const rejectRequestID = await rejectEvent;
  await client.permission.reply({ sessionID: rejectSession.id, requestID: rejectRequestID, decision: "reject" });
  await expectFailure(rejectOperation, "real user rejection");
  const rejectStatus = asRecord(await rpc.status({}, { location: { directory: projectRoot } }));
  assert(rejectStatus.permissionDecision === "rejected", "the real user rejection was not observed");

  stage = "cancel-late-reply";
  const cancelResource = file("ask-cancel-target.txt");
  const cancelSession = await createSession(client, projectRoot, "ask cancel", cancelResource, "ask");
  const cancelEvent = waitForAsk(client, cancelSession.id, projectRoot);
  const invocation = new AbortController();
  let continued = false;
  const cancelOperation = authorize(rpc, projectRoot, cancelSession.id, cancelResource, invocation.signal)
    .then((result) => { continued = true; return result; });
  const cancelRequestID = await cancelEvent;
  invocation.abort();
  await expectFailure(cancelOperation, "cancelled invocation");
  await client.permission.reply({ sessionID: cancelSession.id, requestID: cancelRequestID, decision: "once" });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  const finalStatus = asRecord(await rpc.status({}, { location: { directory: projectRoot } }));
  assert(!continued && finalStatus.continuations === 2, "a late permission reply continued the cancelled invocation");
  assert(finalStatus.clientVersion === "2.0.20" && finalStatus.runtimeVersion === "2.0.19", "runtime/client version evidence mismatch");
  assert(finalStatus.hostBinding === "verified" && finalStatus.eventStream === "ready", "the live host/event nonce proof did not complete");

  return {
    runtimeVersion: serverInfo.version,
    clientVersion: finalStatus.clientVersion,
    hostBinding: finalStatus.hostBinding,
    eventStream: finalStatus.eventStream,
    allow: allowResult.via,
    deny: denyStatus.permissionDecision,
    askGrant: grantResult.via,
    askReject: rejectStatus.permissionDecision,
    lateReplyContinued: continued,
    continuationCount: finalStatus.continuations,
  };
}

try {
  const projectRoot = process.argv[2];
  assert(typeof projectRoot === "string", "missing disposable project root");
  console.log(JSON.stringify({ ok: true, ...(await run(projectRoot)) }));
} catch {
  console.log(JSON.stringify({ ok: false, stage }));
  process.exitCode = 1;
}
