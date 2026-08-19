import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  activateCapture,
  deactivateCapture,
  flushOutbox,
  handleHookInvocation,
  mapHookEventToLines,
  readMarker,
  safeCaptureHookUrl,
  sanitizeEventId,
} from '../source/cursor/hooks/polygraph-capture.mjs';

const CONVERSATION_ID = 'bc-b185c239-a7c6-4fc0-923f-b6e0c41830e5';
const CAPTURE_URL =
  'https://api.example.com/nx-cloud/polygraph/hooks/capture/pch_0123456789abcdefghijklmnopqrstuvwxyzABCDEF';

// Trimmed real payloads from the 2026-08-19 diagnostics run
// (AI-JamesHenry/polygraph-cursor-diag, diag/events-run1.jsonl).
const PROMPT_EVENT = {
  conversation_id: CONVERSATION_ID,
  generation_id: '26c217c8-9652-455c-bc03-455600354ee6',
  hook_event_name: 'beforeSubmitPrompt',
  prompt: 'Add a function formatToday() to src/util.js …',
};
const SHELL_EVENT = {
  conversation_id: CONVERSATION_ID,
  generation_id: 'e17b7216-ded1-474c-8d78-3a8b1d1e3681',
  hook_event_name: 'postToolUse',
  tool_name: 'Shell',
  tool_input: { command: 'npm test' },
  tool_output: '{"output":"2026-08-19\\n","exitCode":0}',
  // Real ids have been observed to contain an embedded newline.
  tool_use_id: 'call-736e2bdf-1\nfc_owoq9Kh-2',
};
const RESPONSE_EVENT = {
  conversation_id: CONVERSATION_ID,
  generation_id: 'e17b7216-ded1-474c-8d78-3a8b1d1e3681',
  hook_event_name: 'afterAgentResponse',
  text: '`formatToday()` is in place.',
};
const STOP_EVENT = {
  conversation_id: CONVERSATION_ID,
  generation_id: 'run-d99c7b4d-3c5b-4891-a915-a096080c302a',
  hook_event_name: 'stop',
  status: 'completed',
  loop_count: 0,
};

function temporaryRoot() {
  return mkdtempSync(join(tmpdir(), 'polygraph-cursor-capture-'));
}

function fetchRecorder(status = 200) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { status };
  };
  return { calls, impl };
}

test('capture hook URL validation', () => {
  assert.equal(safeCaptureHookUrl(CAPTURE_URL), CAPTURE_URL);
  for (const bad of [
    'http://api.example.com/nx-cloud/polygraph/hooks/capture/pch_0123456789abcdefghijklmnopqrstuvwxyz',
    `${CAPTURE_URL}?x=1`,
    'https://api.example.com/other/pch_0123456789abcdefghijklmnopqrstuvwxyzABCDEF',
    'not a url',
  ]) {
    assert.throws(() => safeCaptureHookUrl(bad));
  }
});

test('prompt, response, and stop events map to AgentLogLine records', () => {
  const now = () => 1755597074438;
  const [prompt] = mapHookEventToLines(PROMPT_EVENT, { now });
  assert.equal(prompt.type, 'user-prompt');
  assert.equal(prompt.text, PROMPT_EVENT.prompt);
  assert.equal(prompt.eventId, `${PROMPT_EVENT.generation_id}:prompt`);
  assert.equal(prompt.timestamp, new Date(1755597074438).toISOString());

  const [response] = mapHookEventToLines(RESPONSE_EVENT, { now });
  assert.deepEqual(
    { type: response.type, role: response.role, text: response.text },
    { type: 'text', role: 'assistant', text: RESPONSE_EVENT.text }
  );

  const [stop] = mapHookEventToLines(STOP_EVENT, { now });
  assert.equal(stop.type, 'event');
  assert.equal(stop.label, 'Run completed');
  assert.equal(stop.eventId, `${STOP_EVENT.generation_id}:stop`);
});

test('postToolUse maps to a sanitized tool-use/tool-result pair', () => {
  const lines = mapHookEventToLines(SHELL_EVENT);
  assert.equal(lines.length, 2);
  const [use, result] = lines;
  assert.equal(use.type, 'tool-use');
  assert.equal(use.toolName, 'Shell');
  assert.equal(use.input, JSON.stringify({ command: 'npm test' }));
  assert.ok(!use.toolUseId.includes('\n'));
  assert.equal(use.eventId, `${use.toolUseId}:use`);
  assert.equal(result.type, 'tool-result');
  assert.equal(result.isError, false);
  assert.equal(result.outputFormat, 'json');
  assert.equal(result.toolUseId, use.toolUseId);

  const [, failure] = mapHookEventToLines({
    ...SHELL_EVENT,
    hook_event_name: 'postToolUseFailure',
  });
  assert.equal(failure.isError, true);
});

test('afterFileEdit and unknown events are not mapped', () => {
  assert.deepEqual(
    mapHookEventToLines({
      conversation_id: CONVERSATION_ID,
      hook_event_name: 'afterFileEdit',
      file_path: '/workspace/src/util.js',
      edits: [{ old_string: 'a', new_string: 'b' }],
    }),
    []
  );
  assert.deepEqual(mapHookEventToLines({ hook_event_name: 'mystery' }), []);
});

test('eventId sanitization strips disallowed characters and caps length', () => {
  assert.equal(sanitizeEventId('a\nb c'), 'a-b-c');
  assert.equal(sanitizeEventId('x'.repeat(400)).length, 256);
});

test('hook invocations transmit nothing before activation', async () => {
  const root = temporaryRoot();
  const { calls, impl } = fetchRecorder();
  const result = await handleHookInvocation(PROMPT_EVENT, {
    root,
    fetchImpl: impl,
  });
  assert.equal(result.status, 'inactive');
  assert.equal(calls.length, 0);
  // The dead-drop is written regardless, so `activate` can find the id.
  const current = JSON.parse(
    readFileSync(join(root, 'background-capture', 'cursor-current.json'), 'utf8')
  );
  assert.equal(current.conversationId, CONVERSATION_ID);
});

test('activate + hook invocation flushes mapped lines exactly once', async () => {
  const root = temporaryRoot();
  await handleHookInvocation(PROMPT_EVENT, { root, fetchImpl: async () => ({ status: 200 }) });
  await activateCapture(CAPTURE_URL, { root });
  assert.ok(readMarker(CONVERSATION_ID, root));

  const { calls, impl } = fetchRecorder();
  const first = await handleHookInvocation(SHELL_EVENT, { root, fetchImpl: impl });
  assert.equal(first.status, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${CAPTURE_URL}/transcript`);
  assert.equal(calls[0].body.providerSessionId, CONVERSATION_ID);
  assert.equal(calls[0].body.source, 'cursor-hooks');
  const sent = calls[0].body.lines.map((line) => JSON.parse(line));
  assert.deepEqual(
    sent.map((line) => line.type),
    ['tool-use', 'tool-result']
  );

  // A later event only sends the new lines; the flushed prefix stays sent.
  const second = await handleHookInvocation(RESPONSE_EVENT, { root, fetchImpl: impl });
  assert.equal(second.status, 'ok');
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[1].body.lines.map((line) => JSON.parse(line).type),
    ['text']
  );
});

test('failed flushes retry on the next invocation', async () => {
  const root = temporaryRoot();
  await handleHookInvocation(PROMPT_EVENT, { root, fetchImpl: async () => ({ status: 200 }) });
  await activateCapture(CAPTURE_URL, { root });

  const failing = await handleHookInvocation(SHELL_EVENT, {
    root,
    fetchImpl: async () => ({ status: 503 }),
  });
  assert.equal(failing.status, 'error');

  const { calls, impl } = fetchRecorder();
  const retried = await handleHookInvocation(RESPONSE_EVENT, { root, fetchImpl: impl });
  assert.equal(retried.status, 'ok');
  // The unsent shell pair and the new response line arrive together.
  assert.deepEqual(
    calls[0].body.lines.map((line) => JSON.parse(line).type),
    ['tool-use', 'tool-result', 'text']
  );
});

test('corrupt outbox lines are skipped, not poisoned', async () => {
  const root = temporaryRoot();
  await handleHookInvocation(PROMPT_EVENT, { root, fetchImpl: async () => ({ status: 200 }) });
  await activateCapture(CAPTURE_URL, { root });
  const outbox = join(
    root,
    'background-capture',
    `cursor-${CONVERSATION_ID}.outbox.jsonl`
  );
  writeFileSync(outbox, '{"type":"user-prompt","text":"ok","eventId":"a:1"}\n{corrupt\n');

  const { calls, impl } = fetchRecorder();
  const result = await flushOutbox(CONVERSATION_ID, readMarker(CONVERSATION_ID, root), {
    root,
    fetchImpl: impl,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.flushed, 1);
  assert.equal(calls.length, 1);
});

test('a 401 deactivates capture', async () => {
  const root = temporaryRoot();
  await handleHookInvocation(PROMPT_EVENT, { root, fetchImpl: async () => ({ status: 200 }) });
  await activateCapture(CAPTURE_URL, { root });

  const result = await handleHookInvocation(SHELL_EVENT, {
    root,
    fetchImpl: async () => ({ status: 401 }),
  });
  assert.equal(result.status, 'unauthorized');
  assert.equal(readMarker(CONVERSATION_ID, root), null);
  assert.ok(
    !existsSync(
      join(root, 'background-capture', `cursor-${CONVERSATION_ID}.outbox.jsonl`)
    )
  );
});

test('deactivate removes all per-session state', async () => {
  const root = temporaryRoot();
  await handleHookInvocation(PROMPT_EVENT, { root, fetchImpl: async () => ({ status: 200 }) });
  await activateCapture(CAPTURE_URL, { root });
  await handleHookInvocation(SHELL_EVENT, { root, fetchImpl: async () => ({ status: 503 }) });
  deactivateCapture(CONVERSATION_ID, { root });
  assert.equal(readMarker(CONVERSATION_ID, root), null);
});
