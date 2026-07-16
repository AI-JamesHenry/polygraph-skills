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
non-secret activation marker for the current provider session.

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
6. Activate continued capture by running this plugin helper exactly once:

   ```text
   node "${CLAUDE_PLUGIN_ROOT}/hooks/background-capture-lifecycle.mjs" activate
   ```

   The helper writes only the current provider session ID and an activation
   timestamp to a mode-`0600` file under `~/.polygraph/background-capture/`.
   It does not read or persist an OAuth token. Require the command to succeed.
7. Print the non-secret Polygraph session ID and URL. Only then continue with the user's
   task.

Do not call `background_capture_event` yourself during start. The connector
records the initial task atomically with session creation. After activation,
the plugin-level `UserPromptSubmit` and `Stop` hooks require Claude to call the
already-connected OAuth connector for each later prompt and response without
placing a Polygraph secret in the worker. If either required capture call fails,
stop before further task work and report the failure.

Do not create or edit `.claude/settings.json`, `.claude/settings.local.json`, or
any other persistent hook configuration. Do not invoke `connector_probe`.

## Current capture boundary

This spike captures the explicit skill task, its final assistant response, and
later user prompts and final assistant responses in the same Claude provider
session, including after that environment pauses and resumes. Sessions that
never invoke this skill do not transmit prompt content to Polygraph.

It does not yet capture every intermediate tool call or intermediate assistant
message, and it does not prove recovery after a fresh worker replacement or a
Polygraph connector/backend restart. Report that boundary accurately; do not
imply that a complete provider-native transcript was captured.

The provider continues to own checkout, branch creation, commits, pushes, and
pull request creation. Do not create or associate a pull request unless the
user's task asks for one.
