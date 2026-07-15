# Claude Code web background-session spike

This fork installs as `james-polygraph`, alongside the official `polygraph` plugin. It is intentionally pinned to a vendored Ocean WIP MCP and must never fall back to `@polygraph/mcp@latest`.

## 1. Vendor the matching Ocean MCP

Build the complete runnable MCP/CLI distribution from the matching Ocean spike branch:

```sh
pnpm nx run local-dev:build-background-agent-wip
```

Copy the contents of Ocean's
`dist/tools/polygraph/background-agent-wip/` into
`source/wip-mcp/vendor/` in this checkout so the entrypoint exists at:

```text
source/wip-mcp/vendor/bin/polygraph-mcp.mjs
```

Preserve all runtime files the entrypoint imports. Do not copy credentials into the plugin tree.

## 2. Build and validate the plugin

Run this in the fork checkout used by the Claude Code web environment setup:

```sh
npm ci
npm test
npm run build
node dist/claude/wip-mcp/bin/polygraph-mcp.mjs --help
```

The final command must reach the vendored WIP MCP. A `Missing vendored Polygraph WIP MCP entrypoint` error means the Ocean distribution was not copied to the required location.

The local marketplace points at `./dist/claude`, so build before adding the marketplace:

```sh
claude plugin marketplace add "$PWD"
claude plugin install james-polygraph@james-polygraph-plugins
```

Use the same checkout and dedicated spike branch in the provider setup. Do not install or patch over the official `polygraph` plugin.

## 3. Configure the disposable machine identity

No Funnel is enabled by this plugin. Before anyone enables one, present the
operator with the exact hostname, command, credential lifetime, and data below,
then wait for explicit approval. A Funnel hostname is open to the entire public
internet, including callers that do not use Tailscale.

Expose only Ocean's loopback-bound deny-by-default proxy. Its complete public
surface is machine `whoami`, single-repository session init/read, metadata and
step writes, signed step-blob reads/writes, pushed-branch recording, PR
association, and completion. It must return `404` for the UI, session lists and
search, repository discovery, `/prepare`, child-agent routes, service-account
administration, and every general nx-api/file-server route.

The requests can disclose the disposable Basic-auth credential, organization
and repository identity, provider session ID, session metadata, commands, file
paths, source excerpts, tool output, branches, SHAs, and pull-request metadata.
Signed blob URLs are bearer capabilities. Completion can close open or draft
pull requests. The proxy has no public rate limiter or body-size limit, so use
only an attended foreground Funnel for a short test window.

Before the first data-bearing request:

1. Verify the proxy's allowlist locally, including negative probes for `/`, the
   session-list route, and the internal service-account route.
2. Verify `tailscale funnel status --json` shows no unexpected listeners.
3. After approval, run only
   `tailscale funnel --https=443 http://127.0.0.1:4325` without `--bg`.
4. Repeat the negative probes against the public hostname without credentials.
5. Ask again before public `whoami`; state that it sends the disposable
   credential and returns the organization/repository/scope binding.
6. Ask separately before the first transcript upload, and use synthetic,
   non-sensitive capture content for that smoke test.
7. Disable Funnel with `tailscale funnel --https=443 off` and revoke the
   credential immediately after the attended test.

See Ocean's `docs/polygraph-background-agent-spike.md` for the exact route/data
matrix, local credential commands, negative tests, and teardown runbook.

Provide these variables through the provider environment without echoing them in setup logs:

```text
POLYGRAPH_API_URL=https://<restricted-public-ingress>
POLYGRAPH_APP_URL=http://localhost:4204
POLYGRAPH_ORG_ID=<local-polygraph-org-id>
POLYGRAPH_SERVICE_ACCOUNT_CLIENT_ID=<repository-bound-client-id>
POLYGRAPH_SERVICE_ACCOUNT_SECRET=<disposable-secret>
```

`POLYGRAPH_APP_URL` is used only for the developer-facing link returned by the
skill; the provider does not contact it. The Tailscale Funnel ingress must
expose only the explicitly allowed machine/session routes and signed
`/file/polygraph-logs/...` requests. The local Polygraph UI stays private. Add
the Funnel hostname to Claude Code web's outbound network allowlist.

The loopback proxy gives upstream requests 30 seconds by default. For unusually
large capture uploads, set `POLYGRAPH_BACKGROUND_PROXY_UPSTREAM_TIMEOUT_MS` to
a larger bounded value before starting the proxy.

## 4. Make session start the first action

Begin the web task with the explicit command and the real task in the same prompt:

```text
/james-polygraph:background-session-start <real user task>
```

Do not permit repository work until the command reports a Polygraph session ID/URL and `capture.status: started`. Initialization is fail-closed.

The provider continues to own branch creation, commits, pushes, and pull request creation. After those provider operations, the agent records the pushed branch and associates the provider-created pull request with Polygraph.

> [!WARNING]
> For this spike, current Polygraph completion closes open or draft pull requests. Run completion only after the associated pull request is merged or closed. Otherwise update the session description and leave the session open.

## 5. Tear down immediately after the spike

Revoke the disposable service-account secret, stop the public ingress, remove the credential from the provider environment, and preserve only non-secret session/verification notes.
