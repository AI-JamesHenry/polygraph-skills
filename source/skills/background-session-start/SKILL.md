---
name: background-session-start
description: Explicitly start an OAuth-authenticated Polygraph session for the current Claude Code web task and capture the bounded initial prompt and final response.
argument-hint: "<user task>"
{% if platform == "claude" %}
allowed-tools:
  - Bash
  - mcp__polygraph-oauth-spike__background_session_start
hooks:
  Stop:
    - hooks:
        - type: mcp_tool
          server: polygraph-oauth-spike
          tool: background_capture_event
          input:
            providerSessionId: "${session_id}"
            eventType: assistant_response
            content: "${last_assistant_message}"
{% endif %}
---

# Start a Background Polygraph Session

This WIP skill is invoked explicitly as:

```text
/james-polygraph:background-session-start $ARGUMENTS
```

`$ARGUMENTS` is the user's real task. Preserve it verbatim. Invoking this skill
is the opt-in boundary: do not create a Polygraph session, send prompt content,
or install persistent capture hooks unless the user invoked the skill.

This skill assumes the user has already connected the account-level
`polygraph-oauth-spike` custom connector. The connector owns OAuth and
authorization. Do not request, read, print, or persist a Polygraph credential.

## Fail-closed start

Complete these steps in order. If any step fails, report the failure and stop
before repository work.

1. Confirm the current directory is inside exactly one Git repository.
2. Resolve the canonical `owner/repository` slug from that checkout's configured
   remote. Do not accept a caller-supplied repository identity as authority.
3. Confirm `CLAUDE_CODE_SESSION_ID` is present, but never print its value.
4. Call `background_session_start` from `polygraph-oauth-spike` exactly once
   with:
   - `task`: `$ARGUMENTS` verbatim;
   - `repository`: the canonical slug from step 2;
   - `providerSessionId`: the current `CLAUDE_CODE_SESSION_ID`.
5. Require a result containing all of:
   - `status` equal to `started`;
   - a non-empty `sessionId`;
   - a non-empty `sessionUrl`;
   - the same canonical repository slug;
   - `capture.status` equal to `started`;
   - `capture.eventType` equal to `user_prompt`;
   - `capture.received` equal to `1`.
6. Print the non-secret session ID and URL. Only then continue with the user's
   task.

Do not call `background_capture_event` yourself. The connector records the
initial task atomically with session creation. The skill-scoped `Stop` hook
above sends the final assistant response through the already-connected OAuth
connector without placing a Polygraph secret in the worker.

Do not create or edit `.claude/settings.json`, `.claude/settings.local.json`, or
any other persistent hook configuration. Do not invoke `connector_probe`.

## Current capture boundary

This spike captures the explicit skill task and the final assistant response
for that skill run. It does not yet prove complete intermediate tool logging or
continued capture after a later user follow-up, resume, worker replacement, or
connector restart. Report that boundary accurately; do not imply that a full
provider transcript was captured.

The provider continues to own checkout, branch creation, commits, pushes, and
pull request creation. Do not create or associate a pull request unless the
user's task asks for one.
