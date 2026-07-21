import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activateBackgroundCapture,
  deactivateBackgroundCapture,
  ensureHostedTranscriptSidecar,
  handleBackgroundCaptureHook,
  safeCaptureHookUrl,
  safeProviderSessionId,
} from '../source/hooks/background-capture-lifecycle.mjs';

const PROVIDER_SESSION_ID = '88b2ff2e-b146-458c-85fc-109c7bc12f26';
const CAPTURE_HOOK_URL =
  'https://polygraph.example.test/hooks/capture/pch_fake-test-capability';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'polygraph-background-capture-'));
  const transcriptPath = join(root, 'claude-transcript.jsonl');
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Initial opted-in prompt' },
    })}\n`
  );
  return {
    root,
    transcriptPath,
    markerPath: join(
      root,
      'background-capture',
      `claude-${PROVIDER_SESSION_ID}.json`
    ),
    runtimePath: join(
      root,
      'background-capture',
      `claude-${PROVIDER_SESSION_ID}.sidecar.json`
    ),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function activate(f, overrides = {}) {
  return activateBackgroundCapture(PROVIDER_SESSION_ID, CAPTURE_HOOK_URL, {
    root: f.root,
    now: 1_000,
    transcriptPath: f.transcriptPath,
    ensureSidecar: async () => ({ status: 'ready' }),
    ...overrides,
  });
}

test('sessions without an activation marker are a local no-op', async () => {
  const f = fixture();
  try {
    for (const hook_event_name of [
      'UserPromptSubmit',
      'SessionStart',
      'PostToolUse',
      'Stop',
    ]) {
      const result = await handleBackgroundCaptureHook(
        {
          hook_event_name,
          session_id: PROVIDER_SESSION_ID,
          prompt: 'private prompt that must stay local',
        },
        {
          root: f.root,
          ensureSidecar: async () => {
            throw new Error('must not start a sidecar without opt-in');
          },
        }
      );
      assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    }
  } finally {
    f.cleanup();
  }
});

test('invalid provider session IDs are rejected', () => {
  for (const value of [
    undefined,
    null,
    '',
    'a'.repeat(241),
    'not/a/session',
    'id with spaces',
    '$CLAUDE_CODE_SESSION_ID',
    '${CLAUDE_CODE_SESSION_ID}',
    'CLAUDE_CODE_SESSION_ID',
  ]) {
    assert.throws(
      () => safeProviderSessionId(value),
      /Invalid Claude provider session ID/
    );
  }
  assert.equal(
    safeProviderSessionId(PROVIDER_SESSION_ID),
    PROVIDER_SESSION_ID
  );
});

test('capture capability URLs are validated fail-closed', () => {
  for (const value of [
    undefined,
    '',
    'not-a-url',
    'http://polygraph.example.test/hooks/capture/pch_abc',
    'https://polygraph.example.test/other/pch_abc',
    'https://polygraph.example.test/hooks/capture/pch_abc?x=1',
    'https://polygraph.example.test/hooks/capture/pch_abc#frag',
    `https://polygraph.example.test/hooks/capture/pch_${'a'.repeat(2_000)}`,
  ]) {
    assert.throws(
      () => safeCaptureHookUrl(value),
      /Invalid Polygraph capture hook URL/
    );
  }
  assert.equal(safeCaptureHookUrl(CAPTURE_HOOK_URL), CAPTURE_HOOK_URL);
});

test('activation writes an atomic mode-0600 marker with only the expected fields', async () => {
  const f = fixture();
  try {
    const state = await activate(f);
    assert.equal(state.version, 5);
    assert.equal(state.provider, 'claude');
    assert.equal(state.captureMode, 'transcript-sidecar');
    assert.equal(state.captureHookUrl, CAPTURE_HOOK_URL);
    assert.equal(state.transcriptPath, f.transcriptPath);
    assert.equal(state.startOffset, 0);

    assert.equal(statSync(f.markerPath).mode & 0o777, 0o600);
    const marker = JSON.parse(readFileSync(f.markerPath, 'utf8'));
    assert.deepEqual(Object.keys(marker).sort(), [
      'activatedAt',
      'captureHookUrl',
      'captureMode',
      'provider',
      'providerSessionId',
      'startOffset',
      'transcriptPath',
      'version',
    ]);
    assert.doesNotMatch(
      JSON.stringify(marker),
      /service.account|client.secret|bearer|refresh.token|access.token/i
    );
  } finally {
    f.cleanup();
  }
});

test('activation records the byte offset of the opt-in prompt and excludes earlier conversation', async () => {
  const f = fixture();
  try {
    const earlier = `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Earlier private prompt' },
    })}\n`;
    const toolResult = `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
        ],
      },
    })}\n`;
    const optedIn = `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Current opted-in skill prompt' },
    })}\n`;
    writeFileSync(f.transcriptPath, earlier + optedIn + toolResult);

    const state = await activate(f);

    assert.equal(state.startOffset, Buffer.byteLength(earlier));
  } finally {
    f.cleanup();
  }
});

test('failed activation removes the partial marker and runtime state', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      activate(f, {
        ensureSidecar: async () => {
          throw new Error('sidecar refused to start');
        },
      }),
      /sidecar refused to start/
    );
    assert.equal(existsSync(f.markerPath), false);
    assert.equal(existsSync(f.runtimePath), false);

    const result = await handleBackgroundCaptureHook(
      { hook_event_name: 'UserPromptSubmit', session_id: PROVIDER_SESSION_ID },
      { root: f.root }
    );
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
  } finally {
    f.cleanup();
  }
});

test('activation rejects an invalid capability without touching disk state', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      activateBackgroundCapture(
        PROVIDER_SESSION_ID,
        'http://insecure.example.test/hooks/capture/pch_abc',
        { root: f.root, transcriptPath: f.transcriptPath }
      ),
      /Invalid Polygraph capture hook URL/
    );
    assert.equal(existsSync(join(f.root, 'background-capture')), false);
  } finally {
    f.cleanup();
  }
});

test('activated hooks maintain the sidecar without transmitting hook payloads', async () => {
  const f = fixture();
  try {
    await activate(f);
    const recoveries = [];
    for (const hook_event_name of [
      'UserPromptSubmit',
      'PostToolUse',
      'Stop',
    ]) {
      assert.deepEqual(
        await handleBackgroundCaptureHook(
          {
            hook_event_name,
            session_id: PROVIDER_SESSION_ID,
            prompt: 'hello',
          },
          {
            root: f.root,
            ensureSidecar: async (state) => recoveries.push(state),
          }
        ),
        { exitCode: 0, stdout: '', stderr: '' }
      );
    }
    assert.equal(recoveries.length, 3);
    assert.ok(recoveries.every((state) => state.version === 5));
  } finally {
    f.cleanup();
  }
});

test('sidecar failures surface on stderr without leaking the capability', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await handleBackgroundCaptureHook(
      { hook_event_name: 'UserPromptSubmit', session_id: PROVIDER_SESSION_ID },
      {
        root: f.root,
        ensureSidecar: async () => {
          throw new Error('spawn failed');
        },
      }
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /sidecar recovery failed/);
    assert.doesNotMatch(result.stderr, /pch_/);
    assert.doesNotMatch(result.stderr, /polygraph\.example\.test/);
  } finally {
    f.cleanup();
  }
});

test('a healthy existing sidecar is not duplicated', async () => {
  const f = fixture();
  try {
    const state = await activate(f);
    writeFileSync(
      f.runtimePath,
      `${JSON.stringify({
        version: 1,
        providerSessionId: PROVIDER_SESSION_ID,
        transcriptPath: state.transcriptPath,
        captureHookUrl: CAPTURE_HOOK_URL,
        pid: process.pid,
        startOffset: state.startOffset,
        byteOffset: 0,
      })}\n`
    );
    let spawned = 0;
    const runtime = await ensureHostedTranscriptSidecar(state, {
      root: f.root,
      spawnImpl: () => {
        spawned += 1;
        return { pid: 999_999, unref: () => {} };
      },
    });
    assert.equal(spawned, 0);
    assert.equal(runtime.pid, process.pid);
  } finally {
    f.cleanup();
  }
});

test('a dead sidecar is restarted by a later lifecycle hook', async () => {
  const f = fixture();
  try {
    const state = await activate(f);
    // A pid that cannot be alive: beyond pid_max on Linux.
    writeFileSync(
      f.runtimePath,
      `${JSON.stringify({
        version: 1,
        providerSessionId: PROVIDER_SESSION_ID,
        transcriptPath: state.transcriptPath,
        captureHookUrl: CAPTURE_HOOK_URL,
        pid: 2 ** 30,
        startOffset: state.startOffset,
        byteOffset: 0,
      })}\n`
    );
    const spawnedPids = [];
    const runtime = await ensureHostedTranscriptSidecar(state, {
      root: f.root,
      entryPath: f.transcriptPath,
      spawnImpl: (_cmd, _args, options) => {
        spawnedPids.push(process.pid);
        // Simulate the restarted sidecar acknowledging readiness.
        writeFileSync(
          options.env.POLYGRAPH_PARENT_LOG_RUNTIME_PATH,
          `${JSON.stringify({
            version: 1,
            providerSessionId:
              options.env.POLYGRAPH_PARENT_LOG_PARENT_SESSION_ID,
            transcriptPath: options.env.POLYGRAPH_PARENT_LOG_PATH,
            captureHookUrl:
              options.env.POLYGRAPH_PARENT_LOG_CAPTURE_HOOK_URL,
            pid: process.pid,
            startOffset: Number(
              options.env.POLYGRAPH_PARENT_LOG_START_OFFSET
            ),
            byteOffset: 0,
          })}\n`
        );
        return { pid: process.pid, unref: () => {} };
      },
    });
    assert.equal(spawnedPids.length, 1);
    assert.equal(runtime.pid, process.pid);
  } finally {
    f.cleanup();
  }
});

test('resume recovery follows a replacement worker transcript from offset zero', async () => {
  const f = fixture();
  try {
    await activate(f);
    rmSync(f.transcriptPath, { force: true });
    const projectDir = join(f.root, '.claude', 'projects', 'replacement');
    const replacementPath = join(projectDir, `${PROVIDER_SESSION_ID}.jsonl`);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      replacementPath,
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Post-replacement prompt' },
      })}\n`
    );
    const recovered = [];

    const result = await handleBackgroundCaptureHook(
      { hook_event_name: 'SessionStart', session_id: PROVIDER_SESSION_ID },
      {
        root: f.root,
        home: f.root,
        ensureSidecar: async (state) => recovered.push(state),
      }
    );

    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(recovered[0].transcriptPath, replacementPath);
    assert.equal(recovered[0].startOffset, 0);
    const marker = JSON.parse(readFileSync(f.markerPath, 'utf8'));
    assert.equal(marker.transcriptPath, replacementPath);
    assert.equal(statSync(f.markerPath).mode & 0o777, 0o600);
  } finally {
    f.cleanup();
  }
});

test('a truncated transcript resets the start offset instead of failing', async () => {
  const f = fixture();
  try {
    const padding = `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'x'.repeat(500) },
    })}\n`;
    writeFileSync(f.transcriptPath, padding.repeat(3));
    await activate(f, { startOffset: Buffer.byteLength(padding) * 2 });
    writeFileSync(f.transcriptPath, padding);

    const recovered = [];
    const result = await handleBackgroundCaptureHook(
      { hook_event_name: 'SessionStart', session_id: PROVIDER_SESSION_ID },
      {
        root: f.root,
        ensureSidecar: async (state) => recovered.push(state),
      }
    );
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(recovered[0].startOffset, 0);
  } finally {
    f.cleanup();
  }
});

test('markers from obsolete spike schemas are deactivated, not migrated', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'background-capture'), { recursive: true });
    writeFileSync(
      f.markerPath,
      `${JSON.stringify({
        version: 4,
        provider: 'claude',
        providerSessionId: PROVIDER_SESSION_ID,
        activatedAt: 1_000,
        captureMode: 'transcript-sidecar',
        captureHookUrl: CAPTURE_HOOK_URL,
        transcriptPath: f.transcriptPath,
        startOffset: 0,
        settingsPath: join(f.root, '.claude', 'settings.local.json'),
      })}\n`
    );
    const result = await handleBackgroundCaptureHook(
      { hook_event_name: 'UserPromptSubmit', session_id: PROVIDER_SESSION_ID },
      {
        root: f.root,
        ensureSidecar: async () => {
          throw new Error('an obsolete marker must not drive capture');
        },
      }
    );
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(existsSync(f.markerPath), false);
  } finally {
    f.cleanup();
  }
});

test('deactivation removes the marker and runtime state and returns hooks to inert', async () => {
  const f = fixture();
  try {
    await activate(f);
    deactivateBackgroundCapture(PROVIDER_SESSION_ID, { root: f.root });
    assert.equal(existsSync(f.markerPath), false);
    assert.equal(existsSync(f.runtimePath), false);
    assert.deepEqual(
      await handleBackgroundCaptureHook(
        {
          hook_event_name: 'UserPromptSubmit',
          session_id: PROVIDER_SESSION_ID,
        },
        { root: f.root }
      ),
      { exitCode: 0, stdout: '', stderr: '' }
    );
  } finally {
    f.cleanup();
  }
});
