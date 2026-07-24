#!/usr/bin/env node

// Polygraph branch-identity observer.
//
// Runs alongside the background-capture lifecycle hook (see
// background-capture-lifecycle.mjs for the activation-marker contract that
// this script reuses). With an active marker, this hook resolves the current
// git branch from the hook payload's cwd and reports branch changes to the
// hosted capture endpoint, so Polygraph can track which branch a background
// Claude Code session is working on. Without a marker, invocation is a
// silent local no-op: no filesystem writes beyond checking for the marker,
// and no network calls.
//
// The captureHookUrl carried by the marker is secret: it must never be
// printed, logged, or included in hook output.

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBackgroundCapture } from './background-capture-lifecycle.mjs';

const HOOK_LOG_MAX_BYTES = 5 * 1024 * 1024;

function defaultRoot() {
  return join(homedir(), '.polygraph');
}

// Append a one-line JSON record of a hook failure to ~/.polygraph/logs/hooks.log.
// Duplicated locally rather than imported: each hook script in this plugin is
// invoked standalone as a subprocess, and every other Claude hook (see
// record-session-mapping.mjs, reinject-polygraph-context.mjs,
// check-plugin-version.mjs, remind-subagents.mjs) carries its own copy of the
// same helper for that reason.
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

// Persisted next to the activation marker and sidecar runtime state, in the
// same `background-capture` directory (see background-capture-lifecycle.mjs).
function branchStatePath(providerSessionId, root) {
  return join(root, 'background-capture', `claude-${providerSessionId}.branch.json`);
}

function readBranchState(path) {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function writeJsonAtomically(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
}

const SYMBOLIC_REF_PATTERN = /^ref:\s*refs\/heads\/(.+?)\s*$/;
const GITDIR_POINTER_PATTERN = /^gitdir:\s*(.+?)\s*$/m;

// Resolve the current branch by reading `.git/HEAD`, walking up from
// `startDir` toward the filesystem root to find the repository root (so a
// cwd nested deep inside a repo still resolves). Returns null — "no event",
// never an error — when no repository is found, or when HEAD is detached (a
// raw commit SHA rather than a symbolic ref).
export function resolveCurrentBranch(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    const gitPath = join(dir, '.git');
    if (existsSync(gitPath)) {
      let gitDir = gitPath;
      if (!statSync(gitPath).isDirectory()) {
        // A `.git` file (worktree checkout, or submodule) points at the real
        // gitdir instead of containing one directly.
        const pointer = readFileSync(gitPath, 'utf8');
        const match = GITDIR_POINTER_PATTERN.exec(pointer);
        if (!match) return null;
        gitDir = resolve(dir, match[1]);
      }
      const headPath = join(gitDir, 'HEAD');
      if (!existsSync(headPath)) return null;
      const head = readFileSync(headPath, 'utf8').trim();
      const match = SYMBOLIC_REF_PATTERN.exec(head);
      return match ? match[1] : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

function emptyResult() {
  return { exitCode: 0, stdout: '', stderr: '' };
}

// Report the current branch to `${captureHookUrl}/pr` when it differs from
// the branch last reported for this provider session. Absolute silence — no
// filesystem writes beyond the marker check, no network — without an active
// background-capture marker.
export async function observeBranchIdentity(
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

  let branch;
  try {
    branch = resolveCurrentBranch(
      typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd()
    );
  } catch (error) {
    logHookFailure(
      'pr-branch-observer:resolveCurrentBranch',
      error,
      { providerSessionId },
      home
    );
    return emptyResult();
  }
  if (!branch) return emptyResult(); // detached HEAD or no repository: no event

  const statePath = branchStatePath(providerSessionId, root);
  const previous = readBranchState(statePath);
  if (previous?.lastReportedBranch === branch) return emptyResult(); // fire-once-per-branch

  try {
    const response = await fetchImpl(`${state.captureHookUrl}/pr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerSessionId,
        kind: 'branch_active',
        branch,
        eventId: `branch:${branch}`,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Polygraph branch report returned HTTP ${response.status}`);
    }
  } catch (error) {
    // stderr only: hook stdout is injected into the model context. The
    // message never includes the capture capability URL. The persisted
    // lastReportedBranch is left untouched so the next invocation retries.
    logHookFailure(
      'pr-branch-observer:reportBranch',
      error,
      { providerSessionId },
      home
    );
    return emptyResult();
  }

  writeJsonAtomically(statePath, {
    providerSessionId,
    lastReportedBranch: branch,
    updatedAt: Date.now(),
  });
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
  const result = await observeBranchIdentity(input);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) await runCli();
