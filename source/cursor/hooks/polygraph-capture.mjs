#!/usr/bin/env node

// Polygraph capture hook for Cursor Cloud Agents.
//
// Cloud-agent VMs expose no transcript file (`transcript_path` is null), so
// this hook synthesizes Polygraph `AgentLogLine` records directly from hook
// event payloads and POSTs them to the session's capture endpoint.
//
// Opt-in mirrors the Claude sidecar: nothing is transmitted until the agent
// has called the Polygraph MCP `background_session_start` tool and run
// `activate <captureHookUrl>` exactly once. Activation writes a private
// mode-0600 marker keyed by the Cursor conversation id. The capture
// capability URL is secret: never printed, logged, or included in hook
// output.
//
// Delivery: every hook invocation appends its mapped lines to a per-session
// outbox, then flushes unsent lines to the capture endpoint from a persisted
// byte offset. Hooks run as parallel short-lived processes, so flushing is
// guarded by a best-effort lock and the server's (sessionId, eventId) claim
// makes duplicate sends converge. A failed flush retries implicitly on the
// next hook invocation.

import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER_VERSION = 1;
const CAPTURE_HOOK_PATH_PATTERN =
  /^\/(?:nx-cloud\/polygraph\/)?hooks\/capture\/pch_[A-Za-z0-9_-]{32,}$/;
const EVENT_ID_PATTERN = /[^A-Za-z0-9:_./-]/g;
const MAX_EVENT_ID_LENGTH = 256;
// Server caps: 256 KiB/line, 1000 lines and 3 MiB per batch. Stay under.
const MAX_TEXT_LENGTH = 200_000;
const MAX_BATCH_LINES = 500;
const MAX_BATCH_BYTES = 2 * 1024 * 1024;
const MAX_OUTBOX_BYTES = 20 * 1024 * 1024;
const FLUSH_LOCK_STALE_MS = 30_000;
const POST_TIMEOUT_MS = 8_000;
const SOCKET_TIMEOUT_MS = 2_000;

function defaultRoot() {
  return join(homedir(), '.polygraph');
}

export function safeConversationId(conversationId) {
  if (
    typeof conversationId !== 'string' ||
    conversationId.length === 0 ||
    conversationId.length > 240 ||
    !/^[A-Za-z0-9._-]+$/.test(conversationId)
  ) {
    throw new Error('Invalid Cursor conversation ID.');
  }
  return conversationId;
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

function captureDir(root) {
  return join(root, 'background-capture');
}

function currentSessionPath(root) {
  return join(captureDir(root), 'cursor-current.json');
}

function markerPath(conversationId, root) {
  return join(captureDir(root), `cursor-${safeConversationId(conversationId)}.json`);
}

function outboxPath(conversationId, root) {
  return join(
    captureDir(root),
    `cursor-${safeConversationId(conversationId)}.outbox.jsonl`
  );
}

function offsetPath(conversationId, root) {
  return join(
    captureDir(root),
    `cursor-${safeConversationId(conversationId)}.offset.json`
  );
}

function lockPath(conversationId, root) {
  return join(
    captureDir(root),
    `cursor-${safeConversationId(conversationId)}.flush.lock`
  );
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

function readJson(path) {
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

export function readMarker(conversationId, root = defaultRoot()) {
  let path;
  try {
    path = markerPath(conversationId, root);
  } catch {
    return null;
  }
  const state = readJson(path);
  if (
    state?.version !== MARKER_VERSION ||
    state?.provider !== 'cursor' ||
    state?.providerSessionId !== conversationId ||
    typeof state?.captureHookUrl !== 'string'
  ) {
    return null;
  }
  try {
    state.captureHookUrl = safeCaptureHookUrl(state.captureHookUrl);
  } catch {
    return null;
  }
  return state;
}

// ---------------------------------------------------------------------------
// In-VM metadata (GET /v1/meta-data/<path> on $CURSOR_AGENT_SOCKET).
// Best-effort: identity primarily comes from hook input `conversation_id`;
// the socket supplies what hook inputs lack (owner email, repo URL).

export function readMetaData(leaf, { environment = process.env } = {}) {
  const socketPath = environment.CURSOR_AGENT_SOCKET;
  if (!socketPath || !/^[a-z0-9/._-]+$/i.test(leaf)) {
    return Promise.resolve(null);
  }
  return new Promise((resolvePromise) => {
    const request = httpRequest(
      {
        socketPath,
        path: `/v1/meta-data/${leaf}`,
        method: 'GET',
        timeout: SOCKET_TIMEOUT_MS,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          if (body.length < 65_536) body += chunk;
        });
        response.on('end', () => {
          resolvePromise(response.statusCode === 200 ? body.trim() : null);
        });
      }
    );
    request.on('error', () => resolvePromise(null));
    request.on('timeout', () => {
      request.destroy();
      resolvePromise(null);
    });
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Event mapping: Cursor hook payload -> AgentLogLine records (+ eventId,
// timestamp). Shapes per libs/polygraph/model-agent-sessions/src/lib/
// agent-log-types.ts in the ocean repo.

function truncate(text) {
  if (typeof text !== 'string') return '';
  return text.length <= MAX_TEXT_LENGTH
    ? text
    : `${text.slice(0, MAX_TEXT_LENGTH)}\n…[truncated by Polygraph capture]`;
}

function contentHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

export function sanitizeEventId(raw) {
  const cleaned = String(raw).replace(EVENT_ID_PATTERN, '-');
  return cleaned.slice(0, MAX_EVENT_ID_LENGTH);
}

function serializedOutput(toolOutput) {
  if (typeof toolOutput === 'string') {
    let format;
    try {
      JSON.parse(toolOutput);
      format = 'json';
    } catch {
      format = undefined;
    }
    return { output: truncate(toolOutput), outputFormat: format };
  }
  return { output: truncate(JSON.stringify(toolOutput ?? null)), outputFormat: 'json' };
}

export function mapHookEventToLines(input, { now = () => Date.now() } = {}) {
  const timestamp = new Date(now()).toISOString();
  const generationId = sanitizeEventId(input?.generation_id ?? 'unknown');
  const record = (eventId, line) => ({
    ...line,
    eventId: sanitizeEventId(eventId),
    timestamp,
  });

  switch (input?.hook_event_name) {
    case 'beforeSubmitPrompt': {
      if (typeof input.prompt !== 'string' || !input.prompt.trim()) return [];
      return [
        record(`${generationId}:prompt`, {
          type: 'user-prompt',
          text: truncate(input.prompt),
        }),
      ];
    }
    case 'postToolUse':
    case 'postToolUseFailure': {
      if (typeof input.tool_name !== 'string') return [];
      // tool_use_id has been observed to contain a newline; sanitize before
      // using it in eventIds. Fall back to a payload hash when absent.
      const toolUseId = input.tool_use_id
        ? sanitizeEventId(input.tool_use_id)
        : `${generationId}-${contentHash(input)}`;
      const { output, outputFormat } = serializedOutput(input.tool_output);
      return [
        record(`${toolUseId}:use`, {
          type: 'tool-use',
          toolName: input.tool_name,
          input: truncate(JSON.stringify(input.tool_input ?? {})),
          toolUseId,
        }),
        record(`${toolUseId}:result`, {
          type: 'tool-result',
          toolName: input.tool_name,
          output,
          isError: input.hook_event_name === 'postToolUseFailure',
          toolUseId,
          ...(outputFormat ? { outputFormat } : {}),
        }),
      ];
    }
    case 'afterAgentThought': {
      // Payload shape not yet sampled from a real run; map defensively.
      const text = typeof input.text === 'string' ? input.text : null;
      if (!text || !text.trim()) return [];
      return [
        record(`${generationId}:thought:${contentHash(text)}`, {
          type: 'thinking',
          text: truncate(text),
        }),
      ];
    }
    case 'afterAgentResponse': {
      if (typeof input.text !== 'string' || !input.text.trim()) return [];
      return [
        record(`${generationId}:response:${contentHash(input.text)}`, {
          type: 'text',
          role: 'assistant',
          text: truncate(input.text),
        }),
      ];
    }
    case 'subagentStart':
    case 'subagentStop': {
      // Payload shapes not yet sampled; record the lifecycle fact only.
      const started = input.hook_event_name === 'subagentStart';
      return [
        record(`${generationId}:${input.hook_event_name}:${contentHash(input)}`, {
          type: 'event',
          label: started ? 'Subagent started' : 'Subagent stopped',
        }),
      ];
    }
    case 'stop': {
      // The stop event's generation_id is the cloud run id (`run-<uuid>`).
      return [
        record(`${generationId}:stop`, {
          type: 'event',
          label: `Run ${typeof input.status === 'string' ? input.status : 'stopped'}`,
          detail: generationId,
        }),
      ];
    }
    default:
      // afterFileEdit is deliberately unmapped: the same change arrives as a
      // postToolUse Write/Edit with full content, and mapping both would
      // duplicate transcript entries.
      return [];
  }
}

// ---------------------------------------------------------------------------
// Outbox + flush

function appendOutboxLines(conversationId, lines, root) {
  if (lines.length === 0) return;
  const path = outboxPath(conversationId, root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path) && statSync(path).size > MAX_OUTBOX_BYTES) {
    // The endpoint has been unreachable for a long time; stop growing.
    return;
  }
  const descriptor = openSync(path, 'a', 0o600);
  try {
    // One writeSync per invocation: O_APPEND keeps concurrent hook processes
    // from interleaving within this payload.
    writeSync(descriptor, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  } finally {
    closeSync(descriptor);
  }
}

function acquireFlushLock(conversationId, root, now) {
  const path = lockPath(conversationId, root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, `${process.pid} ${now}\n`, { flag: 'wx', mode: 0o600 });
    return path;
  } catch {
    try {
      const heldSince = Number(readFileSync(path, 'utf8').trim().split(' ')[1]);
      if (Number.isFinite(heldSince) && now - heldSince > FLUSH_LOCK_STALE_MS) {
        rmSync(path, { force: true });
        writeFileSync(path, `${process.pid} ${now}\n`, { flag: 'wx', mode: 0o600 });
        return path;
      }
    } catch {
      // Another process owns or just replaced the lock.
    }
    return null;
  }
}

async function postTranscriptBatch(captureHookUrl, providerSessionId, lines, fetchImpl) {
  const response = await fetchImpl(`${captureHookUrl}/transcript`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerSessionId,
      source: 'cursor-hooks',
      lines,
    }),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  return response.status;
}

export async function flushOutbox(
  conversationId,
  marker,
  { root = defaultRoot(), fetchImpl = fetch, now = Date.now } = {}
) {
  const lock = acquireFlushLock(conversationId, root, now());
  if (!lock) return { flushed: 0, status: 'locked' };
  try {
    const path = outboxPath(conversationId, root);
    if (!existsSync(path)) return { flushed: 0, status: 'empty' };
    const offsetState = readJson(offsetPath(conversationId, root));
    let offset = Number.isSafeInteger(offsetState?.sentBytes)
      ? offsetState.sentBytes
      : 0;
    const content = readFileSync(path);
    if (offset > content.length) offset = 0;

    let flushed = 0;
    while (offset < content.length) {
      const batch = [];
      let batchBytes = 0;
      let cursor = offset;
      while (cursor < content.length && batch.length < MAX_BATCH_LINES) {
        let end = content.indexOf(0x0a, cursor);
        if (end === -1) end = content.length;
        const raw = content.subarray(cursor, end).toString('utf8');
        const lineEnd = Math.min(end + 1, content.length);
        if (raw.trim()) {
          if (batchBytes + raw.length > MAX_BATCH_BYTES && batch.length > 0) break;
          try {
            JSON.parse(raw);
            batch.push(raw);
            batchBytes += raw.length;
          } catch {
            // A corrupt line (interleaved concurrent write) would poison the
            // whole batch server-side; skip past it instead.
          }
        }
        cursor = lineEnd;
      }
      if (batch.length === 0) {
        offset = cursor;
        writeJsonAtomically(offsetPath(conversationId, root), { sentBytes: offset });
        continue;
      }
      const status = await postTranscriptBatch(
        marker.captureHookUrl,
        conversationId,
        batch,
        fetchImpl
      );
      if (status === 401) {
        // The capability is expired or revoked; capture must re-opt-in.
        deactivateCapture(conversationId, { root });
        return { flushed, status: 'unauthorized' };
      }
      if (status < 200 || status >= 300) {
        return { flushed, status: 'error' };
      }
      offset = cursor;
      flushed += batch.length;
      writeJsonAtomically(offsetPath(conversationId, root), { sentBytes: offset });
    }
    return { flushed, status: 'ok' };
  } finally {
    rmSync(lock, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Lifecycle commands

export async function activateCapture(
  captureHookUrl,
  { root = defaultRoot(), conversationId, now = Date.now } = {}
) {
  captureHookUrl = safeCaptureHookUrl(captureHookUrl);
  const resolvedId =
    conversationId ??
    readJson(currentSessionPath(root))?.conversationId ??
    (await readMetaData('agent/id'));
  const providerSessionId = safeConversationId(resolvedId);
  const state = {
    version: MARKER_VERSION,
    provider: 'cursor',
    providerSessionId,
    captureHookUrl,
    activatedAt: now(),
  };
  writeJsonAtomically(markerPath(providerSessionId, root), state);
  return { providerSessionId };
}

export function deactivateCapture(conversationId, { root = defaultRoot() } = {}) {
  rmSync(lockPath(conversationId, root), { force: true });
  rmSync(offsetPath(conversationId, root), { force: true });
  rmSync(outboxPath(conversationId, root), { force: true });
  rmSync(markerPath(conversationId, root), { force: true });
}

export async function handleHookInvocation(
  input,
  { root = defaultRoot(), fetchImpl = fetch, now = Date.now } = {}
) {
  const conversationId = input?.conversation_id;
  try {
    safeConversationId(conversationId);
  } catch {
    return { status: 'ignored' };
  }
  // Identity dead-drop: lets `activate` (run as an agent shell command with
  // no hook stdin) learn the current conversation id.
  writeJsonAtomically(currentSessionPath(root), {
    conversationId,
    updatedAt: now(),
  });

  const marker = readMarker(conversationId, root);
  if (!marker) return { status: 'inactive' };

  appendOutboxLines(conversationId, mapHookEventToLines(input, { now }), root);
  return flushOutbox(conversationId, marker, { root, fetchImpl, now });
}

// ---------------------------------------------------------------------------
// CLI

function readStdin() {
  try {
    const input = readFileSync(0, 'utf8');
    return input.trim() ? JSON.parse(input) : {};
  } catch {
    return {};
  }
}

async function runCli() {
  const command = process.argv[2];
  if (command === 'activate') {
    const { providerSessionId } = await activateCapture(process.argv[3]);
    // Confirmation only. Never echo the capture capability URL.
    process.stdout.write(
      `${JSON.stringify({ status: 'activated', providerSessionId })}\n`
    );
    return;
  }
  if (command === 'deactivate') {
    const conversationId =
      process.argv[3] ??
      readJson(currentSessionPath(defaultRoot()))?.conversationId;
    deactivateCapture(safeConversationId(conversationId));
    process.stdout.write(`${JSON.stringify({ status: 'deactivated' })}\n`);
    return;
  }
  if (command === 'meta') {
    const value = await readMetaData(process.argv[3] ?? '');
    process.stdout.write(`${value ?? ''}\n`);
    return;
  }

  const input = readStdin();
  try {
    await handleHookInvocation(input);
  } catch {
    // Capture must never fail the agent.
  }
  process.stdout.write('{}\n');
}

const { resolve } = await import('node:path');
const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) await runCli();
