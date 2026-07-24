#!/usr/bin/env node

// Polygraph PR command observer (fast path).
//
// Runs alongside the background-capture lifecycle hook and the branch
// observer (see background-capture-lifecycle.mjs for the activation-marker
// contract, and pr-branch-observer.mjs for the branch-identity backbone this
// hook complements). With an active marker, this PostToolUse hook classifies
// the tool call that just ran — `gh pr create/ready/edit`, `git push`, or an
// MCP `create_pull_request` tool — and, when it recognizes a simple, safe
// pattern, reports a richer PR-lifecycle event to the same hosted capture
// endpoint the branch observer uses. Classification is deliberately narrow:
// anything compound, piped, redirected, or otherwise ambiguous is left alone
// so the branch-identity backbone can pick it up instead. Without a marker,
// invocation is a silent local no-op: no filesystem writes beyond checking
// for the marker, and no network calls.
//
// The captureHookUrl carried by the marker is secret: it must never be
// printed, logged, or included in hook output.

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBackgroundCapture } from './background-capture-lifecycle.mjs';
import { resolveCurrentBranch } from './pr-branch-observer.mjs';

const HOOK_LOG_MAX_BYTES = 5 * 1024 * 1024;

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

// A command counts as a "simple invocation" only when it is a single plain
// command line: no chaining (`&&`, `||`, `;`), no pipes, no redirection, no
// backgrounding, no command substitution, and no embedded newline. Quoted
// flag values (e.g. `--title "Add feature"`) are still simple. Anything else
// is compound or ambiguous, and is left for the branch-identity backbone to
// pick up instead of risking a misclassification.
const COMPOUND_COMMAND_PATTERN = /[;&|<>`\n]|\$\(/;

const GH_PR_CREATE_PATTERN = /^gh\s+pr\s+create(?:\s|$)/;
const GH_PR_READY_PATTERN = /^gh\s+pr\s+ready(?:\s|$)/;
const GH_PR_EDIT_PATTERN = /^gh\s+pr\s+edit(?:\s|$)/;
const GIT_PUSH_PATTERN = /^git\s+push(?:\s|$)/;

const MCP_CREATE_PULL_REQUEST_PATTERN = /^mcp__.*__create_pull_request$/;

const PR_URL_PATTERN = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/;

function extractPrUrl(text) {
  if (typeof text !== 'string') return null;
  const match = PR_URL_PATTERN.exec(text);
  return match ? match[0] : null;
}

// The first token after the subcommand (`gh pr ready`/`gh pr edit`) that
// isn't a flag. Only used as a fallback when the command's output carried no
// PR URL. A non-numeric token (for example a flag's value, since this
// tokenizer does not track flag arity) is treated as "no positional PR
// number" rather than guessed at.
function firstPositionalArgAfter(command, skipTokenCount) {
  const tokens = command.split(/\s+/).slice(skipTokenCount);
  for (const token of tokens) {
    if (token.startsWith('-')) continue;
    return /^\d+$/.test(token) ? token : null;
  }
  return null;
}

// Claude Code PostToolUse contract: this hook only fires after a tool call
// completes successfully (a failing call throws internally and routes to
// PostToolUseFailure instead, which carries no tool_response). Bash's
// tool_response is {stdout, stderr, interrupted, ...} with no exit-code
// field; an MCP tool's tool_response is an MCP result:
// {content: [{type, text}, ...], isError?, structuredContent?}.
function bashOutputText(response) {
  if (!response || typeof response !== 'object') return '';
  const stdout = typeof response.stdout === 'string' ? response.stdout : '';
  const stderr = typeof response.stderr === 'string' ? response.stderr : '';
  return stdout + stderr;
}

function mcpOutputText(response) {
  if (!response || typeof response !== 'object') return '';
  const content = Array.isArray(response.content) ? response.content : [];
  const textParts = content
    .filter((block) => block && typeof block.text === 'string')
    .map((block) => block.text);
  if (response.structuredContent !== undefined) {
    try {
      textParts.push(JSON.stringify(response.structuredContent));
    } catch {
      // circular or otherwise unserializable — ignore
    }
  }
  return textParts.join('\n');
}

// Resolve a PR-lifecycle command to prUrl/prNumber/branch-fallback, in that
// priority order. `prNumberFallback` is null for `gh pr create`, which has no
// meaningful "PR number argument" (the PR does not exist until the command
// succeeds).
function classifyPrLifecycleCommand(kind, outputText, prNumberFallback) {
  const prUrl = extractPrUrl(outputText);
  if (prUrl) return { kind, prUrl, outputText };
  if (prNumberFallback) {
    return { kind, prNumber: prNumberFallback, outputText };
  }
  return { kind: 'branch_active', outputText, needsBranch: true };
}

function classifyBash(input) {
  const command = input?.tool_input?.command;
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed || COMPOUND_COMMAND_PATTERN.test(trimmed)) return null;

  // Reaching PostToolUse for Bash already means the command succeeded (see
  // the contract note above `bashOutputText`); `interrupted` is the one real
  // field left that can still turn a completed call into "not usable".
  const response = input?.tool_response;
  if (!response || typeof response !== 'object' || response.interrupted === true) {
    return null;
  }

  const outputText = bashOutputText(response);

  if (GH_PR_CREATE_PATTERN.test(trimmed)) {
    return classifyPrLifecycleCommand('pr_created', outputText, null);
  }
  if (GH_PR_READY_PATTERN.test(trimmed)) {
    return classifyPrLifecycleCommand(
      'pr_ready',
      outputText,
      firstPositionalArgAfter(trimmed, 3)
    );
  }
  if (GH_PR_EDIT_PATTERN.test(trimmed)) {
    return classifyPrLifecycleCommand(
      'pr_updated',
      outputText,
      firstPositionalArgAfter(trimmed, 3)
    );
  }
  if (GIT_PUSH_PATTERN.test(trimmed)) {
    return { kind: 'branch_pushed', outputText, needsBranch: true };
  }
  return null;
}

function classifyMcp(input) {
  const toolName = input?.tool_name;
  if (
    typeof toolName !== 'string' ||
    !MCP_CREATE_PULL_REQUEST_PATTERN.test(toolName)
  ) {
    return null;
  }
  const response = input?.tool_response;
  if (!response || typeof response !== 'object' || response.isError === true) {
    return null;
  }

  const outputText = mcpOutputText(response);
  const prUrl = extractPrUrl(outputText);
  if (prUrl) return { kind: 'pr_created', prUrl, outputText };
  return { kind: 'branch_active', outputText, needsBranch: true };
}

function classify(input) {
  if (input?.tool_name === 'Bash') return classifyBash(input);
  return classifyMcp(input);
}

function emptyResult() {
  return { exitCode: 0, stdout: '', stderr: '' };
}

// Classify the PostToolUse payload for the tool call that just ran and,
// when it matches a recognized simple PR-lifecycle pattern, report a
// PR-lifecycle event to `${captureHookUrl}/pr`. Absolute silence — no
// filesystem writes beyond the marker check, no network — without an active
// background-capture marker.
export async function observePrCommand(
  input,
  {
    root = defaultRoot(),
    fetchImpl = fetch,
    home = process.env.HOME?.trim() || homedir(),
  } = {}
) {
  const providerSessionId = input?.session_id;
  const { state } = readBackgroundCapture(providerSessionId, root);
  if (!state) return emptyResult();

  const classification = classify(input);
  if (!classification) return emptyResult();

  let branch = null;
  try {
    branch = resolveCurrentBranch(
      typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd()
    );
  } catch (error) {
    logHookFailure(
      'pr-command-observer:resolveCurrentBranch',
      error,
      { providerSessionId },
      home
    );
    return emptyResult();
  }

  if (classification.needsBranch && !branch) {
    // branch_active / branch_pushed carry no other identity; without a
    // resolvable branch (detached HEAD, no repository) there is nothing
    // meaningful to report.
    return emptyResult();
  }

  const payload = { providerSessionId, kind: classification.kind };
  if (classification.prUrl) payload.prUrl = classification.prUrl;
  if (classification.prNumber) payload.prNumber = Number(classification.prNumber);
  if (branch) payload.branch = branch;

  const outputHash = createHash('sha256')
    .update(classification.outputText ?? '')
    .digest('hex')
    .slice(0, 16);
  // Identity segment, in priority order: prUrl, branch, prNumber (so a
  // prNumber-only classification with no resolvable branch — e.g. detached
  // HEAD — still distinguishes itself from other such events instead of
  // collapsing to the literal 'unknown'), then 'unknown' as the last resort.
  const eventIdentity =
    classification.prUrl ??
    branch ??
    (classification.prNumber ? `pr#${classification.prNumber}` : 'unknown');
  payload.eventId = `${classification.kind}:${eventIdentity}:${outputHash}`;

  try {
    const response = await fetchImpl(`${state.captureHookUrl}/pr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Polygraph PR command report returned HTTP ${response.status}`);
    }
  } catch (error) {
    // stderr only: hook stdout is injected into the model context. The
    // message never includes the capture capability URL.
    logHookFailure(
      'pr-command-observer:reportCommand',
      error,
      { providerSessionId },
      home
    );
    return emptyResult();
  }

  return emptyResult();
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
  const result = await observePrCommand(input);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) await runCli();
