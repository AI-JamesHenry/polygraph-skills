import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activateBackgroundCapture,
  deactivateBackgroundCapture,
  handleBackgroundCaptureHook,
} from '../source/hooks/background-capture-lifecycle.mjs';

const PROVIDER_SESSION_ID = '88b2ff2e-b146-458c-85fc-109c7bc12f26';
const CAPTURE_HOOK_URL =
  'https://polygraph.example.test/hooks/capture/pch_test-capability';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'polygraph-background-capture-'));
  const transcriptPath = join(root, 'claude-transcript.jsonl');
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Initial opted-in prompt' },
    })}\n`,
  );
  return {
    root,
    transcriptPath,
    settingsPath: join(root, '.claude', 'settings.json'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function activate(testFixture) {
  return activateBackgroundCapture(
    PROVIDER_SESSION_ID,
    CAPTURE_HOOK_URL,
    {
      root: testFixture.root,
      settingsPath: testFixture.settingsPath,
      now: 1_000,
      transcriptPath: testFixture.transcriptPath,
      ensureSidecar: async () => ({ status: 'ready' }),
    }
  );
}

test('ordinary sessions are a local no-op and transmit no prompt content', async () => {
  const f = fixture();
  try {
    const result = await handleBackgroundCaptureHook(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: PROVIDER_SESSION_ID,
        prompt: 'private prompt that must stay local',
      },
      { root: f.root },
    );
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(existsSync(f.settingsPath), false);
  } finally {
    f.cleanup();
  }
});

test('activation stores a scoped capability for the transcript sidecar', async () => {
  const f = fixture();
  try {
    const state = await activate(f);
    assert.equal(state.version, 4);
    assert.equal(state.captureMode, 'transcript-sidecar');
    assert.equal(state.captureHookUrl, CAPTURE_HOOK_URL);
    assert.equal(state.transcriptPath, f.transcriptPath);
    assert.equal(state.startOffset, 0);
    assert.equal(existsSync(f.settingsPath), false);

    const marker = readFileSync(
      join(
        f.root,
        'background-capture',
        `claude-${PROVIDER_SESSION_ID}.json`,
      ),
      'utf8',
    );
    assert.match(marker, /transcript-sidecar/);
    assert.match(marker, /pch_test-capability/);
    assert.doesNotMatch(marker, /service.account|client.secret|bearer/i);
  } finally {
    f.cleanup();
  }
});

test('activation starts at the latest real user prompt and excludes earlier conversation', async () => {
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
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
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

test('default activation does not create project-local hook settings', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, '.git', 'info'), { recursive: true });
    await activateBackgroundCapture(PROVIDER_SESSION_ID, CAPTURE_HOOK_URL, {
      root: f.root,
      projectDir: f.root,
      now: 1_000,
      transcriptPath: f.transcriptPath,
      ensureSidecar: async () => ({ status: 'ready' }),
    });

    assert.equal(
      existsSync(join(f.root, '.claude', 'settings.local.json')),
      false,
    );
    assert.equal(existsSync(join(f.root, '.git', 'info', 'exclude')), false);
  } finally {
    f.cleanup();
  }
});

test('activation removes stale direct hooks and preserves other settings', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, '.claude'), { recursive: true });
    writeFileSync(
      f.settingsPath,
      JSON.stringify({
        theme: 'dark',
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'existing-hook' }] },
            { hooks: [{ type: 'http', url: 'https://%' }] },
          ],
        },
      }),
    );
    await activate(f);
    const settings = JSON.parse(readFileSync(f.settingsPath, 'utf8'));
    assert.equal(settings.theme, 'dark');
    assert.equal(settings.hooks.UserPromptSubmit.length, 2);
    assert.equal(
      settings.hooks.UserPromptSubmit[1].hooks[0].url,
      'https://%'
    );
  } finally {
    f.cleanup();
  }
});

test('activated plugin hooks keep the detached transcript sidecar alive without duplicating hook events', async () => {
  const f = fixture();
  try {
    await activate(f);
    const requests = [];
    const recoveries = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    };
    for (const hook_event_name of [
      'UserPromptSubmit',
      'Stop',
      'PreToolUse',
    ]) {
      assert.deepEqual(
        await handleBackgroundCaptureHook(
          { hook_event_name, session_id: PROVIDER_SESSION_ID, prompt: 'hello' },
          {
            root: f.root,
            fetchImpl,
            ensureSidecar: async (state) => recoveries.push(state),
          },
        ),
        { exitCode: 0, stdout: '', stderr: '' },
      );
    }
    assert.equal(recoveries.length, 3);
    assert(recoveries.every((state) => state.version === 4));
    assert.equal(requests.length, 0);
  } finally {
    f.cleanup();
  }
});

test('resume recovery follows a replacement worker transcript without transmitting through hooks', async () => {
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
      })}\n`,
    );
    const recovered = [];

    const result = await handleBackgroundCaptureHook(
      {
        hook_event_name: 'SessionStart',
        session_id: PROVIDER_SESSION_ID,
      },
      {
        root: f.root,
        home: f.root,
        ensureSidecar: async (state) => recovered.push(state),
      },
    );

    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(recovered[0].transcriptPath, replacementPath);
    assert.equal(recovered[0].startOffset, 0);
    const marker = JSON.parse(
      readFileSync(
        join(
          f.root,
          'background-capture',
          `claude-${PROVIDER_SESSION_ID}.json`,
        ),
        'utf8',
      ),
    );
    assert.equal(marker.transcriptPath, replacementPath);
  } finally {
    f.cleanup();
  }
});

test('deactivation removes only Polygraph-owned hooks and the marker', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, '.claude'), { recursive: true });
    writeFileSync(
      f.settingsPath,
      JSON.stringify({
        hooks: {
          MessageDisplay: [
            { hooks: [{ type: 'command', command: 'keep-me' }] },
          ],
        },
      }),
    );
    await activate(f);
    deactivateBackgroundCapture(PROVIDER_SESSION_ID, {
      root: f.root,
      settingsPath: f.settingsPath,
    });
    const settings = JSON.parse(readFileSync(f.settingsPath, 'utf8'));
    assert.deepEqual(settings.hooks.MessageDisplay, [
      { hooks: [{ type: 'command', command: 'keep-me' }] },
    ]);
    assert.equal(settings.hooks.UserPromptSubmit, undefined);
    assert.deepEqual(
      await handleBackgroundCaptureHook(
        { hook_event_name: 'UserPromptSubmit', session_id: PROVIDER_SESSION_ID },
        { root: f.root },
      ),
      { exitCode: 0, stdout: '', stderr: '' },
    );
  } finally {
    f.cleanup();
  }
});
