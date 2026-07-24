#!/usr/bin/env node

// Polygraph PreToolUse draft-PR enforcement.
//
// Runs alongside the background-capture lifecycle hook and the PostToolUse
// observers (see background-capture-lifecycle.mjs for the activation-marker
// contract, and pr-command-observer.mjs for the sibling PostToolUse hook this
// one shares its "simple invocation" rules with). This is the only hook in
// the plugin that reshapes a tool call before it runs: with an active
// marker, an autonomous `gh pr create` or MCP `create_pull_request` call is
// forced into draft mode, so a cloud session never opens a PR that looks
// ready for review before a human has looked at it.
//
// Classification mirrors the PostToolUse observer's caution: only a single,
// unambiguous `gh pr create` invocation is safe to rewrite in place. Anything
// compound, piped, redirected, or otherwise ambiguous is denied outright
// instead of risking a rewrite that silently misses the real command (for
// example a `gh pr create` hidden after `&&` in a chain). Without a marker,
// invocation is a silent local no-op: no filesystem writes beyond checking
// for the marker.
//
// Unlike the observers, this hook never needs the marker's captureHookUrl —
// only the marker's presence matters here — so it is never read out of the
// returned state, kept in a variable, or sent anywhere.

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
import { MCP_CREATE_PULL_REQUEST_PATTERN } from './pr-command-observer.mjs';

const HOOK_LOG_MAX_BYTES = 5 * 1024 * 1024;

const DRAFT_ENFORCEMENT_DENY_REASON =
  'Polygraph cloud sessions create draft PRs. Re-run this command with --draft added to gh pr create.';

// Characters that end a "simple" command when they appear outside all
// quoting: chaining (`;`, and `&`/`|`, which also covers `&&`/`||` since
// each is a repeat of a single such character), redirection (`<`, `>`), and
// an embedded newline. Backtick/`$(` command substitution is deliberately
// NOT in this set — unlike these operators, it still executes inside double
// quotes, so it needs quote-type-sensitive handling and is tracked
// separately by scanQuotedRegions's `hasSubstitution` flag instead.
const OPERATOR_OUTSIDE_QUOTES_PATTERN = /[;&|<>\n]/;

// `gh pr create` as a literal, whitespace-separated token sequence, matched
// anywhere in the command (not anchored at the start). Non-anchored so a
// command prefixed by an env-var assignment (`GH_TOKEN=x gh pr create`) or
// another command (`time gh pr create`, `sudo gh pr create`) is still
// recognized as carrying a real invocation, and so is one hidden after a
// compound operator (`cd repo && gh pr create`) — in that case it is denied
// rather than silently ignored. Word-bounded on both ends so `ghe pr
// create` and `gh prx create` do not match.
const GH_PR_CREATE_ANYWHERE_PATTERN = /\bgh\s+pr\s+create\b/;

// `--draft` or `-d` as a standalone token (bare, no `=value`), surrounded by
// whitespace or the command boundary. Runs only against the quote-blanked
// command (see scanQuotedRegions) so a flag-lookalike sitting inside a
// quoted `--title`/`--body` value is never mistaken for the real flag.
const DRAFT_BARE_FLAG_PATTERN = /(?:^|\s)(?:--draft|-d)(?:\s|$)/;

// `--draft=true` specifically counts as already-draft, same as the bare
// flag.
const DRAFT_TRUE_VALUE_PATTERN = /(?:^|\s)--draft=true(?:\s|$)/;

// `--draft=<anything else>` (most notably `--draft=false`). gh's flag
// parser resolves repeated `--draft` occurrences to the last one, so
// splicing a second bare `--draft` in front of this would not reliably
// force draft mode — the intent is ambiguous, so it is denied rather than
// rewritten.
const DRAFT_ANY_VALUE_PATTERN = /(?:^|\s)--draft=\S*/;

// Walk `command` tracking single/double-quote state — a small quote-aware
// scanner, not a full shell tokenizer. Returns:
//   - blanked: same length as `command`, with the *contents* of quoted
//     spans replaced by spaces (the quote characters themselves stay in
//     place). Flag and compound-operator detection run against this string,
//     so a flag-lookalike or operator character sitting inside a quoted
//     value can never be mistaken for the real thing. Because it is the
//     same length as `command`, a match index found in `blanked` is also
//     the correct index into `command`.
//   - unbalanced: true if a quote was opened and never closed.
//   - hasSubstitution: true if a backtick or `$(` appears outside all
//     quotes, or inside a double-quoted span (the shell still executes it
//     there) — but not inside a single-quoted span (the shell never does).
function scanQuotedRegions(command) {
  let blanked = '';
  let quote = null;
  let hasSubstitution = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        blanked += ch;
        continue;
      }
      if (
        quote === '"' &&
        (ch === '`' || (ch === '$' && command[i + 1] === '('))
      ) {
        hasSubstitution = true;
      }
      blanked += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      blanked += ch;
      continue;
    }
    if (ch === '`' || (ch === '$' && command[i + 1] === '(')) {
      hasSubstitution = true;
    }
    blanked += ch;
  }
  return { blanked, unbalanced: quote !== null, hasSubstitution };
}

function defaultRoot() {
  return join(homedir(), '.polygraph');
}

// Append a one-line JSON record of a hook failure to ~/.polygraph/logs/hooks.log.
// Duplicated locally rather than imported: each hook script in this plugin is
// invoked standalone as a subprocess, and every other Claude hook (see
// pr-branch-observer.mjs, pr-command-observer.mjs, record-session-mapping.mjs,
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

function allowResult(updatedInput) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput,
      },
    }),
    stderr: '',
  };
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

// Insert ` --draft` at `insertAt` — the index right after the matched `gh pr
// create` token's `create`, computed against the same-length blanked string
// (see scanQuotedRegions) so it lines up exactly with `trimmedCommand`. A
// plain string splice, not a tokenize-and-reassemble, so everything else in
// `trimmedCommand` — a prefix before the match, flags, quoted flag values,
// internal whitespace — survives byte-for-byte.
function spliceInDraftFlag(trimmedCommand, insertAt) {
  return `${trimmedCommand.slice(0, insertAt)} --draft${trimmedCommand.slice(insertAt)}`;
}

// Classify a Bash tool_input.command against the `gh pr create` draft
// enforcement rules. Fails closed: any command carrying a `gh pr create`
// token sequence resolves to either a confident rewrite or a deny, never
// silence. Returns:
//   - null: no opinion, for either of two cases the caller treats
//     identically (both map to emptyResult()) — no `gh pr create` token
//     sequence is present anywhere in the command, or one is present but
//     already carries a draft flag (bare `--draft`, `--draft=true`, or `-d`)
//     and needs no rewrite.
//   - { decision: 'allow', command }: a single, unambiguous `gh pr create`
//     invocation lacking a draft flag, rewritten with `--draft` spliced in
//     right after that invocation's `create` token.
//   - { decision: 'deny' }: a `gh pr create` invocation this classifier
//     cannot confidently rewrite — compound/piped/redirected/substituted,
//     unbalanced quoting, or an ambiguous `--draft=<value>` other than
//     `true`.
function classifyGhPrCreateCommand(command) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed) return null;

  const { blanked, unbalanced, hasSubstitution } = scanQuotedRegions(trimmed);

  // Unbalanced quoting means the blanked scan itself can't be trusted (an
  // unterminated quote swallows the rest of the command as "inside a
  // quote"), so detection here falls back to the raw command. Ambiguity —
  // whether it might carry a `gh pr create` — is denied rather than risking
  // a misplaced rewrite or a silent pass-through.
  if (unbalanced) {
    return GH_PR_CREATE_ANYWHERE_PATTERN.test(trimmed)
      ? { decision: 'deny' }
      : null;
  }

  const isCompound =
    OPERATOR_OUTSIDE_QUOTES_PATTERN.test(blanked) || hasSubstitution;
  const match = GH_PR_CREATE_ANYWHERE_PATTERN.exec(blanked);

  if (isCompound) {
    return match ? { decision: 'deny' } : null;
  }
  if (!match) return null;

  if (DRAFT_TRUE_VALUE_PATTERN.test(blanked)) return null;
  if (DRAFT_ANY_VALUE_PATTERN.test(blanked)) return { decision: 'deny' };
  if (DRAFT_BARE_FLAG_PATTERN.test(blanked)) return null;

  return {
    decision: 'allow',
    command: spliceInDraftFlag(trimmed, match.index + match[0].length),
  };
}

function classifyMcpCreatePullRequestInput(toolInput) {
  const input =
    toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
      ? toolInput
      : {};
  if (input.draft === true) return null;
  return { decision: 'allow', input: { ...input, draft: true } };
}

// Decide what to do about the tool call that is about to run and, when an
// active background-capture marker is present, either rewrite it (append
// --draft) or deny it (compound/ambiguous `gh pr create`). Absolute silence —
// no filesystem writes beyond the marker check — without an active marker.
export async function enforceDraftPr(
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
      const classification = classifyGhPrCreateCommand(
        input?.tool_input?.command
      );
      if (!classification) return emptyResult();
      if (classification.decision === 'deny') {
        return denyResult(DRAFT_ENFORCEMENT_DENY_REASON);
      }
      return allowResult({ command: classification.command });
    }

    if (typeof toolName === 'string' && MCP_CREATE_PULL_REQUEST_PATTERN.test(toolName)) {
      const classification = classifyMcpCreatePullRequestInput(
        input?.tool_input
      );
      if (!classification) return emptyResult();
      return allowResult(classification.input);
    }

    return emptyResult();
  } catch (error) {
    logHookFailure('pr-draft-enforcement:enforce', error, { providerSessionId }, home);
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
  const result = await enforceDraftPr(input);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) await runCli();
