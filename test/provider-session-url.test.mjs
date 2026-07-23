import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDER_SESSION_URL_ORIGINS,
  resolveProviderSessionUrl,
  resolveProviderSessionUrlFromRemoteSessionId,
} from '../source/hooks/provider-session-url.mjs';

const VALID_URL = 'https://claude.ai/code/session_0123456789abcdef';

test('a provider-supplied Claude session URL passes through unchanged', () => {
  assert.equal(resolveProviderSessionUrl(VALID_URL), VALID_URL);
  assert.equal(resolveProviderSessionUrl(`  ${VALID_URL}  `), VALID_URL);
  assert.equal(
    resolveProviderSessionUrl('https://claude.com/code/session_abcdefgh'),
    'https://claude.com/code/session_abcdefgh'
  );
});

test('a Claude remote session ID resolves through the documented prefix conversion', () => {
  assert.equal(
    resolveProviderSessionUrlFromRemoteSessionId('cse_0123456789abcdef'),
    'https://claude.ai/code/session_0123456789abcdef'
  );
  assert.equal(
    resolveProviderSessionUrlFromRemoteSessionId('  cse_abcdefgh  '),
    'https://claude.ai/code/session_abcdefgh'
  );
});

test('invalid Claude remote session IDs fail closed', () => {
  for (const value of [
    undefined,
    null,
    '',
    'session_0123456789abcdef',
    'cse_short',
    '$CLAUDE_CODE_REMOTE_SESSION_ID',
    'cse_abc/defgh',
  ]) {
    assert.throws(
      () => resolveProviderSessionUrlFromRemoteSessionId(value),
      /Invalid Claude provider session URL/
    );
  }
});

test('only supported Claude origins are accepted', () => {
  assert.deepEqual(PROVIDER_SESSION_URL_ORIGINS, [
    'https://claude.ai',
    'https://claude.com',
  ]);
  for (const url of [
    'https://polygraph.example.test/code/session_0123456789abcdef',
    'https://evil-claude.ai/code/session_0123456789abcdef',
    'https://sub.claude.ai/code/session_0123456789abcdef',
    'https://localhost/code/session_0123456789abcdef',
    'https://127.0.0.1/code/session_0123456789abcdef',
    'https://claude.ai:8443/code/session_0123456789abcdef',
  ]) {
    assert.throws(
      () => resolveProviderSessionUrl(url),
      /Invalid Claude provider session URL/
    );
  }
});

test('malformed, empty, and non-HTTPS inputs fail closed', () => {
  for (const value of [
    undefined,
    null,
    '',
    '   ',
    'not a url',
    'claude.ai/code/session_0123456789abcdef',
    'http://claude.ai/code/session_0123456789abcdef',
    `https://claude.ai/code/${'a'.repeat(2_100)}`,
  ]) {
    assert.throws(
      () => resolveProviderSessionUrl(value),
      /Invalid Claude provider session URL/
    );
  }
});

test('non-session routes and decorated URLs are rejected', () => {
  for (const url of [
    'https://claude.ai/',
    'https://claude.ai/code',
    'https://claude.ai/code/',
    'https://claude.ai/code/short',
    'https://claude.ai/code/session_0123456789abcdef/extra',
    'https://claude.ai/settings/profile',
    'https://claude.ai/code/session_0123456789abcdef?utm=1',
    'https://claude.ai/code/session_0123456789abcdef#part',
    'https://user:pass@claude.ai/code/session_0123456789abcdef',
  ]) {
    assert.throws(
      () => resolveProviderSessionUrl(url),
      /Invalid Claude provider session URL/
    );
  }
});

test('fabricated-looking placeholder URLs are rejected', () => {
  for (const url of [
    'https://claude.ai/code/$CLAUDE_CODE_SESSION_ID',
    'https://claude.ai/code/${CLAUDE_CODE_SESSION_ID}',
    'https://claude.ai/code/CLAUDE_CODE_SESSION_ID',
    'https://claude.ai/code/<session-id>',
  ]) {
    assert.throws(
      () => resolveProviderSessionUrl(url),
      /Invalid Claude provider session URL/
    );
  }
});
