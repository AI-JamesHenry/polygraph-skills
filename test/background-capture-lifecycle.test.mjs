import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activateBackgroundCapture,
  handleBackgroundCaptureHook,
} from '../source/hooks/background-capture-lifecycle.mjs';

const PROVIDER_SESSION_ID = '88b2ff2e-b146-458c-85fc-109c7bc12f26';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'polygraph-background-capture-'));
}

test('ordinary sessions are a local no-op and transmit no prompt content', () => {
  const root = makeRoot();
  try {
    const prompt = 'private prompt that must stay local';
    const result = handleBackgroundCaptureHook(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: PROVIDER_SESSION_ID,
        prompt,
      },
      { root }
    );

    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.doesNotMatch(result.stdout, /private prompt/);
    assert.doesNotMatch(result.stderr, /private prompt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an activated session receives a fail-closed prompt capture instruction', () => {
  const root = makeRoot();
  try {
    activateBackgroundCapture(PROVIDER_SESSION_ID, { root, now: 1_000 });

    const result = handleBackgroundCaptureHook(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: PROVIDER_SESSION_ID,
        prompt: 'capture this follow-up',
      },
      { root, now: 2_000 }
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    const context = output.hookSpecificOutput.additionalContext;
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(context, /mcp__polygraph-oauth-spike__background_capture_event/);
    assert.match(context, /eventType `user_prompt`/);
    assert.match(context, /current user prompt verbatim/);
    assert.match(context, new RegExp(PROVIDER_SESSION_ID));
    assert.doesNotMatch(context, /capture this follow-up/);
    assert.match(context, /If capture fails, stop before doing any other work/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a marker for another provider session does not opt in this session', () => {
  const root = makeRoot();
  try {
    activateBackgroundCapture(PROVIDER_SESSION_ID, { root, now: 1_000 });

    const result = handleBackgroundCaptureHook(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'different-session',
        prompt: 'must not leave this worker',
      },
      { root, now: 2_000 }
    );

    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resume re-injects capture instructions for an activated session', () => {
  const root = makeRoot();
  try {
    activateBackgroundCapture(PROVIDER_SESSION_ID, { root, now: 1_000 });

    const result = handleBackgroundCaptureHook(
      {
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: PROVIDER_SESSION_ID,
      },
      { root, now: 2_000 }
    );

    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout);
    const context = output.hookSpecificOutput.additionalContext;
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(context, /remains active after resume/i);
    assert.match(context, /UserPromptSubmit and Stop hooks/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the first stop blocks until the exact assistant response is captured', () => {
  const root = makeRoot();
  try {
    activateBackgroundCapture(PROVIDER_SESSION_ID, { root, now: 1_000 });

    const result = handleBackgroundCaptureHook(
      {
        hook_event_name: 'Stop',
        session_id: PROVIDER_SESSION_ID,
        stop_hook_active: false,
        last_assistant_message: 'Polygraph capture after resume is live.',
      },
      { root, now: 2_000 }
    );

    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /mcp__polygraph-oauth-spike__background_capture_event/);
    assert.match(result.stderr, /eventType `assistant_response`/);
    assert.match(result.stderr, /Polygraph capture after resume is live\./);
    assert.match(result.stderr, new RegExp(PROVIDER_SESSION_ID));
    assert.match(result.stderr, /If capture fails, report the failure and do not claim success/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('multiline assistant responses are supplied with real line breaks', () => {
  const root = makeRoot();
  try {
    activateBackgroundCapture(PROVIDER_SESSION_ID, { root, now: 1_000 });

    const result = handleBackgroundCaptureHook(
      {
        hook_event_name: 'Stop',
        session_id: PROVIDER_SESSION_ID,
        stop_hook_active: false,
        last_assistant_message: 'First paragraph.\n\nSecond paragraph.',
      },
      { root, now: 2_000 }
    );

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /First paragraph\.\n\nSecond paragraph\./);
    assert.doesNotMatch(
      result.stderr,
      /First paragraph\.\\n\\nSecond paragraph\./
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stop-hook continuation is allowed to finish without recursing', () => {
  const root = makeRoot();
  try {
    activateBackgroundCapture(PROVIDER_SESSION_ID, { root, now: 1_000 });

    const result = handleBackgroundCaptureHook(
      {
        hook_event_name: 'Stop',
        session_id: PROVIDER_SESSION_ID,
        stop_hook_active: true,
        last_assistant_message: 'Already captured',
      },
      { root, now: 2_000 }
    );

    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
