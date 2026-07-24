#!/usr/bin/env node

// Polygraph PreToolUse PR-command redirect.
//
// Runs alongside the background-capture lifecycle hook and the PostToolUse
// branch observer (see background-capture-lifecycle.mjs for the
// activation-marker contract, and pr-branch-observer.mjs for the
// branch-identity backbone that still runs independently of this hook). With
// an active marker, this is the only hook in the plugin that blocks a tool
// call outright: `gh pr create/ready/edit` and the MCP
// `create_pull_request` tool are all denied, with a reason redirecting the
// agent to the right place instead. There is no rewrite path any more —
// earlier revisions of this hook rewrote a bare `gh pr create` in place to
// add `--draft` and let it through; that rewrite path is gone. PR creation
// now goes through the remote `background_pr_create` MCP tool, which the
// server validates end to end (session ownership, repo access, branch
// eligibility, always-draft, protection against duplicate PRs on the same
// branch). Marking a PR ready for review, and editing one, are human actions
// taken from the Polygraph session page in the web UI, not something an
// autonomous cloud session does on its own.
//
// This hook is routing/UX only: it exists to give the agent a fast, local
// "wrong tool, here's the right one" signal instead of a slow, confusing
// round trip through a server-side rejection. It is not a security boundary
// and enforces nothing by itself — every guarantee it references
// (session ownership, repo access, branch eligibility, draft enforcement,
// protection against clobbering an existing PR) is enforced server-side by
// background_pr_create, independent of whether this hook runs, is bypassed,
// or is misconfigured.
//
// Classification reuses the prior revision's quote-aware scanner: only a
// `gh pr create/ready/edit` token sequence that appears outside of quoting is
// treated as a real invocation, so a mention of one of those phrases inside a
// quoted `--title`/`--body` value is never mistaken for the command itself.
// Detection is non-anchored (matched anywhere in the command, not just at the
// start), so a command prefixed by an env-var assignment
// (`GH_TOKEN=x gh pr create`), another command (`time gh pr create`,
// `sudo gh pr create`), or hidden after a compound operator
// (`cd repo && gh pr create`) is still recognized and denied — compound vs.
// simple no longer changes the outcome the way it did when this hook still
// rewrote commands, since every recognized invocation now denies the same
// way regardless of shape. Without a marker, invocation is a silent local
// no-op: no filesystem writes beyond checking for the marker.
//
// This hook never needs the marker's captureHookUrl — only the marker's
// presence matters here — so it is never read out of the returned state,
// kept in a variable, or sent anywhere.

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBackgroundCapture } from './background-capture-lifecycle.mjs';

const HOOK_LOG_MAX_BYTES = 5 * 1024 * 1024;

const CREATE_DENY_REASON =
  'Polygraph cloud sessions create pull requests with the background_pr_create MCP tool, which opens a draft on a branch this session pushed. Call background_pr_create instead of gh.';

const READY_DENY_REASON =
  'Marking a Polygraph cloud-session PR ready for review is a human action. Ask the user to mark it ready from the Polygraph session page.';

const EDIT_DENY_REASON =
  'Editing a Polygraph cloud-session PR is a human action. Ask the user to update it from the Polygraph session page, or include the change when creating the PR with background_pr_create.';

const DENY_REASON_BY_SUBCOMMAND = {
  create: CREATE_DENY_REASON,
  ready: READY_DENY_REASON,
  edit: EDIT_DENY_REASON,
};

// MCP tools matching this name pattern are treated the same as `gh pr
// create`: an autonomous PR-creation call is redirected to
// background_pr_create regardless of which MCP server exposes it.
export const MCP_CREATE_PULL_REQUEST_PATTERN =
  /^mcp__.*__create_pull_request$/;

// `gh pr create|ready|edit` as a literal, whitespace-separated token
// sequence, matched anywhere in the command (not anchored at the start) and
// capturing which subcommand it is so the caller can pick the right deny
// reason. Word-bounded on both ends so `ghe pr create` and `gh prx create` do
// not match. See the module doc comment above for why non-anchored matching
// is deliberate.
const GH_PR_SUBCOMMAND_ANYWHERE_PATTERN = /\bgh\s+pr\s+(create|ready|edit)\b/;

// Walk `command` tracking single/double-quote state — a small quote-aware
// scanner, not a full shell tokenizer. Returns:
//   - blanked: same length as `command`, with the *contents* of quoted spans
//     replaced by spaces (the quote characters themselves stay in place).
//     Subcommand detection runs against this string, so a `gh pr
//     create`-shaped phrase sitting inside a quoted `--title`/`--body` value
//     can never be mistaken for the real invocation. Because it is the same
//     length as `command`, a match index found in `blanked` is also the
//     correct index into `command`.
//   - unbalanced: true if a quote was opened and never closed, OR if the
//     command ends in a lone backslash with nothing left to escape (see the
//     escape handling below) — both are ambiguous the same way, so both fall
//     back to scanning the raw command instead of the untrustworthy blanked
//     one.
//
// Backslash escaping mirrors real bash: outside all quoting and inside
// double quotes, an unescaped `\` escapes the next character, so `\"` never
// opens or closes a double-quoted span. Inside single quotes, bash honors no
// escapes at all, so `\` there is left completely untouched. An escaped pair
// is always blanked together (both bytes become spaces) so neither byte can
// be mistaken for a quote boundary downstream.
function scanQuotedRegions(command) {
  let blanked = '';
  let quote = null;
  let trailingEscape = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (ch === '\\' && quote !== "'") {
      const next = command[i + 1];
      if (next === undefined) {
        // Lone backslash at the end of the command: nothing to escape.
        // Ambiguous rather than literal, so it is folded into the
        // unbalanced/raw-scan fallback instead of being treated as ordinary
        // text.
        trailingEscape = true;
        blanked += quote ? ' ' : ch;
        continue;
      }
      // Consume the backslash together with the character it escapes as a
      // single literal unit: it cannot open/close a quote, so both bytes are
      // blanked regardless of current quote state.
      blanked += '  ';
      i++;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
        blanked += ch;
        continue;
      }
      blanked += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      blanked += ch;
      continue;
    }
    blanked += ch;
  }
  return {
    blanked,
    unbalanced: quote !== null || trailingEscape,
  };
}

function defaultRoot() {
  return join(homedir(), '.polygraph');
}

// Append a one-line JSON record of a hook failure to ~/.polygraph/logs/hooks.log.
// Duplicated locally rather than imported: each hook script in this plugin is
// invoked standalone as a subprocess, and every other Claude hook (see
// pr-branch-observer.mjs, record-session-mapping.mjs,
// reinject-polygraph-context.mjs, check-plugin-version.mjs,
// remind-subagents.mjs) carries its own copy of the same helper for that
// reason.
function logHookFailure(
  hook,
  error,
  meta = {},
  home = process.env.HOME?.trim() || homedir()
) {
  try {
    const logsDir = join(home, '.polygraph', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, 'hooks.log');

    try {
      if (statSync(logFile).size > HOOK_LOG_MAX_BYTES) {
        renameSync(logFile, `${logFile}.1`);
      }
    } catch {
      // no prior log, or rotation failed — ignore
    }

    const entry = {
      time: new Date().toISOString(),
      hook,
      pid: process.pid,
      ...meta,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    };
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  } catch {
    // Logging must never throw — a failing logger must not break the hook.
  }
}

function emptyResult() {
  return { exitCode: 0, stdout: '', stderr: '' };
}

function denyResult(reason) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
    stderr: '',
  };
}

// Classify a Bash tool_input.command against the redirect rules and return
// which subcommand it carries ('create' | 'ready' | 'edit'), or null when no
// `gh pr create/ready/edit` token sequence is present anywhere in the
// command. Non-anchored and quote-aware: see the module doc comment and
// scanQuotedRegions above.
function classifyGhPrCommand(command) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed) return null;

  const { blanked, unbalanced } = scanQuotedRegions(trimmed);

  // Unbalanced quoting means the blanked scan itself can't be trusted (an
  // unterminated quote swallows the rest of the command as "inside a
  // quote"), so detection here falls back to the raw command instead.
  const haystack = unbalanced ? trimmed : blanked;
  const match = GH_PR_SUBCOMMAND_ANYWHERE_PATTERN.exec(haystack);
  return match ? match[1] : null;
}

// Decide what to do about the tool call that is about to run and, when an
// active background-capture marker is present, deny a `gh pr
// create/ready/edit` or MCP `create_pull_request` call with a reason that
// redirects the agent to the right tool or the right human action. Absolute
// silence — no filesystem writes beyond the marker check — without an active
// marker, and for every other tool call.
export async function redirectPrCommand(
  input,
  {
    root = defaultRoot(),
    home = process.env.HOME?.trim() || homedir(),
  } = {}
) {
  const providerSessionId = input?.session_id;
  try {
    const { state } = readBackgroundCapture(providerSessionId, root);
    if (!state) return emptyResult();

    const toolName = input?.tool_name;
    if (toolName === 'Bash') {
      const subcommand = classifyGhPrCommand(input?.tool_input?.command);
      if (!subcommand) return emptyResult();
      return denyResult(DENY_REASON_BY_SUBCOMMAND[subcommand]);
    }

    if (
      typeof toolName === 'string' &&
      MCP_CREATE_PULL_REQUEST_PATTERN.test(toolName)
    ) {
      return denyResult(CREATE_DENY_REASON);
    }

    return emptyResult();
  } catch (error) {
    logHookFailure(
      'pr-command-redirect:redirect',
      error,
      { providerSessionId },
      home
    );
    return emptyResult();
  }
}

function readStdin() {
  try {
    const input = readFileSync(0, 'utf8');
    return input.trim() ? JSON.parse(input) : {};
  } catch {
    return {};
  }
}

async function runCli() {
  const input = readStdin();
  const result = await redirectPrCommand(input);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) await runCli();
