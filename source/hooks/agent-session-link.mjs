import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK_LOG_MAX_BYTES = 5 * 1024 * 1024;

const AGENT_TYPES = new Set(['claude', 'codex', 'opencode', 'grok']);
const COMMAND_HOOK_TOOL = /^mcp__(?:plugin_polygraph_)?polygraph[-_]mcp__/;
// OpenCode and Grok both name MCP tools without Claude's `mcp__` prefix:
// OpenCode as `polygraph_<tool>`, Grok as `<server>__<tool>` (so
// `polygraph-mcp__spawn_agent`). One pattern covers both.
const BARE_PREFIX_TOOL = /^polygraph(?:(?:-|_)mcp)?_/;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Grok's hook stdin envelope is camelCase throughout where Claude and Codex
 * use snake_case (`sessionId` vs `session_id`, `hookEventName` vs
 * `hook_event_name`, `toolName` vs `tool_name`). Normalizing once at the
 * boundary keeps every downstream reader on the snake_case names instead of
 * spreading `a ?? b` pairs through the hook logic. Snake_case wins when both
 * are present, so a harness that already speaks it is untouched.
 */
export function normalizeHookPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  return {
    ...payload,
    session_id: payload.session_id ?? payload.sessionId,
    hook_event_name: payload.hook_event_name ?? payload.hookEventName,
    tool_name: payload.tool_name ?? payload.toolName,
    transcript_path: payload.transcript_path ?? payload.transcriptPath,
  };
}

function isManagedChildEnvironment(env) {
  return Boolean(env && Object.hasOwn(env, 'POLYGRAPH_CHILD_AGENT'));
}

export function isPolygraphMcpToolName(toolName) {
  const name = nonEmptyString(toolName);
  return Boolean(name && (COMMAND_HOOK_TOOL.test(name) || BARE_PREFIX_TOOL.test(name)));
}

export function buildLinkAgentSessionArgs({
  polygraphSessionId,
  agentType,
  agentSessionId,
  cwd,
  transcriptPath,
  pid,
  source,
}) {
  const session = nonEmptyString(polygraphSessionId);
  const harnessSession = nonEmptyString(agentSessionId);
  const claimSource = nonEmptyString(source);
  if (!AGENT_TYPES.has(agentType)) throw new Error(`Unsupported agent type: ${agentType}`);
  if (!harnessSession) throw new Error('agentSessionId is required');
  if (!claimSource) throw new Error('source is required');

  const args = ['_link-agent-session'];
  if (session) args.push('--session', session);
  args.push('--agent-type', agentType, '--agent-session-id', harnessSession);

  const workingDirectory = nonEmptyString(cwd);
  if (workingDirectory) args.push('--cwd', workingDirectory);

  const transcript = nonEmptyString(transcriptPath);
  if (transcript) args.push('--transcript-path', transcript);

  if (Number.isSafeInteger(pid) && pid > 0) {
    args.push('--pid', String(pid));
  }

  args.push('--source', claimSource);
  return args;
}

export function linkAgentSession(claim, spawn = spawnSync, env = process.env) {
  if (isManagedChildEnvironment(env)) return false;

  const args = buildLinkAgentSessionArgs(claim);
  const command = nonEmptyString(env?.POLYGRAPH_CLI) ?? 'polygraph';
  const commandEnv = nonEmptyString(claim.polygraphSessionId) ? env : { ...env };
  if (commandEnv !== env) {
    delete commandEnv.POLYGRAPH_SESSION_ID;
    delete commandEnv.POLYGRAPH_CAPTURE_TOKEN;
  }

  const result = spawn(command, args, {
    encoding: 'utf8',
    env: commandEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    const detail = nonEmptyString(result?.stderr);
    throw new Error(
      `polygraph _link-agent-session exited with status ${String(result?.status)}` +
        (detail ? `: ${detail}` : '')
    );
  }

  return true;
}

export function buildCommandHookLink(rawPayload, agentType, env = process.env) {
  if (!rawPayload || typeof rawPayload !== 'object') return undefined;
  if (isManagedChildEnvironment(env)) return undefined;

  const payload = normalizeHookPayload(rawPayload);
  const agentSessionId = nonEmptyString(payload.session_id);
  if (!agentSessionId) return undefined;

  const common = {
    agentType,
    agentSessionId,
    cwd: nonEmptyString(payload.cwd),
    transcriptPath: nonEmptyString(payload.transcript_path),
    source: 'hook',
  };

  if (payload.hook_event_name === 'SessionStart') {
    const polygraphSessionId = nonEmptyString(env.POLYGRAPH_SESSION_ID);
    if (polygraphSessionId) return { ...common, polygraphSessionId };

    // Ordinary sessions of every supported harness are eligible for
    // speculative capture, so later session searches can find them even when
    // the session was not launched with Polygraph session evidence.
    return AGENT_TYPES.has(agentType) ? common : undefined;
  }

  if (payload.hook_event_name === 'PostToolUse') {
    return isPolygraphMcpToolName(payload.tool_name) ? common : undefined;
  }

  return undefined;
}

export function logHookFailure(
  hook,
  error,
  meta = {},
  home = process.env.HOME?.trim() || homedir()
) {
  try {
    const logsDir = join(home, '.polygraph', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, 'hooks.log');

    try {
      if (statSync(logFile).size > HOOK_LOG_MAX_BYTES) {
        renameSync(logFile, `${logFile}.1`);
      }
    } catch {
      // There may be no prior log, and logging must stay best-effort.
    }

    const entry = {
      time: new Date().toISOString(),
      hook,
      pid: process.pid,
      ...meta,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    };
    appendFileSync(logFile, JSON.stringify(entry) + '\n');
  } catch {
    // Hook diagnostics must never break the harness event that triggered them.
  }
}
