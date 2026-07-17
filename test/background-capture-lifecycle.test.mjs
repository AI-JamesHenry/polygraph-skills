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
  return {
    root,
    settingsPath: join(root, '.claude', 'settings.json'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function activate(testFixture) {
  return activateBackgroundCapture(
    PROVIDER_SESSION_ID,
    CAPTURE_HOOK_URL,
    {
      root: testFixture.root,
      settingsPath: testFixture.settingsPath,
      now: 1_000,
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

test('activation stores a scoped capability for preloaded plugin hooks', () => {
  const f = fixture();
  try {
    const state = activate(f);
    assert.equal(state.version, 3);
    assert.equal(state.captureMode, 'plugin-command-http');
    assert.equal(state.captureHookUrl, CAPTURE_HOOK_URL);
    assert.equal(existsSync(f.settingsPath), false);

    const marker = readFileSync(
      join(
        f.root,
        'background-capture',
        `claude-${PROVIDER_SESSION_ID}.json`,
      ),
      'utf8',
    );
    assert.match(marker, /plugin-command-http/);
    assert.match(marker, /pch_test-capability/);
    assert.doesNotMatch(marker, /service.account|client.secret|bearer/i);
  } finally {
    f.cleanup();
  }
});

test('default activation does not create project-local hook settings', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, '.git', 'info'), { recursive: true });
    activateBackgroundCapture(PROVIDER_SESSION_ID, CAPTURE_HOOK_URL, {
      root: f.root,
      projectDir: f.root,
      now: 1_000,
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

test('activation removes stale direct hooks and preserves other settings', () => {
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
    activate(f);
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

test('activated plugin hooks forward events through the scoped capability', async () => {
  const f = fixture();
  try {
    activate(f);
    const requests = [];
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
          { root: f.root, fetchImpl },
        ),
        { exitCode: 0, stdout: '', stderr: '' },
      );
    }
    assert.equal(requests.length, 3);
    assert(requests.every(({ url }) => url === CAPTURE_HOOK_URL));
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      hook_event_name: 'UserPromptSubmit',
      session_id: PROVIDER_SESSION_ID,
      prompt: 'hello',
    });
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
    activate(f);
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
