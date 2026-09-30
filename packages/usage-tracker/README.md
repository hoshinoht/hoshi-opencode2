# usage-tracker (OpenCode V2)

Shows GitHub Copilot and OpenAI/Codex quota usage in the native OpenCode TUI.
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

Choose **All Providers**, **GitHub Copilot**, or **OpenAI/Codex**. Results are
rendered as provider cards with labeled quota bars, percentages, reset times,
and account details. Individual provider errors remain scoped when an `all`
request is only partially successful.

## Credentials and privacy

For OpenAI, the plugin first resolves the active V2 integration connection so
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

## Endpoint disclosure

The provider APIs used for quota lookup are not stable public usage APIs:

- GitHub Copilot: `https://api.github.com/copilot_internal/user` is an
  undocumented GitHub Copilot endpoint.
- OpenAI/Codex: `https://chatgpt.com/backend-api/wham/usage` is an
  undocumented ChatGPT backend endpoint and may require the
  `ChatGPT-Account-Id` header.

These endpoints, their response shapes, and required headers may change or be
withdrawn without notice. The plugin does not consume quota and does not
write credentials directly; OAuth resolution and refresh are delegated to
OpenCode's integration API.

## Attribution and license

The provider targets and displayed quota concepts are adapted from the
MIT-licensed `opencode-usage-tracker` package by Dylan Liew. This package is an
independent OpenCode V2 implementation and is licensed under
GPL-3.0-or-later.
