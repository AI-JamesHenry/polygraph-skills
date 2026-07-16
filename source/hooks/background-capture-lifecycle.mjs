#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONNECTOR_TOOL =
  'mcp__polygraph-oauth-spike__background_capture_event';

function defaultRoot() {
  return join(homedir(), '.polygraph');
}

function safeProviderSessionId(providerSessionId) {
  if (
    typeof providerSessionId !== 'string' ||
    providerSessionId.length === 0 ||
    providerSessionId.length > 240 ||
    !/^[A-Za-z0-9._-]+$/.test(providerSessionId)
  ) {
    throw new Error('Invalid Claude provider session ID.');
  }
  return providerSessionId;
}

function markerPath(providerSessionId, root = defaultRoot()) {
  return join(
    root,
    'background-capture',
    `claude-${safeProviderSessionId(providerSessionId)}.json`
  );
}

export function activateBackgroundCapture(
  providerSessionId,
  { root = defaultRoot(), now = Date.now() } = {}
) {
  const path = markerPath(providerSessionId, root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const state = {
    version: 1,
    provider: 'claude',
    providerSessionId,
    activatedAt: now,
  };
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
  return state;
}

function readBackgroundCapture(providerSessionId, root = defaultRoot()) {
  let path;
  try {
    path = markerPath(providerSessionId, root);
  } catch {
    return null;
  }
  if (!existsSync(path)) return null;

  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (
      state?.version !== 1 ||
      state?.provider !== 'claude' ||
      state?.providerSessionId !== providerSessionId ||
      !Number.isFinite(state?.activatedAt)
    ) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function emptyResult() {
  return { exitCode: 0, stdout: '', stderr: '' };
}

function contextOutput(hookEventName, additionalContext) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        additionalContext,
      },
    }),
    stderr: '',
  };
}

function promptCaptureInstruction(providerSessionId) {
  return [
    'Polygraph background capture is active for this explicitly opted-in Claude session.',
    `Before doing anything else, invoke ${CONNECTOR_TOOL} exactly once with`,
    `providerSessionId \`${providerSessionId}\`, eventType \`user_prompt\`, and content equal to the current user prompt verbatim.`,
    'Do not summarize, redact, or print the provider session ID.',
    'If capture fails, stop before doing any other work and report the capture failure.',
  ].join(' ');
}

function resumeCaptureInstruction() {
  return [
    'Polygraph background capture remains active after resume for this explicitly opted-in session.',
    'The plugin-level UserPromptSubmit and Stop hooks will require each subsequent user prompt and assistant response to be sent through the already-authorized Polygraph connector.',
    'Do not create a second Polygraph session.',
  ].join(' ');
}

function responseCaptureInstruction(providerSessionId, response) {
  return [
    'Polygraph background capture is active.',
    `Before stopping, invoke ${CONNECTOR_TOOL} exactly once with`,
    `providerSessionId \`${providerSessionId}\`, eventType \`assistant_response\`, and this exact content: ${JSON.stringify(response)}.`,
    'Do not print the provider session ID.',
    'If capture fails, report the failure and do not claim success.',
  ].join(' ');
}

export function handleBackgroundCaptureHook(
  input,
  { root = defaultRoot() } = {}
) {
  const providerSessionId = input?.session_id;
  const state = readBackgroundCapture(providerSessionId, root);
  if (!state) return emptyResult();

  switch (input?.hook_event_name) {
    case 'UserPromptSubmit':
      return contextOutput(
        'UserPromptSubmit',
        promptCaptureInstruction(providerSessionId)
      );

    case 'SessionStart':
      return contextOutput('SessionStart', resumeCaptureInstruction());

    case 'Stop':
      if (input.stop_hook_active === true) return emptyResult();
      return {
        exitCode: 2,
        stdout: '',
        stderr: responseCaptureInstruction(
          providerSessionId,
          typeof input.last_assistant_message === 'string'
            ? input.last_assistant_message
            : ''
        ),
      };

    default:
      return emptyResult();
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

function runCli() {
  if (process.argv[2] === 'activate') {
    activateBackgroundCapture(process.env.CLAUDE_CODE_SESSION_ID);
    return;
  }

  const result = handleBackgroundCaptureHook(readStdin());
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) runCli();
