#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONNECTOR_TOOL =
  'mcp__polygraph-oauth-spike__background_capture_event';
const CAPTURE_HOOK_PATH = '/hooks/capture/pch_';

function captureHook(captureHookUrl) {
  return {
    hooks: [
      {
        type: 'http',
        url: captureHookUrl,
        timeout: 30,
      },
    ],
  };
}

const DIRECT_CAPTURE_EVENTS = [
  'UserPromptSubmit',
  'Stop',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'InstructionsLoaded',
  'UserPromptExpansion',
  'PermissionRequest',
  'PermissionDenied',
  'ConfigChange',
  'SubagentStart',
  'SubagentStop',
  'PostCompact',
  'StopFailure',
  'SessionStart',
  'SessionEnd',
  'CwdChanged',
  'TaskCreated',
  'TaskCompleted',
  'TeammateIdle',
];

function directCaptureHooks(captureHookUrl) {
  return Object.fromEntries(
    DIRECT_CAPTURE_EVENTS.map((eventName) => [
      eventName,
      captureHook(captureHookUrl),
    ])
  );
}

function defaultRoot() {
  return join(homedir(), '.polygraph');
}

function defaultProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function defaultSettingsPath(projectDir = defaultProjectDir()) {
  return join(projectDir, '.claude', 'settings.local.json');
}

function gitMetadataDir(projectDir) {
  const dotGitPath = join(projectDir, '.git');
  if (!existsSync(dotGitPath)) return null;
  if (statSync(dotGitPath).isDirectory()) return dotGitPath;

  const pointer = readFileSync(dotGitPath, 'utf8').trim();
  const match = /^gitdir:\s*(.+)$/i.exec(pointer);
  return match ? resolve(projectDir, match[1]) : null;
}

function ensureLocalSettingsIgnored(projectDir, settingsPath) {
  if (resolve(settingsPath) !== resolve(defaultSettingsPath(projectDir))) return;
  const gitDir = gitMetadataDir(projectDir);
  if (!gitDir) return;

  const excludePath = join(gitDir, 'info', 'exclude');
  const ignoreRule = '/.claude/settings.local.json';
  const existing = existsSync(excludePath)
    ? readFileSync(excludePath, 'utf8')
    : '';
  if (existing.split(/\r?\n/).includes(ignoreRule)) return;

  mkdirSync(dirname(excludePath), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(excludePath, `${existing}${prefix}${ignoreRule}\n`, 'utf8');
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

function safeCaptureHookUrl(captureHookUrl) {
  let parsed;
  try {
    parsed = new URL(captureHookUrl);
  } catch {
    throw new Error('Invalid Polygraph capture hook URL.');
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.pathname.startsWith(CAPTURE_HOOK_PATH) ||
    parsed.search ||
    parsed.hash ||
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

export function activateBackgroundCapture(
  providerSessionId,
  captureHookUrl,
  {
    root = defaultRoot(),
    now = Date.now(),
    projectDir = defaultProjectDir(),
    settingsPath = defaultSettingsPath(projectDir),
  } = {}
) {
  providerSessionId = safeProviderSessionId(providerSessionId);
  captureHookUrl = safeCaptureHookUrl(captureHookUrl);
  ensureLocalSettingsIgnored(projectDir, settingsPath);
  installDirectCaptureHooks(settingsPath, captureHookUrl);
  const path = markerPath(providerSessionId, root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const state = {
    version: 3,
    provider: 'claude',
    providerSessionId,
    activatedAt: now,
    captureMode: 'native-http-hooks',
    settingsPath,
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

function readJsonObject(path) {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${path} to contain a JSON object.`);
  }
  return value;
}

function writeJsonAtomically(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
}

function isOwnedCaptureHookUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return false;
  try {
    return new URL(url).pathname.startsWith(CAPTURE_HOOK_PATH);
  } catch {
    return false;
  }
}

function isOwnedCaptureHook(group) {
  return group?.hooks?.some(
    (hook) =>
      hook?.type === 'http' &&
      isOwnedCaptureHookUrl(hook.url)
  );
}

export function installDirectCaptureHooks(settingsPath, captureHookUrl) {
  const settings = readJsonObject(settingsPath);
  const hooks =
    settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const [eventName, ownedGroup] of Object.entries(
    directCaptureHooks(safeCaptureHookUrl(captureHookUrl))
  )) {
    const existing = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
    hooks[eventName] = [
      ...existing.filter((group) => !isOwnedCaptureHook(group)),
      ownedGroup,
    ];
  }
  settings.hooks = hooks;
  writeJsonAtomically(settingsPath, settings);
}

export function removeDirectCaptureHooks(settingsPath) {
  if (!existsSync(settingsPath)) return;
  const settings = readJsonObject(settingsPath);
  const hooks =
    settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const eventName of DIRECT_CAPTURE_EVENTS) {
    if (!Array.isArray(hooks[eventName])) continue;
    const remaining = hooks[eventName].filter(
      (group) => !isOwnedCaptureHook(group)
    );
    if (remaining.length > 0) hooks[eventName] = remaining;
    else delete hooks[eventName];
  }
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;
  writeJsonAtomically(settingsPath, settings);
}

export function deactivateBackgroundCapture(
  providerSessionId,
  { root = defaultRoot(), settingsPath } = {}
) {
  const state = readBackgroundCapture(providerSessionId, root);
  const resolvedSettingsPath =
    settingsPath ??
    state?.settingsPath ??
    defaultSettingsPath();
  removeDirectCaptureHooks(resolvedSettingsPath);
  rmSync(markerPath(providerSessionId, root), { force: true });
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
      ![1, 2, 3].includes(state?.version) ||
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
    `providerSessionId \`${providerSessionId}\`, eventType \`assistant_response\`, and content equal to the text between the capture markers below, preserving its actual line breaks.`,
    '<polygraph-capture-content>',
    response,
    '</polygraph-capture-content>',
    'The capture markers are not part of the content.',
    'Do not print the provider session ID.',
    'If capture fails, report the failure and do not claim success.',
  ].join('\n');
}

export function handleBackgroundCaptureHook(
  input,
  { root = defaultRoot() } = {}
) {
  const providerSessionId = input?.session_id;
  const state = readBackgroundCapture(providerSessionId, root);
  if (!state) return emptyResult();
  if (state.version >= 2) return emptyResult();

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
    activateBackgroundCapture(
      process.env.CLAUDE_CODE_SESSION_ID,
      process.argv[3]
    );
    return;
  }
  if (process.argv[2] === 'deactivate') {
    deactivateBackgroundCapture(process.env.CLAUDE_CODE_SESSION_ID);
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
