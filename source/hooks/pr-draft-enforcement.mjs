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
import {
  COMPOUND_COMMAND_PATTERN,
  GH_PR_CREATE_PATTERN,
  MCP_CREATE_PULL_REQUEST_PATTERN,
} from './pr-command-observer.mjs';

const HOOK_LOG_MAX_BYTES = 5 * 1024 * 1024;

const DRAFT_ENFORCEMENT_DENY_REASON =
  'Polygraph cloud sessions create draft PRs. Re-run this command with --draft added to gh pr create.';

// Broader than GH_PR_CREATE_PATTERN: matches `gh pr create` anywhere in the
// command (not just anchored at the start), so a compound command that
// *hides* a `gh pr create` after a `&&`/`;`/etc. is still recognized as
// carrying one — and therefore denied rather than silently ignored.
const GH_PR_CREATE_ANYWHERE_PATTERN = /\bgh\s+pr\s+create\b/;

// `--draft` or `-d` as a standalone token (surrounded by whitespace or the
// command boundary). A heuristic, like the rest of this plugin's command
// classification: a flag value that happens to contain the literal text
// `-d` inside its own quoting is not distinguished from a real flag. That
// tradeoff mirrors pr-command-observer.mjs's "simple invocation" heuristics
// rather than implementing a full shell tokenizer.
const DRAFT_FLAG_PATTERN = /(?:^|\s)(?:--draft|-d)(?:\s|$)/;

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

// Insert ` --draft` immediately after the `create` token. This is a plain
// string splice at the end of the `^gh\s+pr\s+create` match, not a
// tokenize-and-reassemble — so everything after `create` (flags, quoted flag
// values, internal whitespace) survives byte-for-byte.
function withDraftFlagAppended(trimmedCommand) {
  const match = /^gh\s+pr\s+create/.exec(trimmedCommand);
  const insertAt = match.index + match[0].length;
  return `${trimmedCommand.slice(0, insertAt)} --draft${trimmedCommand.slice(insertAt)}`;
}

// Classify a Bash tool_input.command against the `gh pr create` draft
// enforcement rules. Returns:
//   - null: no `gh pr create` involved at all (unrelated command, or a
//     compound command that doesn't carry one) — no opinion.
//   - { decision: 'allow', command }: a single simple `gh pr create` lacking
//     --draft/-d, rewritten with --draft appended.
//   - { decision: 'deny' }: a `gh pr create` invocation that is compound or
//     otherwise ambiguous.
//   - null (already-draft case folds into the caller): a single simple
//     `gh pr create` that already carries --draft/-d needs no rewrite.
function classifyGhPrCreateCommand(command) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed) return null;

  const isCompound = COMPOUND_COMMAND_PATTERN.test(trimmed);
  const carriesGhPrCreate = GH_PR_CREATE_ANYWHERE_PATTERN.test(trimmed);

  if (isCompound) {
    return carriesGhPrCreate ? { decision: 'deny' } : null;
  }
  if (!GH_PR_CREATE_PATTERN.test(trimmed)) return null;
  if (DRAFT_FLAG_PATTERN.test(trimmed)) return null;

  return { decision: 'allow', command: withDraftFlagAppended(trimmed) };
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
