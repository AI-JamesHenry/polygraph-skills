# Vendored WIP MCP contract

This directory is the fixed runtime boundary between the `james-polygraph` plugin and the matching Ocean background-session spike.

The plugin always launches:

```text
node ${CLAUDE_PLUGIN_ROOT}/wip-mcp/bin/polygraph-mcp.mjs
```

The launcher requires this vendored entrypoint:

```text
wip-mcp/vendor/bin/polygraph-mcp.mjs
```

Copy the complete runnable Ocean MCP/CLI distribution under `vendor/`, preserving every relative runtime dependency expected by that entrypoint. Do not copy only one generated JavaScript file if it imports sibling files or packages.

The vendored implementation provides the narrow tools used by the skill:

- `background_session_start`
- `record_pushed_branch`
- `associate_pr`
- `update_session`
- `complete_session` (with explicit OPEN/DRAFT PR closure confirmation)

The successful start result contract is:

```json
{
  "sessionId": "...",
  "polygraphSessionUrl": "...",
  "repository": "owner/repository",
  "capture": {
    "status": "started",
    "agentType": "claude",
    "providerSessionId": "..."
  }
}
```

Before returning success, the tool must authenticate the repository-bound service account, create one in-place parent-only session, resolve exactly one pending capture mapping for the current process/cwd, atomically bind it to the new Polygraph session, start the parent-log sidecar, and receive a positive acknowledgement that the transcript was opened.

The launcher intentionally exits with a configuration error when the vendored entrypoint is absent. It never falls back to `@polygraph/mcp@latest`.
