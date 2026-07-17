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

test('ordinary sessions are a local no-op and transmit no prompt content', () => {
  const f = fixture();
  try {
    const result = handleBackgroundCaptureHook(
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

test('activation installs scoped HTTP hooks without long-lived credentials', () => {
  const f = fixture();
  try {
    const state = activate(f);
    assert.equal(state.version, 3);
    assert.equal(state.captureMode, 'native-http-hooks');

    const settings = JSON.parse(readFileSync(f.settingsPath, 'utf8'));
    assert(settings.hooks.UserPromptSubmit);
    assert.equal(settings.hooks.MessageDisplay, undefined);
    assert(settings.hooks.Stop);
    assert(settings.hooks.PreToolUse);
    assert(settings.hooks.PostToolUse);
    assert(settings.hooks.PostToolUseFailure);
    assert.equal('matcher' in settings.hooks.UserPromptSubmit[0], false);
    assert.equal('matcher' in settings.hooks.Stop[0], false);
    assert.deepEqual(settings.hooks.Stop[0].hooks[0], {
      type: 'http',
      url: CAPTURE_HOOK_URL,
      timeout: 30,
    });
    assert.deepEqual(
      settings.hooks.UserPromptExpansion[0].hooks[0],
      settings.hooks.Stop[0].hooks[0],
    );
    assert.deepEqual(
      settings.hooks.PostCompact[0].hooks[0],
      settings.hooks.Stop[0].hooks[0],
    );
    assert.doesNotMatch(readFileSync(f.settingsPath, 'utf8'), /token|secret/i);
  } finally {
    f.cleanup();
  }
});

test('default activation uses Git-excluded project-local settings', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, '.git', 'info'), { recursive: true });
    activateBackgroundCapture(PROVIDER_SESSION_ID, CAPTURE_HOOK_URL, {
      root: f.root,
      projectDir: f.root,
      now: 1_000,
    });

    const settingsPath = join(f.root, '.claude', 'settings.local.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert(settings.hooks.UserPromptSubmit);
    assert.match(
      readFileSync(join(f.root, '.git', 'info', 'exclude'), 'utf8'),
      /^\/.claude\/settings\.local\.json$/m,
    );
  } finally {
    f.cleanup();
  }
});

test('activation preserves existing settings and is idempotent', () => {
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
    activate(f);
    const settings = JSON.parse(readFileSync(f.settingsPath, 'utf8'));
    assert.equal(settings.theme, 'dark');
    assert.equal(settings.hooks.UserPromptSubmit.length, 3);
    assert.equal(
      settings.hooks.UserPromptSubmit[1].hooks[0].url,
      'https://%'
    );
    assert.equal(
      settings.hooks.UserPromptSubmit.filter(
        (group) => group.hooks[0].url === CAPTURE_HOOK_URL,
      ).length,
      1,
    );
  } finally {
    f.cleanup();
  }
});

test('activated command hooks become no-ops so events are not duplicated', () => {
  const f = fixture();
  try {
    activate(f);
    for (const hook_event_name of ['UserPromptSubmit', 'Stop', 'SessionStart']) {
      assert.deepEqual(
        handleBackgroundCaptureHook(
          { hook_event_name, session_id: PROVIDER_SESSION_ID },
          { root: f.root },
        ),
        { exitCode: 0, stdout: '', stderr: '' },
      );
    }
  } finally {
    f.cleanup();
  }
});

test('deactivation removes only Polygraph-owned hooks and the marker', () => {
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
      handleBackgroundCaptureHook(
        { hook_event_name: 'UserPromptSubmit', session_id: PROVIDER_SESSION_ID },
        { root: f.root },
      ),
      { exitCode: 0, stdout: '', stderr: '' },
    );
  } finally {
    f.cleanup();
  }
});
