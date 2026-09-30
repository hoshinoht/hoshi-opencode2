# reasoning-router (V2-only)

Deterministic semantic-class routing to provider-specific reasoning effort for subagents.

## Install

```sh
opencode2 plugin add 'github:hoshinoht/hoshi-opencode2#main::path:packages/reasoning-router'
```

An orchestrating model requests a bounded class (`auto` / `fast` / `balanced` /
`deep`); a provider-scoped session `context` hook sets OpenAI
`providerOptions.reasoningEffort` or Anthropic `providerOptions.effort`
immediately before each model call. Agent
policy decides the actual effort, so model requests cannot bypass cost/quality
caps. Native subagent lifecycle, permissions, concurrency, and continuation
behavior are untouched.

## Request

Start the child task with a validated marker (first match wins, stripped from
every outgoing call):

```text
[reasoning:fast] Find all config files that mention retries.
[reasoning:deep:escalate] Diagnose the flaky migration failure.
```

Only delegated child sessions (those with a parent session) are routed; root
sessions keep their configured model variant even when they run a
policy-listed agent such as `plan`. Child status is looked up once per session
and cached; a failed lookup logs a warning and routes as a child so transient
metadata outages degrade to unscoped routing rather than silent disablement.

| Class      | Base effort | Use for                                              |
| ---------- | ----------- | ---------------------------------------------------- |
| `auto`     | agent default | Default; no marker behaves the same                |
| `fast`     | low         | Lookup, deterministic validation                     |
| `balanced` | medium      | Bounded implementation, research                     |
| `deep`     | high        | Planning, review, debugging, consequential decisions |

Append `:escalate` (or `+escalate`) for repeated failed approaches,
contradictory evidence, migrations, security-sensitive work, or destructive
operations. Escalation moves one level and never exceeds the agent maximum.

Never request raw effort values (`low`, `xhigh`, ...): they are not markers and
are ignored by the router.

## Policy

| Agents | Default | Allowed range |
| --- | --- | --- |
| `explore` | medium | low-high |
| `tester` | low | low-medium |
| `code-writer` | xhigh | xhigh |
| `code-engineer` | medium | medium-high |
| `frontend-engineer` | medium | medium-high |
| `researcher`, `document-writer`, `document-proofreader` | medium | low-high |
| `plan`, `plan-checker` | high | medium-high |
| `code-checker` | medium | medium-high |
| `oracle` | low | low-low |

This table is the baseline policy; `opencode.json` overrides selected caps for
Anthropic without changing OpenAI defaults (e.g. Fable-backed `oracle` stays at
medium and Opus-backed `code-writer` defaults to medium). Requests outside the
agent range are clamped, and the resolved effort is always
intersected with the agent range, so caps hold even when the model supports a
wider set. Unknown agents and the primary/auxiliary agent IDs (`build`,
`orchestrator`, `general`, `compaction`, `title`, `summary`) keep their configured model
variant.

## Providers

Only configured providers are routed. OpenAI uses `reasoningEffort`; the
configured Anthropic rule uses the AI SDK's `effort` provider option (sent as
`output_config.effort`). Other providers keep their model behavior. Provider-
specific agent caps allow the same role to have a different default on Opus or
Fable without changing its OpenAI policy:

```jsonc
{
  "package": "./packages/reasoning-router",
  "options": {
    "providers": {
      "openai": {},
      "anthropic": { "option": "effort", "efforts": ["low", "medium", "high"] },
    },
    "providerAgentPolicy": {
      "anthropic": { "oracle": { "def": "medium", "min": "medium", "max": "medium" } },
    },
  },
}
```

`efforts` defaults to the global `supportedEfforts` ladder. An empty
`providers` map disables routing while keeping `reasoning_router_status`
available.

## Stability

The resolved effort is stored by child session ID and reapplied to
continuations on the same agent and model, so parallel sessions cannot leak
state into each other. When an agent or model/provider changes, the stored
resolution is dropped and recalculated under the new model's policy.

The V2 `context` hook exposes no request kind, and title requests never invoke
it. Compaction and transient generation for a routed child therefore inherit
that session's stable effort rather than being excluded; this keeps checkpoint
summaries consistent with the session instead of silently changing reasoning
mid-flight.

## Diagnostics

Each first-call resolution logs one line
(`session`, `agent`, effective `display` such as `gpt-6-luna-1m#low`,
`requested`, `resolved`, matched `rule`) and appends a record without prompt
content. Records carry a `display` field (`<model-id>#<effort>`, empty when no
override applied) so `reasoning_router_status` prints the level used:

```text
reasoning_router_status { "sessionID": "ses_abc", "limit": 20 }
```

## Visibility (toast)

The server emits one `rpc.reasoning-router.routed` event per applied routing
decision (first call only; continuations and fallbacks stay quiet). The
bundled TUI companion (`tui.ts`, auto-loaded from the same package)
subscribes and shows a toast such as:

```text
reasoning-router: explore gpt-6-luna-1m#low applied (requested fast)
```

Notes:

- Events are live-only: a TUI that is connected when the subagent's first
  model call resolves will pop the toast. Decisions made while disconnected
  remain visible via the log line and `reasoning_router_status`.
- Root sessions, ignored agents (`build`, `orchestrator`, `general`,
  `compaction`, `title`, `summary`), unknown agents, and unlisted providers emit
  nothing.
- Fallbacks that keep the model default (no override possible) log
  `model default kept` with the reason in `fallback`, but emit no event.
- Set `"notify": false` to silence event emission; routing, logging, and
  diagnostics are unaffected.

## Options (`opencode.json`)

```jsonc
{
  "package": "./packages/reasoning-router",
  "options": {
    "diagnosticsLimit": 100, // 1..1000 kept in memory
    // "notify": false, // silence rpc.reasoning-router.routed toast events (default true)
    // "supportedEfforts": ["low", "medium", "high", "xhigh", "max"], // default ladder for provider entries
    // "providers": { "openai": {}, "acme": { "option": "thinkingEffort", "efforts": ["low", "medium", "high"] } },
    // "agentPolicy": { "explore": { "def": "low", "min": "low", "max": "medium" } },
    // "classBase": { "fast": "low", "balanced": "medium", "deep": "high" },
  },
}
```

Invalid options fail fast at setup so misconfiguration is visible instead of
silently ignored. Any routing failure at request time falls back to the
agent's configured model variant and never breaks dispatch.

## Known limitation

The hook changes the effective OpenAI request, not the variant shown in
session metadata. The effective effort is surfaced instead via the TUI toast,
the server log line, and the `display` field in `reasoning_router_status`.

## Compatibility

V2-only. `@opencode/plugin` is pinned to `2.0.20`, matching the installed
OpenCode release. Test the installed package — not only a workspace
import — after any OpenCode or plugin-API upgrade, because the V2 API is beta.
This includes the TUI entrypoint (`tui.ts`) and the RPC contract
(`src/rpc.ts`, event `rpc.reasoning-router.routed`): reload the TUI and
confirm a subagent toast appears.
