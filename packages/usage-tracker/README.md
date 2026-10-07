# usage-tracker (OpenCode V2)

Shows GitHub Copilot, OpenAI/Codex, and Anthropic quota usage in the native OpenCode TUI.
The server plugin reads existing OpenCode credentials and performs read-only
usage requests; the TUI companion calls those requests through V2 RPC, so it
also works when the TUI is connected to a remote server.

## Install and configure

Load the server entrypoint from `opencode.json(c)` and the TUI companion from
`cli.json`:

```jsonc
// opencode.jsonc
{
  "plugins": [{ "package": "./packages/usage-tracker" }],
}
```

```jsonc
// cli.json
{
  "plugins": ["./packages/usage-tracker"],
}
```

The package exports the V2 server plugin at `.` and the CLI plugin at `./tui`.
The host resolves the companion export when the package is loaded as a CLI
plugin.

## Use

Open the native provider picker with either:

- `/usage`
- Command palette (`Ctrl+P`) → **Usage**

Choose **All Providers**, **GitHub Copilot**, **OpenAI/Codex**, or **Anthropic**. Results are
rendered as provider cards with labeled quota bars, percentages, reset times,
and account details. Individual provider errors remain scoped when an `all`
request is only partially successful.

## Agent quota reminders

The server plugin can append a system reminder before agent model calls,
including subagent calls, when any applicable subscription window has little
quota left. Enable it in the server plugin's options:

```json
"options": {
  "quotaReminderRemainingPercent": { "openai": 10, "anthropic": 10 }
}
```

These values mean **10% remaining (90% used)**. Omit a provider to disable its
reminders. The reminder asks the agent to finish agreed work and essential
verification, avoid expanding scope, and leave an honest handoff if necessary.
It does not interrupt sessions or change models.

Reminders use the active OpenAI or Anthropic OAuth connection; API keys and
environment connections do not expose subscription quota. Five-hour and weekly
windows apply, including Anthropic's Opus/Sonnet weekly window only when that
model family is in use.
Lookups are shared across sessions, cached for five minutes per active
connection, and have a three-second HTTP timeout. Failures suppress reminders
and are cached too. No polling occurs while agents are idle. The reminder is
removed on a subsequent lookup when quota recovers. The dashboard supports
both the earlier nested theme API and the newer dialog-surface API.

## Credentials and privacy

For OpenAI and Anthropic, the plugin first resolves the active V2 integration connection so
OpenCode can refresh an expired OAuth access token. It uses `auth.json` as a
fallback and as the source of legacy Copilot credentials and an OpenAI account
ID when the live credential metadata omits it. Platform data locations are:

- macOS: `~/Library/Application Support/opencode/auth.json`
- Linux: `$XDG_DATA_HOME/opencode/auth.json`, then `~/.local/share/opencode/auth.json`

It accepts the `copilot`/`github-copilot` and `openai`/`chatgpt` provider entries,
normalizes only the access token and optional OpenAI account ID, and fails
closed for malformed files. Tokens are never logged, persisted by this plugin,
or included in displayed results. Network requests have a ten-second timeout
by default.

Anthropic also accepts an `anthropic` OAuth entry in `auth.json` as a fallback.
Its subscription usage endpoint requires OAuth; Anthropic API keys are not used
for quota lookup.

## Endpoint disclosure

The provider APIs used for quota lookup are not stable public usage APIs:

- GitHub Copilot: `https://api.github.com/copilot_internal/user` is an
  undocumented GitHub Copilot endpoint.
- OpenAI/Codex: `https://chatgpt.com/backend-api/wham/usage` is an
  undocumented ChatGPT backend endpoint and may require the
  `ChatGPT-Account-Id` header.
- Anthropic: `https://api.anthropic.com/api/oauth/usage` is an
  undocumented subscription endpoint using the OAuth beta header.

These endpoints, their response shapes, and required headers may change or be
withdrawn without notice. The plugin does not consume quota and does not
write credentials directly; OAuth resolution and refresh are delegated to
OpenCode's integration API.

## Attribution and license

The provider targets and displayed quota concepts are adapted from the
MIT-licensed `opencode-usage-tracker` package by Dylan Liew. This package is an
independent OpenCode V2 implementation and is licensed under
GPL-3.0-or-later.
