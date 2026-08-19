import { spawnSync } from 'node:child_process';

import { normalizeHookPayload } from './agent-session-link.mjs';

// Harnesses that fire a session-teardown event carrying their own session id.
// Codex and OpenCode ship no SessionEnd hook, so they never finalize here.
const FINALIZE_AGENT_TYPES = new Set(['claude', 'grok']);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isManagedChildEnvironment(env) {
  return Boolean(env && Object.hasOwn(env, 'POLYGRAPH_CHILD_AGENT'));
}

export function buildFinalizeAgentSessionArgs({
  agentType,
  agentSessionId,
  cwd,
  transcriptPath,
  source,
}) {
  const harnessSession = nonEmptyString(agentSessionId);
  const hookSource = nonEmptyString(source);
  if (!FINALIZE_AGENT_TYPES.has(agentType)) {
    throw new Error(`Unsupported agent type: ${agentType}`);
  }
  if (!harnessSession) throw new Error('agentSessionId is required');
  if (!hookSource) throw new Error('source is required');

  const args = [
    '_finalize-agent-session',
    '--agent-type',
    agentType,
    '--agent-session-id',
    harnessSession,
  ];

  const workingDirectory = nonEmptyString(cwd);
  if (workingDirectory) args.push('--cwd', workingDirectory);

  const transcript = nonEmptyString(transcriptPath);
  if (transcript) args.push('--transcript-path', transcript);

  args.push('--source', hookSource);
  return args;
}

export function finalizeAgentSession(claim, spawn = spawnSync, env = process.env) {
  if (isManagedChildEnvironment(env)) return false;

  const command = nonEmptyString(env?.POLYGRAPH_CLI) ?? 'polygraph';
  const commandEnv = { ...env };
  delete commandEnv.POLYGRAPH_SESSION_ID;
  delete commandEnv.POLYGRAPH_CAPTURE_TOKEN;

  const result = spawn(command, buildFinalizeAgentSessionArgs(claim), {
    encoding: 'utf8',
    env: commandEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    const detail = nonEmptyString(result?.stderr);
    throw new Error(
      `polygraph _finalize-agent-session exited with status ${String(result?.status)}` +
        (detail ? `: ${detail}` : '')
    );
  }

  return true;
}

export function buildCommandHookFinalize(rawPayload, agentType, env = process.env) {
  if (!rawPayload || typeof rawPayload !== 'object') return undefined;
  if (isManagedChildEnvironment(env)) return undefined;

  const payload = normalizeHookPayload(rawPayload);
  if (
    !FINALIZE_AGENT_TYPES.has(agentType) ||
    payload.hook_event_name !== 'SessionEnd'
  ) {
    return undefined;
  }

  const agentSessionId = nonEmptyString(payload.session_id);
  if (!agentSessionId) return undefined;

  return {
    agentType,
    agentSessionId,
    cwd: nonEmptyString(payload.cwd),
    transcriptPath: nonEmptyString(payload.transcript_path),
    source: 'hook',
  };
}
