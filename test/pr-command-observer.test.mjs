import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

import { observePrCommand } from '../source/hooks/pr-command-observer.mjs';
import { activateBackgroundCapture } from '../source/hooks/background-capture-lifecycle.mjs';

const PROVIDER_SESSION_ID = '88b2ff2e-b146-458c-85fc-109c7bc12f26';
const CAPTURE_HOOK_URL =
  'https://polygraph.example.test/hooks/capture/pch_abcdefghijklmnopqrstuvwxyz123456';
const DETACHED_HEAD_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'polygraph-command-observer-'));
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
    home: root,
    transcriptPath,
    hookLogPath: join(root, '.polygraph', 'logs', 'hooks.log'),
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

function makeRepo(headContent) {
  const repoDir = mkdtempSync(join(tmpdir(), 'polygraph-command-repo-'));
  mkdirSync(join(repoDir, '.git'));
  writeFileSync(join(repoDir, '.git', 'HEAD'), headContent);
  return repoDir;
}

function hashOf(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// Fixture shapes match Claude Code's real PostToolUse `tool_response`
// contract (decompiled from installed CLI bundles, cross-checked against the
// hooks docs statement that PostToolUse fires only on tool success): Bash is
// {stdout, stderr, interrupted, ...} with no exit-code field; an MCP tool's
// tool_response is the bare content itself — an array of content blocks
// ([{type, text}, ...]) or a bare string, never an object with a nested
// `.content` property. There is no `.isError` field on that bare shape at
// all (a failed call never reaches PostToolUse). `mcpWrappedInput` builds the
// object-wrapped {content, isError?} shape, used only to exercise the
// forward-compat tolerance path — not the verified real contract.
function bashInput({ command, stdout = '', stderr = '', interrupted = false, cwd }) {
  return {
    session_id: PROVIDER_SESSION_ID,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout, stderr, interrupted },
    cwd,
  };
}

// Bare array of content blocks — the real, verified MCP tool_response shape.
function mcpInput({ toolName, blocks, text, cwd }) {
  const content = blocks ?? (typeof text === 'string' ? [{ type: 'text', text }] : []);
  return {
    session_id: PROVIDER_SESSION_ID,
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: {},
    tool_response: content,
    cwd,
  };
}

// Bare string — the other real, verified MCP tool_response shape.
function mcpStringInput({ toolName, text, cwd }) {
  return {
    session_id: PROVIDER_SESSION_ID,
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: {},
    tool_response: text,
    cwd,
  };
}

// Object-wrapped {content, isError?} — NOT the verified real contract;
// exercises only the forward-compat tolerance path some harness versions may
// need.
function mcpWrappedInput({ toolName, text, isError = false, cwd }) {
  return {
    session_id: PROVIDER_SESSION_ID,
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: {},
    tool_response: {
      content: typeof text === 'string' ? [{ type: 'text', text }] : [],
      isError,
    },
    cwd,
  };
}

async function collectPosts(f, input) {
  const posts = [];
  const result = await observePrCommand(input, {
    root: f.root,
    home: f.home,
    fetchImpl: async (url, request) => {
      posts.push({ url, body: JSON.parse(request.body) });
      return { ok: true };
    },
  });
  return { result, posts };
}

// ---------------------------------------------------------------------------
// Marker gating
// ---------------------------------------------------------------------------

test('without an active marker, invocation is a silent local no-op', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/main\n');
  try {
    const input = bashInput({
      command: 'gh pr create --title "Add feature" --body "desc"',
      stdout: 'https://github.com/nrwl/ocean/pull/42\n',
      cwd: repo,
    });
    const { result, posts } = await collectPosts(f, input);
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(posts.length, 0);
    assert.equal(existsSync(join(f.root, 'background-capture')), false);
    assert.equal(existsSync(f.hookLogPath), false);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an invalid provider session id is a silent no-op', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/main\n');
  try {
    const input = bashInput({
      command: 'gh pr create',
      stdout: 'https://github.com/nrwl/ocean/pull/42\n',
      cwd: repo,
    });
    input.session_id = 'not a valid id';
    const { result, posts } = await collectPosts(f, input);
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(posts.length, 0);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// gh pr create
// ---------------------------------------------------------------------------

test('gh pr create success with a PR URL in output reports pr_created with prUrl and branch', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const stdout =
      'Creating pull request for feature/x into main in nrwl/ocean\nhttps://github.com/nrwl/ocean/pull/42\n';
    const input = bashInput({
      command: 'gh pr create --title "Add feature" --body "desc"',
      stdout,
      cwd: repo,
    });
    const { result, posts } = await collectPosts(f, input);
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `${CAPTURE_HOOK_URL}/pr`);
    assert.deepEqual(posts[0].body, {
      providerSessionId: PROVIDER_SESSION_ID,
      kind: 'pr_created',
      prUrl: 'https://github.com/nrwl/ocean/pull/42',
      branch: 'feature/x',
      eventId: `pr_created:https://github.com/nrwl/ocean/pull/42:${hashOf(stdout)}`,
    });
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('gh pr create success without a URL in output falls back to branch_active', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const stdout = 'Pull request creation queued\n';
    const input = bashInput({
      command: 'gh pr create --fill',
      stdout,
      cwd: repo,
    });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, {
      providerSessionId: PROVIDER_SESSION_ID,
      kind: 'branch_active',
      branch: 'feature/x',
      eventId: `branch_active:feature/x:${hashOf(stdout)}`,
    });
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('gh pr create with an interrupted tool_response produces no event', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const input = bashInput({
      command: 'gh pr create --title "Add feature"',
      stdout: '',
      stderr: 'error: a pull request for branch "feature/x" already exists',
      interrupted: true,
      cwd: repo,
    });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 0);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a Bash tool call with no tool_response produces no event', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const input = {
      session_id: PROVIDER_SESSION_ID,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title "Add feature"' },
      cwd: repo,
    };
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 0);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// gh pr ready / gh pr edit
// ---------------------------------------------------------------------------

test('gh pr ready with a URL in output reports pr_ready with prUrl', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const stdout = 'https://github.com/nrwl/ocean/pull/42 is marked as ready\n';
    const input = bashInput({ command: 'gh pr ready 42', stdout, cwd: repo });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, {
      providerSessionId: PROVIDER_SESSION_ID,
      kind: 'pr_ready',
      prUrl: 'https://github.com/nrwl/ocean/pull/42',
      branch: 'feature/x',
      eventId: `pr_ready:https://github.com/nrwl/ocean/pull/42:${hashOf(stdout)}`,
    });
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('gh pr ready without a URL falls back to prNumber from the first positional argument', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const stdout = '\n';
    const input = bashInput({ command: 'gh pr ready 42', stdout, cwd: repo });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, {
      providerSessionId: PROVIDER_SESSION_ID,
      kind: 'pr_ready',
      prNumber: 42,
      branch: 'feature/x',
      eventId: `pr_ready:feature/x:${hashOf(stdout)}`,
    });
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('gh pr ready with a resolvable prNumber but no resolvable branch uses the prNumber as the eventId identity', async () => {
  const f = fixture();
  const repo = makeRepo(`${DETACHED_HEAD_SHA}\n`);
  try {
    await activate(f);
    const stdout = '\n';
    const input = bashInput({ command: 'gh pr ready 42', stdout, cwd: repo });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, {
      providerSessionId: PROVIDER_SESSION_ID,
      kind: 'pr_ready',
      prNumber: 42,
      eventId: `pr_ready:pr#42:${hashOf(stdout)}`,
    });
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('gh pr edit without a URL or numeric positional falls back to branch_active', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const stdout = 'Edited pull request\n';
    const input = bashInput({
      command: 'gh pr edit --add-label needs-review',
      stdout,
      cwd: repo,
    });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, {
      providerSessionId: PROVIDER_SESSION_ID,
      kind: 'branch_active',
      branch: 'feature/x',
      eventId: `branch_active:feature/x:${hashOf(stdout)}`,
    });
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('gh pr edit with a URL in output reports pr_updated', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const stdout = 'https://github.com/nrwl/ocean/pull/7 updated\n';
    const input = bashInput({
      command: 'gh pr edit 7 --add-label needs-review',
      stdout,
      cwd: repo,
    });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.kind, 'pr_updated');
    assert.equal(posts[0].body.prUrl, 'https://github.com/nrwl/ocean/pull/7');
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// git push
// ---------------------------------------------------------------------------

test('git push success reports branch_pushed with the current branch', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const stdout = '';
    const stderr =
      'To github.com:nrwl/ocean.git\n   1234567..89abcde  feature/x -> feature/x\n';
    const input = bashInput({
      command: 'git push',
      stdout,
      stderr,
      cwd: repo,
    });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, {
      providerSessionId: PROVIDER_SESSION_ID,
      kind: 'branch_pushed',
      branch: 'feature/x',
      eventId: `branch_pushed:feature/x:${hashOf(stdout + stderr)}`,
    });
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('git push with an interrupted tool_response produces no event', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const input = bashInput({
      command: 'git push',
      stderr: 'error: failed to push some refs',
      interrupted: true,
      cwd: repo,
    });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 0);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('git push with a detached HEAD produces no event', async () => {
  const f = fixture();
  const repo = makeRepo(`${DETACHED_HEAD_SHA}\n`);
  try {
    await activate(f);
    const input = bashInput({ command: 'git push', cwd: repo });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 0);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Compound / quoted / ambiguous commands resolve to no event
// ---------------------------------------------------------------------------

test('a quoted flag value alone does not disqualify a simple command', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const input = bashInput({
      command: 'gh pr create --title "Add a great feature" --body "See description"',
      stdout: 'https://github.com/nrwl/ocean/pull/1\n',
      cwd: repo,
    });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.kind, 'pr_created');
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

for (const [label, command] of [
  ['chained with &&', 'gh pr create --title x && echo done'],
  ['chained with ;', 'git push; rm -rf /'],
  ['piped', 'gh pr create --title x | cat'],
  ['redirected', 'gh pr create --title x > out.log'],
  ['backgrounded', 'git push &'],
  ['command substitution', 'gh pr create --title "$(whoami)"'],
  ['backticked substitution', 'gh pr create --title "`whoami`"'],
  ['multi-line', 'gh pr create --title x\necho done'],
]) {
  test(`compound/ambiguous command (${label}) resolves to no event`, async () => {
    const f = fixture();
    const repo = makeRepo('ref: refs/heads/feature/x\n');
    try {
      await activate(f);
      const input = bashInput({
        command,
        stdout: 'https://github.com/nrwl/ocean/pull/1\n',
        cwd: repo,
      });
      const { result, posts } = await collectPosts(f, input);
      assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
      assert.equal(posts.length, 0);
    } finally {
      f.cleanup();
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Non-matching tools and subcommands
// ---------------------------------------------------------------------------

test('an unrelated Bash command produces no event', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const input = bashInput({ command: 'npm test', stdout: 'ok', cwd: repo });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 0);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a non-Bash, non-matching-MCP tool produces no event', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const input = {
      session_id: PROVIDER_SESSION_ID,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/file.ts' },
      tool_response: { filePath: '/tmp/file.ts' },
      cwd: repo,
    };
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 0);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MCP create_pull_request tools
// ---------------------------------------------------------------------------

test('an MCP create_pull_request tool with a bare array response and a URL in a text block reports pr_created', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const text = 'Created https://github.com/nrwl/ocean/pull/99';
    const input = mcpInput({
      toolName: 'mcp__github__create_pull_request',
      text,
      cwd: repo,
    });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, {
      providerSessionId: PROVIDER_SESSION_ID,
      kind: 'pr_created',
      prUrl: 'https://github.com/nrwl/ocean/pull/99',
      branch: 'feature/x',
      eventId: `pr_created:https://github.com/nrwl/ocean/pull/99:${hashOf(text)}`,
    });
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an MCP create_pull_request tool with a bare string response reports pr_created', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const text = 'Created https://github.com/nrwl/ocean/pull/100';
    const input = mcpStringInput({
      toolName: 'mcp__github__create_pull_request',
      text,
      cwd: repo,
    });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, {
      providerSessionId: PROVIDER_SESSION_ID,
      kind: 'pr_created',
      prUrl: 'https://github.com/nrwl/ocean/pull/100',
      branch: 'feature/x',
      eventId: `pr_created:https://github.com/nrwl/ocean/pull/100:${hashOf(text)}`,
    });
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a bare array response with non-text blocks ignores those blocks', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const blocks = [
      { type: 'image', data: 'irrelevant-base64' },
      { type: 'text', text: 'Created https://github.com/nrwl/ocean/pull/101' },
    ];
    const input = mcpInput({
      toolName: 'mcp__github__create_pull_request',
      blocks,
      cwd: repo,
    });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.kind, 'pr_created');
    assert.equal(posts[0].body.prUrl, 'https://github.com/nrwl/ocean/pull/101');
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a bare array response with no isError field still reports an event', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const text = 'Pull request created';
    const input = mcpInput({
      toolName: 'mcp__polygraph_polygraph-mcp__create_pull_request',
      text,
      cwd: repo,
    });
    assert.equal(Object.hasOwn(input.tool_response, 'isError'), false);
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.kind, 'branch_active');
    assert.equal(posts[0].body.branch, 'feature/x');
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an MCP create_pull_request tool without a URL falls back to branch_active', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const text = 'Pull request created';
    const input = mcpInput({
      toolName: 'mcp__polygraph_polygraph-mcp__create_pull_request',
      text,
      cwd: repo,
    });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.kind, 'branch_active');
    assert.equal(posts[0].body.branch, 'feature/x');
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an MCP create_pull_request tool with an object-wrapped {content, isError: false} response is tolerated', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const text = 'Created https://github.com/nrwl/ocean/pull/102';
    const input = mcpWrappedInput({
      toolName: 'mcp__github__create_pull_request',
      text,
      isError: false,
      cwd: repo,
    });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.kind, 'pr_created');
    assert.equal(posts[0].body.prUrl, 'https://github.com/nrwl/ocean/pull/102');
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an MCP create_pull_request tool call that errored (object-wrapped isError: true) produces no event', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const input = mcpWrappedInput({
      toolName: 'mcp__github__create_pull_request',
      text: 'permission denied',
      isError: true,
      cwd: repo,
    });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 0);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an MCP tool call with no tool_response produces no event', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const input = {
      session_id: PROVIDER_SESSION_ID,
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__github__create_pull_request',
      tool_input: {},
      cwd: repo,
    };
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 0);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a non-matching MCP tool name produces no event', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const input = mcpInput({
      toolName: 'mcp__github__update_pull_request',
      text: 'https://github.com/nrwl/ocean/pull/1',
      cwd: repo,
    });
    const { posts } = await collectPosts(f, input);
    assert.equal(posts.length, 0);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Secret discipline and soft failure
// ---------------------------------------------------------------------------

test('a thrown network error is soft and logged without leaking the capture URL', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const input = bashInput({
      command: 'gh pr create',
      stdout: 'https://github.com/nrwl/ocean/pull/42\n',
      cwd: repo,
    });
    const result = await observePrCommand(input, {
      root: f.root,
      home: f.home,
      fetchImpl: async () => {
        throw new Error('network unreachable');
      },
    });
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });

    const entry = JSON.parse(readFileSync(f.hookLogPath, 'utf8').trim());
    assert.equal(entry.hook, 'pr-command-observer:reportCommand');
    assert.equal(entry.providerSessionId, PROVIDER_SESSION_ID);
    assert.match(entry.error, /network unreachable/);
    const logRaw = readFileSync(f.hookLogPath, 'utf8');
    assert.doesNotMatch(logRaw, /pch_/);
    assert.doesNotMatch(logRaw, /polygraph\.example\.test/);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an HTTP failure response is soft and logged', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const input = bashInput({
      command: 'git push',
      stderr: '',
      cwd: repo,
    });
    const result = await observePrCommand(input, {
      root: f.root,
      home: f.home,
      fetchImpl: async () => ({ ok: false, status: 500 }),
    });
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    const entry = JSON.parse(readFileSync(f.hookLogPath, 'utf8').trim());
    assert.equal(entry.hook, 'pr-command-observer:reportCommand');
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the result never leaks the capture URL even on success', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const input = bashInput({
      command: 'gh pr create',
      stdout: 'https://github.com/nrwl/ocean/pull/42\n',
      cwd: repo,
    });
    const { result } = await collectPosts(f, input);
    assert.doesNotMatch(JSON.stringify(result), /pch_/);
    assert.doesNotMatch(JSON.stringify(result), /polygraph\.example\.test/);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});
