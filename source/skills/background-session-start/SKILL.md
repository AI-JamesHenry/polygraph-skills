{%- if platform == "claude" -%}
---
name: background-session-start
description: Explicitly start a Polygraph cloud session for the current Claude Code cloud-agent session, with cloud-agent capture of the transcript from this opt-in onward.
argument-hint: "<user task>"
allowed-tools:
  - Bash
  - mcp__Polygraph__background_session_start
---

# Start a Polygraph Cloud Session

This skill is invoked explicitly as:

```text
/james-polygraph:background-session-start $ARGUMENTS
```

`$ARGUMENTS` is the user's real task. Preserve it verbatim. Invoking this
skill is the opt-in boundary for cloud-agent capture: do not create a
Polygraph cloud session, send prompt content, or activate persistent capture
unless the user invoked the skill. Plugin-level hooks are preloaded but
perform a local no-op until this skill writes a private activation marker for
the current provider session.

This skill assumes Polygraph is configured separately as a hosted remote MCP
connector named `Polygraph`. The connector owns OAuth and authorization. Do
not request, read, print, or persist a Polygraph credential. If the
connector's `background_session_start` tool is unavailable, stop and report
that the `Polygraph` connector is not connected; do not attempt a fallback.

## Fail-closed start

Complete these steps in order. If any step fails, report the failure and stop
before repository work.

1. Confirm the current directory is inside exactly one Git repository.
2. Resolve the canonical `owner/repository` slug from that checkout's
   configured Git remote. Do not accept a caller-supplied repository identity
   as authority.
3. Use Bash to read the exact, non-empty value of `CLAUDE_CODE_SESSION_ID`
   from the current process environment. Keep that concrete value out of the
   user-facing response, but retain it for the MCP argument in step 5. An MCP
   tool call is structured JSON and does not perform shell expansion, so never
   pass `$CLAUDE_CODE_SESSION_ID`, `${CLAUDE_CODE_SESSION_ID}`, or the
   variable name itself as the argument value.
4. Obtain the concrete URL of the current Claude cloud session from the
   provider-managed `CLAUDE_CODE_REMOTE_SESSION_ID`. Claude documents that
   this value uses a `cse_` prefix while the visible transcript URL uses the
   same opaque identifier with a `session_` prefix. Resolve and validate that
   provider-defined conversion by running:

   ```text
   node "${CLAUDE_PLUGIN_ROOT}/hooks/provider-session-url.mjs" --remote-session-id "${CLAUDE_CODE_REMOTE_SESSION_ID}"
   ```

   Use the exact URL the command prints. Never substitute
   `CLAUDE_CODE_SESSION_ID`, fabricate another URL, or pass an unexpanded
   variable name. If `CLAUDE_CODE_REMOTE_SESSION_ID` is unavailable or
   validation fails, stop and report that the provider session URL is
   unavailable.
5. Call `background_session_start` from the `Polygraph` connector exactly
   once with:
   - `task`: `$ARGUMENTS` verbatim;
   - `repository`: the canonical slug from step 2;
   - `providerSessionId`: the concrete value resolved in step 3;
   - `providerSessionUrl`: the exact validated URL from step 4.
6. Require a result containing all of:
   - `status` equal to `started`;
   - a non-empty `sessionId`;
   - a non-empty `sessionUrl`;
   - a non-empty `organizationId`;
   - `repository` equal to the canonical slug from step 2;
   - `providerSessionId` exactly equal to the concrete value resolved in
     step 3;
   - `providerSessionUrl` exactly equal to the validated URL from step 4;
   - `capture.status` equal to `started`;
   - `capture.eventType` equal to `user_prompt`;
   - `capture.received` equal to `1`;
   - a non-empty HTTPS `captureHookUrl`. Treat this URL as a secret,
     session-scoped, short-lived append capability: never print it or include
     it in the user-facing response.
7. Activate continued cloud-agent capture by running this plugin helper
   exactly once:

   ```text
   node "${CLAUDE_PLUGIN_ROOT}/hooks/background-capture-lifecycle.mjs" activate "<captureHookUrl from step 6>"
   ```

   The helper locates the current Claude JSONL transcript, records the byte
   offset of this opted-in skill invocation, and starts a detached transcript
   sidecar. The sidecar uses the same Claude transcript adapter and secret
   redactor as local Polygraph capture, then POSTs normalized log lines only
   to the session-bound capability. It captures from the opt-in prompt
   onward; earlier content in the same Claude session is not transmitted. The
   helper writes only the current provider session ID, transcript path and
   start offset, activation timestamp, and the short-lived append capability
   to mode-`0600` files under `~/.polygraph/background-capture/`. It never
   reads or persists an OAuth token. Preloaded plugin hooks remain inert
   without this marker and act only as sidecar health/restart triggers after
   activation, including after the provider pauses and resumes a worker. They
   do not duplicate transcript events. Require the activation command to
   succeed.
8. Print the non-secret Polygraph session ID and Polygraph session URL (they
   are distinct from the provider session URL). Only then continue with the
   user's task.

Do not call `background_capture_event` yourself during start or afterwards.
The hosted API records the initial task atomically with session creation.
After activation, the detached sidecar tails the provider transcript
directly; the model does not relay capture events and no Polygraph credential
is placed in the worker. The capability cannot read Polygraph data and is
bound to this provider session. Transcript delivery is retried by replaying
from the stable opt-in byte offset; source-offset event IDs make restarts
idempotent.

Do not create or edit `.claude/settings.json` or
`.claude/settings.local.json`. Continued capture is owned by the plugin hooks
and the mode-`0600` activation marker.

## Capture boundary

From the explicit opt-in prompt onward, cloud-agent capture preserves user
prompts, assistant text and available thinking blocks, structured tool
calls/results/failures, system and lifecycle entries, and skill-load
correlation in the same Polygraph cloud session, including follow-ups and
pause/resume. Sessions that never invoke this skill do not transmit
transcript content to Polygraph. Provider records that contain only an opaque
or empty signed thinking block cannot be expanded; report that provider
limitation accurately rather than claiming hidden reasoning was captured.

The provider continues to own checkout, branch creation, commits, pushes, and
pull request creation. Do not create or associate a pull request unless the
user's task asks for one.
{%- endif %}
