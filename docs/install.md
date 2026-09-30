# Installation

## Requirements

| Tool | Needed for |
|---|---|
| OpenCode 2 | everything (V2 only; OpenCode 1 plugins are not supported) |
| Bun | tests, typecheck and the repo scripts |
| Go | building the `gofetch-mcp` and `researcher-mcp` submodules |
| Node | running `lsp-tools-mcp` |
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
make -C mcps/gofetch-mcp build                     # -> mcps/gofetch-mcp/bin/gofetch
cd mcps/researcher-mcp && go build -o bin/researcher-mcp ./cmd/google-scholar-mcp
```

`opencode.json` expects the binaries at exactly those `bin/` paths. `mcps/lsp-tools-mcp` ships its built runtime and runs under `node` with no build step.

### 4. Secrets

Secrets never go into git; `opencode.json` refers to them only through `{env:...}`.

| Secret | Where it goes |
|---|---|
| `CONTEXT7_API_KEY` | your environment, or `.env` |
| Exa API key (optional, for gofetch) | `~/.config/opencode/.exa-api-key`, mode `600` |

Without an Exa key, gofetch falls back to keyless DuckDuckGo/Mojeek search.

Machine-local files are git-ignored: `.env`, `.env.*`, `.exa-api-key`, and `service.json` (which holds the local server password). Keep it that way.

### 5. Verify

```sh
opencode mcp list      # or `opencode2 mcp list` if V2 is installed alongside V1
```

Start a fresh session after changing config or plugins; a running session may not pick the change up.

## Configuration files

| File | Configures |
|---|---|
| `opencode.json` | server: agents' built-in overrides, MCP servers, plugins, default agent |
| `cli.json` | TUI: theme, diffs, session display, tabs, prompt |
