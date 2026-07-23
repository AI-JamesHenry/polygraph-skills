#!/usr/bin/env node

// Polygraph cloud-agent capture lifecycle helper.
//
// Explicit invocation of the cloud-session skill is the opt-in boundary: the
// skill runs `activate <captureHookUrl>` exactly once after the hosted
// `background_session_start` call succeeds. Activation writes a private
// mode-0600 marker keyed by the concrete provider session ID and starts a
// detached transcript sidecar from the byte offset of the opt-in prompt.
//
// The same script is registered as a preloaded plugin hook for a small set of
// lifecycle events. Without a marker every hook invocation is a cheap local
// no-op that transmits nothing. With a marker, hooks only keep the detached
// sidecar healthy (including after a worker pause/resume); they never
// duplicate transcript content themselves.
//
// The marker stores the session-scoped capture capability URL. That value is
// secret: it must never be printed, logged, or included in hook output.

import { spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CAPTURE_HOOK_PATH_PATTERN =
  /^\/(?:nx-cloud\/polygraph\/)?hooks\/capture\/pch_[A-Za-z0-9_-]{32,}$/;
// Single supported marker schema. Markers written by earlier unpublished
// spike builds (versions 1-4) are deliberately not migrated: they are
// deactivated on sight so capture only runs after a fresh explicit opt-in.
const MARKER_VERSION = 5;
const SIDECAR_READY_TIMEOUT_MS = 15_000;
const SIDECAR_POLL_INTERVAL_MS = 100;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const HOSTED_SIDECAR_ENTRY = resolve(
  MODULE_DIR,
  'hosted-parent-log-sidecar-entry.js'
);
const INVOCATION_DEBUG_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
]);
const PROVENANCE_NAME_PATTERN =
  /CLAUDE|SLACK|REMOTE|CLOUD|ENTRYPOINT|ENVIRONMENT|ORIGIN|SOURCE|SESSION|TASK|TRIGGER/i;
const SENSITIVE_NAME_PATTERN =
  /AUTH|COOKIE|CREDENTIAL|KEY|PASSWORD|PRIVATE|SECRET|TOKEN/i;
const CONTENT_NAME_PATTERN =
  /CONTENT|CONTEXT|MESSAGE|PROMPT|RESPONSE|TRANSCRIPT/i;
const INVOCATION_DEBUG_LOG_MAX_BYTES = 5 * 1024 * 1024;

function defaultRoot() {
  return join(homedir(), '.polygraph');
}

export function safeProviderSessionId(providerSessionId) {
  if (
    typeof providerSessionId !== 'string' ||
    providerSessionId.length === 0 ||
    providerSessionId.length > 240 ||
    !/^[A-Za-z0-9._-]+$/.test(providerSessionId) ||
    // An MCP argument or CLI environment never legitimately contains the
    // literal variable name; treat it as an unexpanded placeholder.
    /CLAUDE_CODE_SESSION_ID/i.test(providerSessionId)
  ) {
    throw new Error('Invalid Claude provider session ID.');
  }
  return providerSessionId;
}

export function safeCaptureHookUrl(captureHookUrl) {
  let parsed;
  try {
    parsed = new URL(captureHookUrl);
  } catch {
    throw new Error('Invalid Polygraph capture hook URL.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    !CAPTURE_HOOK_PATH_PATTERN.test(parsed.pathname) ||
    captureHookUrl.includes('?') ||
    captureHookUrl.includes('#') ||
    captureHookUrl.length > 2_000
  ) {
    throw new Error('Invalid Polygraph capture hook URL.');
  }
  return parsed.toString();
}

function markerPath(providerSessionId, root = defaultRoot()) {
  return join(
    root,
    'background-capture',
    `claude-${safeProviderSessionId(providerSessionId)}.json`
  );
}

function runtimePath(providerSessionId, root = defaultRoot()) {
  return join(
    root,
    'background-capture',
    `claude-${safeProviderSessionId(providerSessionId)}.sidecar.json`
  );
}

function readRuntimeState(path) {
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

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function locateClaudeTranscript(providerSessionId, home = homedir()) {
  const projectsRoot = join(home, '.claude', 'projects');
  if (!existsSync(projectsRoot)) return null;
  const candidates = [];
  for (const projectName of readdirSync(projectsRoot)) {
    const candidate = join(
      projectsRoot,
      projectName,
      `${safeProviderSessionId(providerSessionId)}.jsonl`
    );
    if (!existsSync(candidate)) continue;
    candidates.push({ path: candidate, mtimeMs: statSync(candidate).mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path ?? null;
}

// The opt-in boundary within the transcript: the byte offset of the latest
// real user prompt (the prompt that invoked the cloud-session skill). Bytes
// before this offset are never transmitted.
export function captureStartOffset(transcriptPath) {
  const content = readFileSync(transcriptPath);
  let start = 0;
  let latestUserPromptOffset = null;
  for (let cursor = 0; cursor <= content.length; cursor += 1) {
    if (cursor < content.length && content[cursor] !== 0x0a) continue;
    const raw = content.subarray(start, cursor).toString('utf8');
    if (raw.trim()) {
      try {
        const record = JSON.parse(raw);
        const message =
          record?.message && typeof record.message === 'object'
            ? record.message
            : record;
        if (
          record?.isMeta !== true &&
          message?.role === 'user' &&
          typeof message?.content === 'string' &&
          message.content.trim()
        ) {
          latestUserPromptOffset = start;
        }
      } catch {
        // Ignore an incomplete or provider-private record.
      }
    }
    start = cursor + 1;
  }
  return latestUserPromptOffset ?? 0;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds)
  );
}

export async function ensureHostedTranscriptSidecar(
  state,
  {
    root = defaultRoot(),
    spawnImpl = spawn,
    now = Date.now,
    sleepImpl = sleep,
    entryPath = HOSTED_SIDECAR_ENTRY,
  } = {}
) {
  const path = runtimePath(state.providerSessionId, root);
  const existing = readRuntimeState(path);
  if (
    existing?.providerSessionId === state.providerSessionId &&
    existing?.transcriptPath === state.transcriptPath &&
    existing?.startOffset === state.startOffset &&
    existing?.captureHookUrl === state.captureHookUrl &&
    Number.isSafeInteger(existing?.byteOffset) &&
    existsSync(state.transcriptPath) &&
    existing.byteOffset <= statSync(state.transcriptPath).size &&
    isProcessAlive(existing.pid)
  ) {
    return existing;
  }
  if (isProcessAlive(existing?.pid)) {
    try {
      process.kill(existing.pid, 'SIGTERM');
    } catch {
      // The stale sidecar stopped between the liveness check and signal.
    }
  }
  if (!existsSync(entryPath)) {
    throw new Error('The Polygraph transcript sidecar is not installed.');
  }
  if (!existsSync(state.transcriptPath)) {
    throw new Error('The Claude transcript is not available.');
  }

  rmSync(path, { force: true });
  const child = spawnImpl(process.execPath, [entryPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      POLYGRAPH_PARENT_LOG_PARENT_SESSION_ID: state.providerSessionId,
      POLYGRAPH_PARENT_LOG_PATH: state.transcriptPath,
      POLYGRAPH_PARENT_LOG_RUNTIME_PATH: path,
      POLYGRAPH_PARENT_LOG_CAPTURE_HOOK_URL: state.captureHookUrl,
      POLYGRAPH_PARENT_LOG_START_OFFSET: String(state.startOffset),
    },
  });
  child.unref?.();

  const deadline = now() + SIDECAR_READY_TIMEOUT_MS;
  while (now() < deadline) {
    const ready = readRuntimeState(path);
    if (
      ready?.pid === child.pid &&
      ready?.providerSessionId === state.providerSessionId &&
      ready?.transcriptPath === state.transcriptPath &&
      ready?.startOffset === state.startOffset &&
      ready?.captureHookUrl === state.captureHookUrl
    ) {
      return ready;
    }
    if (!isProcessAlive(child.pid)) {
      throw new Error('The Polygraph transcript sidecar exited early.');
    }
    await sleepImpl(SIDECAR_POLL_INTERVAL_MS);
  }
  try {
    process.kill(child.pid, 'SIGTERM');
  } catch {
    // The child already stopped.
  }
  throw new Error('Timed out starting the Polygraph transcript sidecar.');
}

// After a worker pause/resume the transcript may have moved to a fresh
// filesystem path, or been truncated. Recover to a safe state: follow the
// replacement transcript from offset 0 rather than transmitting from a stale
// offset in an unrelated file.
function refreshTranscriptState(state, root = defaultRoot(), home = homedir()) {
  let changed = false;
  if (!existsSync(state.transcriptPath)) {
    const replacement = locateClaudeTranscript(state.providerSessionId, home);
    if (!replacement) {
      throw new Error('The Claude transcript is not available.');
    }
    state.transcriptPath = replacement;
    state.startOffset = 0;
    changed = true;
  } else if (statSync(state.transcriptPath).size < state.startOffset) {
    state.startOffset = 0;
    changed = true;
  }
  if (changed) {
    writeJsonAtomically(markerPath(state.providerSessionId, root), state);
  }
  return state;
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

export async function activateBackgroundCapture(
  providerSessionId,
  captureHookUrl,
  {
    root = defaultRoot(),
    now = Date.now(),
    transcriptPath: suppliedTranscriptPath,
    startOffset: suppliedStartOffset,
    home = homedir(),
    ensureSidecar = ensureHostedTranscriptSidecar,
  } = {}
) {
  providerSessionId = safeProviderSessionId(providerSessionId);
  captureHookUrl = safeCaptureHookUrl(captureHookUrl);
  const path = markerPath(providerSessionId, root);
  const transcriptPath =
    suppliedTranscriptPath ?? locateClaudeTranscript(providerSessionId, home);
  if (!transcriptPath) {
    throw new Error('The current Claude transcript could not be located.');
  }
  const startOffset = suppliedStartOffset ?? captureStartOffset(transcriptPath);

  const state = {
    version: MARKER_VERSION,
    provider: 'claude',
    providerSessionId,
    activatedAt: now,
    captureMode: 'transcript-sidecar',
    captureHookUrl,
    transcriptPath,
    startOffset,
  };
  writeJsonAtomically(path, state);
  try {
    await ensureSidecar(state, { root });
    return state;
  } catch (error) {
    // Never leave a partially activated session behind: an invalid marker
    // must not cause later hooks to start a sidecar the user did not get
    // confirmation for.
    rmSync(runtimePath(providerSessionId, root), { force: true });
    rmSync(path, { force: true });
    throw error;
  }
}

export function deactivateBackgroundCapture(
  providerSessionId,
  { root = defaultRoot() } = {}
) {
  const sidecarRuntimePath = runtimePath(providerSessionId, root);
  const runtime = readRuntimeState(sidecarRuntimePath);
  if (isProcessAlive(runtime?.pid)) {
    try {
      process.kill(runtime.pid, 'SIGTERM');
    } catch {
      // The process stopped between the liveness check and signal.
    }
  }
  rmSync(sidecarRuntimePath, { force: true });
  rmSync(markerPath(providerSessionId, root), { force: true });
}

function readBackgroundCapture(providerSessionId, root = defaultRoot()) {
  let path;
  try {
    path = markerPath(providerSessionId, root);
  } catch {
    return { state: null, stale: false };
  }
  if (!existsSync(path)) return { state: null, stale: false };

  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (
      state?.version !== MARKER_VERSION ||
      state?.provider !== 'claude' ||
      state?.providerSessionId !== providerSessionId ||
      !Number.isFinite(state?.activatedAt) ||
      state?.captureMode !== 'transcript-sidecar' ||
      typeof state?.transcriptPath !== 'string' ||
      !Number.isSafeInteger(state?.startOffset) ||
      state?.startOffset < 0
    ) {
      return { state: null, stale: true };
    }
    state.captureHookUrl = safeCaptureHookUrl(state.captureHookUrl);
    return { state, stale: false };
  } catch {
    return { state: null, stale: true };
  }
}

function emptyResult() {
  return { exitCode: 0, stdout: '', stderr: '' };
}

function invocationDebugValue(name, value) {
  if (SENSITIVE_NAME_PATTERN.test(name) || CONTENT_NAME_PATTERN.test(name)) {
    return '<redacted>';
  }
  if (/(?:^|[_-])ID(?:$|[_-])|ID$/i.test(name)) {
    return `<set:length=${String(value).length}>`;
  }
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'string') return `<${typeof value}>`;
  return value.length <= 240 ? value : `${value.slice(0, 240)}…`;
}

export function backgroundInvocationDebugRecord(
  input,
  environment = process.env
) {
  if (!INVOCATION_DEBUG_EVENTS.has(input?.hook_event_name)) return null;

  const environmentNames = Object.keys(environment).sort();
  const provenanceEnvironment = Object.fromEntries(
    environmentNames
      .filter((name) => PROVENANCE_NAME_PATTERN.test(name))
      .map((name) => [
        name,
        invocationDebugValue(name, environment[name]),
      ])
  );
  const hookInputKeys =
    input && typeof input === 'object' ? Object.keys(input).sort() : [];
  const provenanceHookInput = Object.fromEntries(
    hookInputKeys
      .filter(
        (name) =>
          PROVENANCE_NAME_PATTERN.test(name) &&
          !CONTENT_NAME_PATTERN.test(name)
      )
      .filter((name) => {
        const value = input[name];
        return (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        );
      })
      .map((name) => [name, invocationDebugValue(name, input[name])])
  );

  return {
    tag: 'james-polygraph-background-invocation-debug',
    hookEventName: input.hook_event_name,
    environmentNames,
    provenanceEnvironment,
    hookInputKeys,
    provenanceHookInput,
  };
}

export function persistBackgroundInvocationDebug(
  input,
  {
    environment = process.env,
    home = process.env.HOME?.trim() || homedir(),
    now = Date.now(),
  } = {}
) {
  const record = backgroundInvocationDebugRecord(input, environment);
  if (!record) return null;

  try {
    const logsDir = join(home, '.polygraph', 'logs');
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    const logFile = join(logsDir, 'background-invocation-debug.jsonl');

    try {
      if (statSync(logFile).size > INVOCATION_DEBUG_LOG_MAX_BYTES) {
        renameSync(logFile, `${logFile}.1`);
      }
    } catch {
      // No prior log, or rotation failed. Continue with the current file.
    }

    appendFileSync(
      logFile,
      `${JSON.stringify({
        time: new Date(now).toISOString(),
        ...record,
      })}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    chmodSync(logFile, 0o600);
    return logFile;
  } catch {
    // Temporary diagnostics must never break a Claude lifecycle hook.
    return null;
  }
}

export async function handleBackgroundCaptureHook(
  input,
  {
    root = defaultRoot(),
    ensureSidecar = ensureHostedTranscriptSidecar,
    home = homedir(),
  } = {}
) {
  const providerSessionId = input?.session_id;
  const { state, stale } = readBackgroundCapture(providerSessionId, root);
  if (stale) {
    // A marker from an obsolete schema (or a corrupt one) never drives
    // capture. Deactivate it so the user has to opt in again explicitly.
    try {
      deactivateBackgroundCapture(providerSessionId, { root });
    } catch {
      // Removal is best-effort; the marker is already ignored.
    }
    return emptyResult();
  }
  if (!state) return emptyResult();
  try {
    await ensureSidecar(refreshTranscriptState(state, root, home), { root });
    return emptyResult();
  } catch (error) {
    // stderr only: hook stdout is injected into the model context. The
    // message never includes the capture capability URL.
    return {
      exitCode: 0,
      stdout: '',
      stderr: `Polygraph transcript sidecar recovery failed: ${error instanceof Error ? error.message : 'unknown error'}.\n`,
    };
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
  if (process.argv[2] === 'activate') {
    const state = await activateBackgroundCapture(
      process.env.CLAUDE_CODE_SESSION_ID,
      process.argv[3]
    );
    // Confirmation only — never echo the capture capability URL.
    process.stdout.write(
      `${JSON.stringify({ status: 'activated', startOffset: state.startOffset })}\n`
    );
    return;
  }
  if (process.argv[2] === 'deactivate') {
    deactivateBackgroundCapture(
      safeProviderSessionId(process.env.CLAUDE_CODE_SESSION_ID)
    );
    return;
  }

  const input = readStdin();
  const invocationDebugLog = persistBackgroundInvocationDebug(input);
  if (
    invocationDebugLog &&
    input?.hook_event_name === 'SessionStart'
  ) {
    process.stdout.write(
      `Temporary Polygraph invocation diagnostics: ${invocationDebugLog}\n`
    );
  }
  const result = await handleBackgroundCaptureHook(input);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) await runCli();
