# Cursor Cloud Agents support (spike)

Status: capture hook implemented (`hooks/polygraph-capture.mjs`, tests in
`test/cursor-capture.test.mjs`); not yet exercised against a live cloud agent
or a real capture endpoint. Nothing in this directory ships to users yet.

## Capture flow

1. Hook invocations always dead-drop the current `conversation_id` (the
   `bc-<uuid>` cloud agent id) to `~/.polygraph/background-capture/`
   before doing anything else; nothing is transmitted without a marker.
2. The agent (instructed by the future cursor skill/rules) calls the
   Polygraph MCP `background_session_start` tool, then runs
   `node .cursor/hooks/polygraph-capture.mjs activate <captureHookUrl>`.
   Activation binds the capability URL to the dead-dropped conversation id
   in a mode-0600 marker. `meta <leaf>` reads the in-VM metadata socket
   (`agent/id`, `owner/user-email`, `workspace/repo-url`, ...) for the MCP
   call's arguments.
3. Each subsequent hook event is mapped to `AgentLogLine` records
   (+`eventId`/`timestamp`), appended to a per-session outbox, and flushed
   to `<captureHookUrl>/transcript` from a persisted offset. Parallel hook
   processes coordinate via a best-effort lock; failures retry on the next
   invocation; the server's `(sessionId, eventId)` claims dedupe; a 401
   deactivates capture.

Open items: `afterAgentThought` / subagent payload shapes are unsampled
(mapped defensively); PR branch events (`/pr` route) are not yet emitted;
the server does not yet accept a Cursor provider (ocean-side work).

## Layout: a real Cursor plugin, shim-delivered to cloud agents

This directory is structured as a spec-conformant Cursor plugin
(`.cursor-plugin/plugin.json` + `hooks/hooks.json`, see
https://cursor.com/docs/reference/plugins) so it can be submitted to the
Cursor Marketplace later without restructuring. The same layout mirrors the
Claude plugin this repo already ships.

Cursor plugins are not documented to load in Cloud Agents (only team MCP
servers are explicitly cloud-available), and cloud agents run command hooks
only from `.cursor/hooks.json` at the repo root. So the plugin content
reaches cloud agents through a thin repo-committed shim:

- `shim/dot-cursor-hooks.json` is the template a repo commits as
  `.cursor/hooks.json`. During the diagnostics phase it points at a vendored
  copy of the hook script (`.cursor/hooks/polygraph-diagnostic.mjs`).
- For the real integration the shim's commands will instead invoke the
  published npm package (planned: `npx --yes @polygraph/cursor-plugin@^1
  hook`, matching the Codex plugin's npm delivery), with
  `.cursor/environment.json` warming the install. Vendoring stays as the
  documented fallback for pools without registry access.

One source of truth, three delivery channels: marketplace plugin (IDE/CLI,
later), repo shim + npm (cloud agents), vendored files (fallback and the
current diagnostics phase).

Background and the full exploration write-up live in the ocean repo:
`docs/brainstorms/2026-08-19-cursor-cloud-agents-exploration.md`. Summary of
the plan:

- **Polygraph-triggered runs (Path B)**: nx-api launches agents via Cursor's
  Cloud Agents API (`POST /v1/agents`) and ingests each run's SSE stream
  server-side. No hooks involved.
- **Passive capture** (agents users start themselves from Cursor's UI/IDE):
  Cursor cloud agents only run command hooks from `.cursor/hooks.json`
  committed at the repo root. There is no plugin mechanism like Claude's, so
  the hook script must be vendored into each enrolled repository. The
  capture flow mirrors the Claude sidecar in `source/hooks/`: the agent
  registers via the Polygraph MCP endpoint (`background_session_start`,
  dashboard-configured MCP server with per-user OAuth), gets a
  `captureHookUrl`, and hooks upload transcript increments to it.
- Cursor webhooks cannot trigger passive capture: they are per-agent,
  launch-time, terminal-status-only, and v1 has none at all (verified against
  the OpenAPI spec on 2026-08-19).

## Why diagnostics first

Cursor's on-disk transcript format (the `transcript_path` every hook input
carries) is undocumented, and so are the VM environment and hook payload
details beyond the docs' examples. The capture adapter (Cursor transcript ->
Polygraph `AgentLogLine`) cannot be written until we have real samples.

## Running the diagnostics

1. Create a throwaway test repository your Cursor account can run cloud
   agents on. Copy `shim/dot-cursor-hooks.json` to `.cursor/hooks.json` and
   `hooks/polygraph-diagnostic.mjs` to `.cursor/hooks/polygraph-diagnostic.mjs`
   in that repo, commit, push.
2. Optional but recommended: expose a local receiver (for example
   `cloudflared tunnel` to a tiny local server, or the local nx-api once a
   diag route exists) and set `POLYGRAPH_DIAG_URL` to it as a Cursor
   dashboard secret for the environment. On `stop` the hook also ships the
   whole transcript there, which survives VM recycling.
3. Start a cloud agent on the test repo from cursor.com/agents with a small
   multi-step task (edit a file, run a shell command, finish).
4. Retrieve `/tmp/polygraph-cursor-diag/events.jsonl` and the
   `transcript-*` snapshot: either from the `POLYGRAPH_DIAG_URL` receiver, or
   by sending the agent a follow-up prompt asking it to print those files.

## Findings from run 1 (2026-08-19, cursor-grok-4.6-high-fast, VM env.type cloud)

Raw data: `diag/events-run1.jsonl` on branch `cursor/format-today-30e5` of
`AI-JamesHenry/polygraph-cursor-diag` (private test repo).

- **`transcript_path` is always `null` in cloud agents** (as is `user_email`).
  There is no transcript file to tail; the Claude-style file-tailing sidecar
  does not transfer. Capture must be reconstructed from hook event payloads.
- **Hook payload fidelity is high**: `beforeSubmitPrompt` carries the full
  prompt; `postToolUse` for Shell carries complete output + exit code and for
  Write carries the complete file content; `afterFileEdit` carries full
  old_string/new_string pairs; `afterAgentResponse` carries the complete
  final markdown. Read/Grep outputs are metadata-only. Thinking requires the
  `afterAgentThought` event (now registered; not yet sampled).
- **Identifiers**: `conversation_id` is the cloud agent id (`bc-<uuid>`, the
  same id the v1 REST API uses; the `cursor/...` branch suffix matches its
  tail). The `stop` event's `generation_id` is the run id (`run-<uuid>`).
  Hooks can therefore hand Polygraph both handles needed for API stream
  attach, usage lookup, or the v0 conversation endpoint.
- **`/tmp` persists across runs on the same agent** (verified over a 3-minute
  gap and multiple follow-ups), so marker-based opt-in state works.
- **Hooks are parallel short-lived processes** (distinct pids, sub-ms
  interleaving); server-side `(sessionId, eventId)` dedup is required.
  `tool_use_id` exists per tool call (sometimes containing a newline; sanitize
  before using in an eventId).
- **In-VM local API**: `CURSOR_AGENT_SOCKET=/run/cursor/api.sock` speaks HTTP
  but exposes only `GET /v1/meta-data[/<path>]`. Not a transcript source.
- **Commit attribution**: commits are authored
  `Cursor Agent <cursoragent@cursor.com>` with a
  `Co-authored-by: <github-user>` trailer.
- Env facts: Node v22 available (hooks can rely on `node`), `HOME=/home/ubuntu`,
  workspace at `/workspace`, `CLAUDE_PROJECT_DIR` amusingly present,
  `cursor_version` reported as a generic `1.0.0`.

Design consequence: the passive-capture hook synthesizes Polygraph
`AgentLogLine` records directly from hook events (user-prompt, tool-use +
tool-result, text; thinking pending `afterAgentThought` sampling) and POSTs
them to the capture endpoints, with the `bc-`/`run-` ids announced so nx-api
can optionally enrich from the Cloud Agents API. No transcript file, no
detached tailer process.

## What to extract from the results

- Transcript file format: JSONL? One object per message? Field names for
  text, thinking, tool calls, results. This defines the capture adapter.
- Hook input reality vs docs: exact fields for each event, presence of
  `conversation_id`, `transcript_path`, `user_email`.
- Environment: which `CURSOR_*` vars exist; whether anything identifies the
  agent id (`bc_...`) so passive capture can be correlated with the API.
- Whether `/tmp` state persists across hook invocations within a run, and
  across follow-up runs on the same agent (the events file accumulating
  across runs answers this).
- Whether an OIDC identity token is mintable from inside the VM (a possible
  hook-auth alternative to dashboard secrets).
