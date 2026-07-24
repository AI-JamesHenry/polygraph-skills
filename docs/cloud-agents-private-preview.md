# Polygraph cloud agents — private preview

This fork branch adds an explicitly opt-in Polygraph cloud-session skill for
Claude Code cloud agents. It installs as the `james-polygraph` plugin, so it
can coexist with the official `polygraph` plugin.

## Installation

Install from a pinned commit of this fork. In the checkout used by the Claude
Code environment setup:

```sh
git checkout <pinned commit>
npm ci
npm run build
claude plugin marketplace add "$PWD"
claude plugin install james-polygraph@james-polygraph-plugins
```

The local marketplace points at `./dist/claude`, so build before installing.
The built Claude plugin contains only the skills, agents, hooks (including the
standalone transcript sidecar), and documentation. It deliberately contains no
`.mcp.json`, no local Polygraph MCP server, and no Polygraph CLI: hosted
session creation and capture do not require them.

## Connector

Polygraph is configured separately as a hosted remote MCP connector whose
display name must be `Polygraph`. The connector URL is provided by Polygraph
to preview participants and is not part of this repository. The external agent
provider owns the OAuth access and refresh tokens; no Polygraph OAuth or
service-account credential is placed in the agent worker, and no
`POLYGRAPH_SERVICE_ACCOUNT_*`-style environment variables are used or
supported.

## Opt-in and capture boundary

Capture starts only when the user explicitly invokes the skill with their real
task:

```text
/james-polygraph:background-session-start <real user task>
```

Claude Code sessions routed from Slack expose
`CLAUDE_CODE_ENTRYPOINT=claude_in_slack` but deliver the namespaced command as
literal prompt text instead of applying the Cloud UI's slash-command
expansion. On exactly that entrypoint, the dormant `UserPromptSubmit` hook
recognizes an invocation-shaped command line with a non-empty task, loads the
packaged Claude skill, substitutes the task, and injects the trusted
instructions into the current session. Other entrypoints, prose mentions,
missing tasks, and sessions with active capture do not take this path.

The skill calls the hosted `background_session_start` tool once, validates the
returned contract, and activates a detached transcript sidecar from the byte
offset of the opt-in prompt. Conversation content from before the explicit
opt-in is not uploaded. Sessions that never invoke the skill transmit nothing:
the preloaded plugin hooks are inert without an activation marker and, after
activation, only keep the sidecar healthy (including across a worker
pause/resume).

The Polygraph session URL printed by the skill and the provider (Claude)
session URL are distinct links to different systems.

### Temporary invocation-origin diagnostics

During the private preview, the capture lifecycle hook appends one structured
record for every `SessionStart` and `UserPromptSubmit` event to:

```text
~/.polygraph/logs/background-invocation-debug.jsonl
```

The file is mode `0600` and rotates at 5 MB. Records list every environment
and hook-input field name, plus values for fields whose names suggest
invocation provenance (`CLAUDE`, `SLACK`, `ENTRYPOINT`, `SOURCE`, and similar).
Credential-like values, prompt/message/context content, and raw IDs are
redacted. Remove this temporary diagnostic after the Slack bridge is verified.

## Provider session URL input (integration boundary)

The hosted contract requires the exact URL of the current Claude session.
Claude cloud sessions expose `CLAUDE_CODE_REMOTE_SESSION_ID` with a `cse_`
prefix, and Claude documents that the transcript URL uses the same opaque
identifier with a `session_` prefix. The plugin performs only that documented
conversion, validates the result fail-closed
(`hooks/provider-session-url.mjs`), and never fabricates a URL from
`CLAUDE_CODE_SESSION_ID`. If the remote session ID is unavailable or invalid,
the skill stops before any repository work.

## Local state and security

Activation writes marker and sidecar-runtime files with mode `0600` under:

```text
~/.polygraph/background-capture/
```

The marker contains only the provider session ID, transcript path and start
offset, activation timestamp, capture mode, and the session-scoped capture
capability URL. The capability is secret, bound to this Polygraph session and
provider session, cannot read Polygraph data, and is not an OAuth credential.
It is never printed, logged, or committed. No OAuth access or refresh token is
ever read or stored by the plugin.

## Deactivation and uninstall

To stop capture for the current session:

```text
node "${CLAUDE_PLUGIN_ROOT}/hooks/background-capture-lifecycle.mjs" deactivate
```

This stops the sidecar and removes the marker and runtime files.
Uninstalling the plugin removes the hooks; any remaining state can be deleted
by removing `~/.polygraph/background-capture/`.

## Pull request management

A cloud session creates pull requests with the remote `background_pr_create`
MCP tool, not `gh` or a generic GitHub MCP server. The server validates the
call end to end: it checks that the calling session owns the target
Polygraph session, that the session has access to the target repository,
that the branch was actually pushed by this session, and it always opens the
PR as a draft. It also protects against a duplicate PR on a branch that
already has one open. None of that validation lives in the plugin — the
plugin has no way to check session ownership, repo access, or branch
provenance, and does not try to.

Marking a PR ready for review, and editing an existing PR's title, body, or
base branch, are human actions taken from the Polygraph session page in the
web UI. An autonomous cloud session does not do either on its own.

Once a session activates capture (see "Opt-in and capture boundary" above),
two preloaded plugin hooks support this:

- **Branch observation (backbone).** A `PostToolUse` hook resolves the
  current git branch after every tool call and, whenever the checked-out
  branch differs from the last one it reported (fire-on-change, not
  fire-once: switching `A` -> `B` -> `A` reports `branch_active` for `A`
  again), posts `POST {captureHookUrl}/pr` with `kind: "branch_active"`. The
  server dedupes by `eventId`, so a repeat report for the same branch is a
  no-op. This signal feeds Polygraph's webhook-based adoption of
  provider-created PRs: because the claude.ai "Create PR" button is
  provider-side and cannot be wired into a Polygraph-tracked branch
  directly, Polygraph instead adopts the PR server-side over a webhook once
  the branch behind it has been observed here.

  The same hook also reports `kind: "branch_pushed"` for the current branch
  when the tool call that just ran was a successful, standalone `git push`
  (no chaining, piping, or redirection — a compound command is left for the
  server-side push webhook to record instead). The server stores that as
  pushed-branch evidence, which is what makes the branch eligible for
  `background_pr_create` without waiting on the GitHub push webhook. The
  webhook remains the stronger signal (signature-verified, carries the head
  SHA), and the server re-verifies the branch against the repository before
  creating any PR, so this report is workflow eligibility, not a security
  boundary.
- **PR-command redirect.** A `PreToolUse` hook denies `gh pr create`,
  `gh pr ready`, `gh pr edit`, and any MCP tool named
  `mcp__*__create_pull_request` before they run, each with a reason pointing
  the agent at the right alternative: call `background_pr_create` instead of
  `gh` for creation, and ask the user to act from the Polygraph session page
  for marking ready or editing. Detection is non-anchored and quote-aware —
  it recognizes the command anywhere in the line (including after an
  env-var prefix, `sudo`, or a compound operator like `&&`) but ignores a
  matching phrase that only appears inside a quoted flag value — and it
  denies every match unconditionally: there is no rewrite path, no
  allowed shape, and no `--draft` flag that lets a command through.
  `git push` is left alone; branch observation covers it instead.

**Hooks here are routing/UX only, not a security boundary.** Every guarantee
this section describes — session ownership, repo access, branch
eligibility, always-draft, protection against a duplicate PR — is enforced
server-side by `background_pr_create`, independent of whether the redirect
hook runs, is bypassed, or is misconfigured; the hook's only job is to give
the agent a fast, local nudge toward the right tool instead of a slower,
more confusing server-side rejection.

Both hooks share the same opt-in boundary as the rest of this preview:
without the activation marker, each is a silent local no-op — no filesystem
writes beyond checking for the marker, and no network calls (the redirect
hook makes no network calls even when active; only the branch observer
does).

## Not included in this preview

- No Codex or OpenCode cloud-agent capture.
- No local Polygraph MCP server or Polygraph CLI requirement.
