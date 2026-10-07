# Installation

## Requirements

| Tool | Needed for |
|---|---|
| OpenCode 2 | everything (V2 only; OpenCode 1 plugins are not supported) |
| Bun | tests, typecheck and the repo scripts |
| Go | building Shiori, `gofetch-mcp` and `researcher-mcp` |
| Node | running `lsp-tools-mcp` |
| `typescript-language-server`, `basedpyright` | TypeScript and Python support in `lsp-tools-mcp` (`brew install typescript-language-server basedpyright`); without them its tools return nothing for those languages. Projects supply their own `typescript` |
| TeX Live / MacTeX | optional; needed by the docs plugin and scholar |

## Steps

### 1. Clone

```sh
git clone --recurse-submodules git@github.com:hoshinoht/hoshi-opencode2.git ~/.config/opencode
cd ~/.config/opencode
```

### 2. Dependencies

OpenCode 2 does **not** install dependencies for local plugin packages; without them every plugin fails with `Cannot find package '@opencode/plugin'`. Install the workspace once, and again after changing any `package.json`:

```sh
bun install
```

`bun.lock` is tracked; `node_modules/` is ignored. Keep every package's `@opencode/plugin` pin equal to the installed OpenCode version (`opencode --version`).

### 3. Build the MCP servers

```sh
(cd vendor/shiori && CGO_ENABLED=0 go build -trimpath -o shiori ./cmd/shiori)
make -C mcps/gofetch-mcp build                     # -> mcps/gofetch-mcp/bin/gofetch
cd mcps/researcher-mcp && go build -o bin/researcher-mcp ./cmd/google-scholar-mcp
```

`opencode.json` expects Shiori at `vendor/shiori/shiori` and the other built servers at the `bin/` paths above. `mcps/lsp-tools-mcp` ships its built runtime and runs under `node` with no build step.

### 4. Secrets

Secrets never go into git; `opencode.json` refers to them only through `{env:...}`.

| Secret | Where it goes |
|---|---|
| `CONTEXT7_API_KEY` | your environment, or `.env` |
| `ATS_TAILOR_PROJECT`, `ATS_TAILOR_DATA` (optional, for the disabled [`ats-tailor`](https://github.com/hoshinoht/ats-tailor) MCP) | environment variables: a checkout of ats-tailor, and your own resume repository with its index |
| Exa API key (optional, for gofetch) | `~/.config/opencode/.exa-api-key`, mode `600` |

Without an Exa key, gofetch falls back to keyless DuckDuckGo/Mojeek search.

Machine-local files are git-ignored: `.env`, `.env.*`, `.exa-api-key`, and `service.json` (which holds the local server password). Keep it that way.

### 5. Verify

```sh
opencode api GET /api/plugin   # every plugin should report "active"
opencode api GET /api/config   # resolved config, including MCP servers
```

Start a fresh session after changing config or plugins; a running session may not pick the change up.

## Configuration files

| File | Configures |
|---|---|
| `opencode.json` | server: agents' built-in overrides, MCP servers, plugins, default agent |
| `cli.json` | TUI: theme, diffs, session display, tabs, prompt |

## Remote access over Tailscale

The background server should listen only on this machine; Tailscale publishes it to your tailnet with HTTPS.

```sh
opencode service set hostname 127.0.0.1
opencode service set port 4096          # fixed port instead of a random one
opencode service restart
tailscale serve --bg --https=443 http://127.0.0.1:4096
```

- The server is then reachable at `https://<machine>.<tailnet>.ts.net` from tailnet devices only; LAN and direct tailnet-IP connections to the port are refused. The OpenCode server password still applies.
- `opencode service set` stores these settings in `service.json` in this directory (git-ignored).
- Pair a browser or app with `opencode pair --url https://<machine>.<tailnet>.ts.net`.
- A Mac usually cannot open its own `tailscale serve` URL (the request loops through the Tailscale network extension); test from another tailnet device.
- Undo: `tailscale serve --https=443 off` and `opencode service set hostname 127.0.0.1` (keep it local).
