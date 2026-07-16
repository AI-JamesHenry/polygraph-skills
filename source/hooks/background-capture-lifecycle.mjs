#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONNECTOR_TOOL =
  'mcp__polygraph-oauth-spike__background_capture_event';
const CONNECTOR_SERVER = 'polygraph-oauth-spike';
const CAPTURE_TOOL = 'background_capture_event';
const OWNED_HOOK_MARKER = 'polygraph-background-capture-v2';

function captureHook(input) {
  return {
    matcher: '',
    hooks: [
      {
        type: 'mcp_tool',
        server: CONNECTOR_SERVER,
        tool: CAPTURE_TOOL,
        input: {
          ...input,
          providerSessionId: '${session_id}',
          captureSource: OWNED_HOOK_MARKER,
        },
      },
    ],
  };
}

const DIRECT_CAPTURE_HOOKS = {
  UserPromptSubmit: captureHook({
    eventType: 'user_prompt',
    content: '${prompt}',
    eventId: 'prompt:${prompt_id}',
  }),
  MessageDisplay: captureHook({
    eventType: 'assistant_delta',
    content: '${delta}',
    eventId: 'message:${message_id}:${index}',
    messageId: '${message_id}',
    index: '${index}',
    final: '${final}',
  }),
  PreToolUse: captureHook({
    eventType: 'tool_use',
    content: '${tool_input}',
    eventId: 'tool-use:${tool_use_id}',
    toolName: '${tool_name}',
    toolUseId: '${tool_use_id}',
  }),
  PostToolUse: captureHook({
    eventType: 'tool_result',
    content: '${tool_response}',
    eventId: 'tool-result:${tool_use_id}',
    toolName: '${tool_name}',
    toolUseId: '${tool_use_id}',
    durationMs: '${duration_ms}',
  }),
  PostToolUseFailure: captureHook({
    eventType: 'tool_failure',
    content: '${error}',
    eventId: 'tool-failure:${tool_use_id}',
    toolName: '${tool_name}',
    toolUseId: '${tool_use_id}',
    durationMs: '${duration_ms}',
    detail: '${tool_input}',
  }),
  Notification: captureHook({
    eventType: 'event',
    content: '${message}',
    label: 'Notification: ${notification_type}',
    detail: '${title}',
  }),
  InstructionsLoaded: captureHook({
    eventType: 'skill_load',
    content: '${file_path}',
    eventId: 'instructions:${prompt_id}:${file_path}',
    label: '${memory_type}',
    detail: '${load_reason}',
  }),
  UserPromptExpansion: captureHook({
    eventType: 'skill_load',
    content: '${expanded_prompt}',
    eventId: 'expansion:${prompt_id}:${command}',
    label: '${command}',
  }),
  PermissionRequest: captureHook({
    eventType: 'event',
    content: '${tool_input}',
    eventId: 'permission-request:${tool_use_id}',
    label: 'Permission requested: ${tool_name}',
  }),
  PermissionDenied: captureHook({
    eventType: 'event',
    content: '${tool_input}',
    eventId: 'permission-denied:${tool_use_id}',
    label: 'Permission denied: ${tool_name}',
  }),
  ConfigChange: captureHook({
    eventType: 'event',
    content: '${source}',
    label: 'Configuration changed',
    detail: '${file_path}',
  }),
  SubagentStart: captureHook({
    eventType: 'event',
    content: '${agent_type}',
    eventId: 'subagent-start:${agent_id}',
    label: 'Subagent started',
    detail: '${agent_id}',
  }),
  SubagentStop: captureHook({
    eventType: 'task_notification',
    content: '${last_assistant_message}',
    eventId: 'subagent-stop:${agent_id}',
    label: '${agent_type}',
    detail: '${agent_id}',
  }),
  PostCompact: captureHook({
    eventType: 'event',
    content: '${summary}',
    eventId: 'compact:${prompt_id}',
    label: 'Context compacted',
  }),
  StopFailure: captureHook({
    eventType: 'event',
    content: '${error}',
    eventId: 'stop-failure:${prompt_id}',
    label: 'Assistant stop failed',
  }),
};

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
  {
    root = defaultRoot(),
    now = Date.now(),
    settingsPath = join(homedir(), '.claude', 'settings.json'),
  } = {}
) {
  providerSessionId = safeProviderSessionId(providerSessionId);
  installDirectCaptureHooks(settingsPath);
  const path = markerPath(providerSessionId, root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const state = {
    version: 2,
    provider: 'claude',
    providerSessionId,
    activatedAt: now,
    captureMode: 'native-mcp-hooks',
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

function isOwnedCaptureHook(group) {
  return group?.hooks?.some(
    (hook) =>
      hook?.type === 'mcp_tool' &&
      hook?.server === CONNECTOR_SERVER &&
      hook?.tool === CAPTURE_TOOL &&
      hook?.input?.captureSource === OWNED_HOOK_MARKER
  );
}

export function installDirectCaptureHooks(settingsPath) {
  const settings = readJsonObject(settingsPath);
  const hooks =
    settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const [eventName, ownedGroup] of Object.entries(DIRECT_CAPTURE_HOOKS)) {
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
  for (const eventName of Object.keys(DIRECT_CAPTURE_HOOKS)) {
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
    join(homedir(), '.claude', 'settings.json');
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
      ![1, 2].includes(state?.version) ||
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
  if (state.version === 2) return emptyResult();

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
