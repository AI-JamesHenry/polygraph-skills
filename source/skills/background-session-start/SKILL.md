---
name: background-session-start
description: Explicitly start OAuth-authenticated Polygraph capture for the current Claude Code web session, including follow-up prompts and responses after resume.
argument-hint: "<user task>"
{% if platform == "claude" %}
allowed-tools:
  - Bash
  - mcp__polygraph-oauth-spike__background_session_start
{% endif %}
---

# Start a Background Polygraph Session

This WIP skill is invoked explicitly as:

```text
/james-polygraph:background-session-start $ARGUMENTS
```

`$ARGUMENTS` is the user's real task. Preserve it verbatim. Invoking this skill
is the opt-in boundary: do not create a Polygraph session, send prompt content,
or activate persistent capture unless the user invoked the skill. Plugin-level
capture hooks are preloaded but perform a local no-op until this skill writes a
private activation marker for the current provider session.

This skill assumes the user has already connected the account-level
`polygraph-oauth-spike` custom connector. The connector owns OAuth and
authorization. Do not request, read, print, or persist a Polygraph credential.

## Fail-closed start

Complete these steps in order. If any step fails, report the failure and stop
before repository work.

1. Confirm the current directory is inside exactly one Git repository.
2. Resolve the canonical `owner/repository` slug from that checkout's configured
   remote. Do not accept a caller-supplied repository identity as authority.
3. Use Bash to read the exact, non-empty value of `CLAUDE_CODE_SESSION_ID`
   from the current process environment. Keep that concrete value out of the
   user-facing response, but retain it for the MCP argument in step 4. An MCP
   tool call is structured JSON and does not perform shell expansion, so never
   pass `$CLAUDE_CODE_SESSION_ID`, `${CLAUDE_CODE_SESSION_ID}`, or the variable
   name itself as the argument value.
4. Call `background_session_start` from `polygraph-oauth-spike` exactly once
   with:
   - `task`: `$ARGUMENTS` verbatim;
   - `repository`: the canonical slug from step 2;
   - `providerSessionId`: the concrete value resolved in step 3.
5. Require a result containing all of:
   - `status` equal to `started`;
   - a non-empty `sessionId`;
   - a non-empty `sessionUrl`;
   - the same canonical repository slug;
   - `providerSessionId` exactly equal to the concrete value resolved in step
     3;
   - `capture.status` equal to `started`;
   - `capture.eventType` equal to `user_prompt`;
   - `capture.received` equal to `1`;
   - a non-empty HTTPS `captureHookUrl`. Treat this URL as a scoped,
     short-lived append capability: never print it or include it in the
     user-facing response.
6. Activate continued capture by running this plugin helper exactly once:

   ```text
   node "${CLAUDE_PLUGIN_ROOT}/hooks/background-capture-lifecycle.mjs" activate "<captureHookUrl from step 5>"
   ```

   The helper locates the current Claude JSONL transcript, records the byte
   offset of this opted-in skill invocation, and starts a detached transcript
   sidecar. The sidecar uses the same production Claude transcript adapter and
   secret redactor as a local Polygraph session, then POSTs normalized log
   lines only to the session-bound capability minted by the already-authorized
   connector. It captures from the opt-in prompt onward; earlier prompts in
   the same Claude session are not transmitted. The helper writes only the
   current provider session ID, transcript path and start offset, activation
   timestamp, and short-lived append capability to mode-`0600` files under
   `~/.polygraph/background-capture/`. It never reads or persists an OAuth
   token. Preloaded plugin hooks remain inert without this marker and act only
   as sidecar health/restart triggers after activation, including after Claude
   pauses and resumes a worker. They do not duplicate transcript events, need
   a separate Claude tool approval, or require a settings reload. Require the
   activation command to succeed.
7. Print the non-secret Polygraph session ID and URL. Only then continue with the user's
   task.

Do not call `background_capture_event` yourself during start. The connector
records the initial task atomically with session creation. After activation,
the detached sidecar tails the provider transcript directly; the model does
not relay capture events and no long-lived Polygraph credential is placed in
the worker. The capability cannot read Polygraph data and is bound to this
provider session. Transcript delivery is retried by replaying from the stable
opt-in byte offset; source-offset event IDs make restarts idempotent.

Do not create or edit `.claude/settings.json` or
`.claude/settings.local.json`. Continued capture is owned by the plugin hooks
and the mode-`0600` activation marker. Do not invoke `connector_probe`.

## Current capture boundary

This spike uses the same Claude JSONL adapter as local Polygraph capture. From
the explicit opt-in prompt onward it can preserve user prompts, assistant text
and available thinking blocks, structured tool calls/results/failures, system
and lifecycle entries, and skill-load correlation in the same provider
session, including warm follow-ups and pause/resume. Sessions that never invoke
this skill do not transmit transcript content to Polygraph. Provider records
that contain only an opaque or empty signed thinking block cannot be expanded;
report that provider limitation accurately rather than claiming hidden
reasoning was captured.

The provider continues to own checkout, branch creation, commits, pushes, and
pull request creation. Do not create or associate a pull request unless the
user's task asks for one.
