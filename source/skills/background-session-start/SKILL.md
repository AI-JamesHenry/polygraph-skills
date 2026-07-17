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
   - `capture.received` equal to `1`.
6. Activate continued capture by running this plugin helper exactly once:

   ```text
   node "${CLAUDE_PLUGIN_ROOT}/hooks/background-capture-lifecycle.mjs" activate && sleep 2
   ```

   The helper writes only the current provider session ID and an activation
   timestamp to a mode-`0600` file under `~/.polygraph/background-capture/`.
   It also merges Polygraph-owned native `mcp_tool` hooks into the isolated
   checkout's local-only `.claude/settings.local.json`, which is the hook scope
   loaded by Claude Web. The helper adds that path to `.git/info/exclude`, so it
   never dirties or changes the tracked repository. Those hooks call only the
   already-authorized connector; existing local settings and hooks are
   preserved. The two-second delay gives Claude's settings watcher time to load
   the hooks before repository work begins. The activation marker and hooks
   deliberately survive `SessionEnd`, because Claude Web uses that event when
   pausing a worker between ordinary turns. It does not read or persist an
   OAuth token. Require the command to succeed.
7. Print the non-secret Polygraph session ID and URL. Only then continue with the user's
   task.

Do not call `background_capture_event` yourself during start. The connector
records the initial task atomically with session creation. After activation,
native Claude hooks call the already-connected OAuth connector directly. They
do not ask the model to relay capture events and do not place a Polygraph secret
in the worker. Ongoing hook delivery is best-effort because Claude treats hook
transport failures as non-blocking.

Do not create or edit `.claude/settings.json`. The activation helper owns only
its exact entries in the local-only, Git-excluded `.claude/settings.local.json`;
do not modify or commit that file yourself. Do not invoke `connector_probe`.

## Current capture boundary

This spike captures exact user prompts, final assistant text, tool
calls/results/failures, and the lifecycle events exposed by Claude Code hooks in
the same provider session, including after pause/resume. Sessions that never
invoke this skill do not transmit prompt content to Polygraph.

Claude does not expose thinking text through hooks, and its provider transcript
contains only empty signed thinking blocks in this environment. Capture is
therefore deliberately near-parity rather than a byte-for-byte provider-native
transcript. Fresh worker replacement is not yet proven. Report those boundaries
accurately.

The provider continues to own checkout, branch creation, commits, pushes, and
pull request creation. Do not create or associate a pull request unless the
user's task asks for one.
