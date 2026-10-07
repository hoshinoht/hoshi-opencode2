# Workplan permissions

OpenCode role checks for Shiori's existing MCP tools. This plugin wraps their executors and uses the trusted caller's `agent`; it does not register tools or change the MCP transport.

- `plan` and `orchestrator` may create, update, patch and reset plans.
- Only `orchestrator` may recover transactions, write checkpoints or apply compaction.
- The plan agent's MCP resource reads are limited to server `workplan`.
- Workplan tools are searchable through Code Mode and pinned for direct calls.

Tool availability and user prompts remain controlled by `scripts/agent-permissions.yaml`. In particular, orchestrator checkpoints, compaction and resets still require approval.

Run `bun test src/` to check the role policy. The plugin disposes its transform on unload.
