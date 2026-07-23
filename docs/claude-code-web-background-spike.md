# Claude Code web background-session spike

This fork installs as `james-polygraph`, alongside the official `polygraph`
plugin. For Claude Code web it deliberately ships no local Polygraph MCP and no
machine credential. All Polygraph tools come from the separately connected
`polygraph-oauth-spike` remote custom connector.

## 1. Build and validate the plugin

Run this in the fork checkout used by the Claude Code web environment setup:

```sh
npm ci
npm test
npm run build
```

The local marketplace points at `./dist/claude`, so build before adding it:

```sh
claude plugin marketplace add "$PWD"
claude plugin install james-polygraph@james-polygraph-plugins
```

The generated `dist/claude` package must not contain `.mcp.json` or `wip-mcp/`.
That prevents a missing remote connector from silently falling back to the old
service-account flow.

## 2. Connect the account-level OAuth connector once

Add the restricted remote MCP endpoint as the `polygraph-oauth-spike` custom
connector in Claude. Complete its account-level OAuth connection in the local
Polygraph UI. This is an installation/connection action, not something an
unattended background task performs for each run.

The spike ingress is a Tailscale Funnel to Ocean's loopback-bound OAuth bridge.
It exposes only the MCP transport and OAuth discovery/authorization/token
routes implemented by that bridge. It does not expose the Polygraph UI, general
nx-api routes, MongoDB, Valkey, repository discovery, or service-account
administration.

Do not put `POLYGRAPH_SERVICE_ACCOUNT_*`, `POLYGRAPH_API_URL`,
`POLYGRAPH_APP_URL`, or `POLYGRAPH_ORG_ID` in the Claude environment. The OAuth
connector owns the connected Polygraph user/account identity and authorization.

For the local spike, keep the Funnel hostname in Claude Code web's outbound
network allowlist. In production, the hosted Polygraph MCP would replace the
local bridge and Funnel.

## 3. Opt in from the task prompt

Start capture with the explicit skill and the real task in the same prompt:

```text
/james-polygraph:background-session-start <real user task>
```

When a coding task is routed from Slack, Claude receives that command as
literal prompt text rather than as an already-expanded slash command, and the
hosted worker does not expose a Skill tool that can perform the expansion
later. The plugin's dormant `UserPromptSubmit` hook therefore detects only an
invocation-shaped line containing the exact namespaced command, reads the
packaged skill body, substitutes the real task, and injects those trusted
instructions into the parent session before repository work. The hook does not
start a session, call the connector, or transmit prompt content itself. If the
packaged skill cannot be expanded, prompt processing is blocked. If the
`polygraph-oauth-spike` connector is unavailable, the expanded workflow still
fails closed before repository work.

For this spike, the Claude package also emits the same workflow at
`commands/background-session-start.md`. This deliberately supplies both the
current plugin-skill discovery path and the legacy plugin-command discovery
path. Both artifacts are generated from the same rendered source so their
consent boundary and fail-closed behavior remain identical.

The skill resolves the repository from the checkout, starts the session through
the authorized connector, requires positive initial-capture acknowledgement,
and writes a non-secret local activation marker keyed by the Claude provider
session ID. It fails closed before repository work if any step is incomplete.

After opt-in, preloaded plugin hooks require the current prompt or final response
to be sent through the already-authorized connector. The marker survives a
Claude Code web environment pause and resume. A different provider session has
no matching marker, so ordinary sessions transmit no prompt content to
Polygraph.

The current spike captures user prompts and final assistant responses. It does
not capture every intermediate tool call or intermediate assistant message, and
does not yet prove recovery after connector/backend restart or a replacement
worker with a fresh filesystem.

## 4. Verify the boundary

1. Invoke the skill in a fresh Claude Code web session and confirm it returns a
   non-empty Polygraph session ID and URL.
2. Send a follow-up without invoking the skill. Confirm both the user prompt and
   final response append to the same Polygraph agent log.
3. Pause and resume the Claude environment, then repeat step 2. Confirm the same
   session receives both events.
4. Start a brand-new Claude session without invoking the skill. Send a benign
   prompt and confirm no new Polygraph session or log events appear.
5. Temporarily disconnect or deny the capture tool in an opted-in session and
   confirm the hook stops task work instead of silently continuing.

## 5. Spike teardown

Disable the Tailscale Funnel and stop the local OAuth bridge when testing is
finished. Disconnect the custom connector if the spike authorization should no
longer remain active. No Claude environment secret needs revocation because the
worker never receives the OAuth token or a Polygraph service-account secret.
