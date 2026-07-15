---
name: background-session-start
description: Start a fail-closed, single-repository Polygraph session from inside a provider-managed background agent, bind parent transcript capture, then continue the user's real task.
argument-hint: "<user task>"
{% if platform == "claude" %}
allowed-tools:
  - Bash
  - mcp__plugin_james-polygraph_james-polygraph-mcp
{% endif %}
---

# Start a Background Polygraph Session

This WIP skill is invoked as:

```text
/james-polygraph:background-session-start $ARGUMENTS
```

`$ARGUMENTS` is the user's real task. Preserve it verbatim. Polygraph initialization is a mandatory precondition to that task, not a best-effort side action.

This skill does not configure or enable public ingress. It assumes an operator
has already reviewed and explicitly approved the public hostname, exact
allowlisted routes, disposable credential lifetime, and transcript data that
will cross the ingress. If that approval is not established, stop before the
first MCP call and point to `docs/claude-code-web-background-spike.md`.

## Fail-closed bootstrap

Complete these steps in order. If any step fails, report the failure without exposing credentials and stop before repository work.

1. Confirm these environment variables are present, but never print their values:
   - `POLYGRAPH_API_URL`
   - `POLYGRAPH_ORG_ID`
   - `POLYGRAPH_SERVICE_ACCOUNT_CLIENT_ID`
   - `POLYGRAPH_SERVICE_ACCOUNT_SECRET`
2. Confirm the current directory is inside exactly one Git repository.
3. Resolve the canonical `owner/repository` slug from that checkout's configured remote. Do not accept an unrelated repository argument.
4. Call the WIP MCP `background_session_start` tool with the user's task from `$ARGUMENTS`. The MCP must independently resolve and validate the current repository root and canonical slug; do not pass caller-supplied repository identity as authority.
5. Require a result containing all of:
   - `sessionId`
   - `polygraphSessionUrl`
   - the same canonical repository slug
   - `capture.status` equal to `started`
   - a non-empty `capture.providerSessionId`
6. Print the session ID and URL. Only then continue with the user's task.

The WIP MCP owns machine authentication, repository authorization, in-place one-repository session creation, pending transcript mapping binding, parent sidecar startup, and capture acknowledgement. Do not use repository discovery, `/prepare`, cloning, repository addition, child delegation, or Polygraph-managed Git operations in this flow.

## Retained provider obligations

The provider owns checkout, branch creation, commits, pushes, and pull request creation. Polygraph only records the resulting metadata.

- After the provider successfully pushes, call `record_pushed_branch` with the branch and current head SHA.
- After the provider creates a pull request, call `associate_pr` with its URL.
- Keep the Polygraph session description current enough for a local continuation to understand the goal, progress, successful approach, and next steps.
- Finalize the session only when it is safe to do so.

> [!WARNING]
> For this spike, current Polygraph completion closes open or draft pull requests. Call completion only after the associated pull request is merged or closed. If the pull request remains open or draft, update the session description and leave the session open.

Never call Polygraph `create_pr`; the provider creates the pull request. Never expose the service-account secret in output, logs, generated commands, or the transcript.
