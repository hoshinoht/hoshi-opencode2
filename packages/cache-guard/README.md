# cache-guard

V2-only OpenCode prompt-admission guard for **at-risk** reuse of an OpenAI prompt cache. It reads durable session history at admission time, so it still works after an OpenCode restart. It never reads, stores, logs, or sends prompt text or credentials.

The guard evaluates the newest completed assistant response only. It warns only when that response is from a configured provider and demonstrated at least `minCacheReadTokens` cache-read tokens; a newer miss or provider/model switch suppresses an older cache hit. At `riskAfterMinutes` of idle time it warns that reuse is at risk or less likely. This is a heuristic, **not an expiry detector**: prefix changes and routing can miss at any age.

OpenAI documents that GPT-5.6+ entries are eligible for at least 30 minutes after their last write or reuse and may last longer. Earlier in-memory caches are typically active for around 5–10 minutes of inactivity, up to one hour. See the official [OpenAI Prompt Caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).

No dollar estimate is shown: pricing varies by model and cache-write and cache-read accounting are different quantities. The guard uses only prior `cache.read` as demonstrated reusable tokens; it does not add cache writes.

## Install

```jsonc
{
  "plugins": [{ "package": "./packages/cache-guard", "options": { "mode": "advisory" } }]
}
```

`./tui` is exported for OpenCode to load the warning-toast companion.

## Options

```jsonc
{
  "enabled": true,
  "mode": "advisory", // "advisory" (default) or opt-in "confirm"
  "riskAfterMinutes": 30,
  "minCacheReadTokens": 10000,
  "providerIDs": ["openai"],
  "diagnosticsLimit": 20
}
```

Options are validated during setup: `riskAfterMinutes` and `minCacheReadTokens` are non-negative integers, `diagnosticsLimit` is an integer of at least one, and `providerIDs` is a non-empty list of non-empty strings. Each prior-response fingerprint warns once: advisory mode allows the first admission, while `confirm` blocks it; later unchanged admissions, including the confirm retry, pass silently. It remains fail-open when session lookup or the TUI/RPC is unavailable. Prompt hooks cannot be provider-scoped in OpenCode V2, so the hook filters durable completed-response history by `providerIDs` instead.

Use the model-visible `cache_guard_status` tool for recent privacy-preserving diagnostics (session ID, model, idle duration, demonstrated cache-read tokens, mode, and action).
