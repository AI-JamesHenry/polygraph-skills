import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enforceDraftPr } from '../source/hooks/pr-draft-enforcement.mjs';
import { activateBackgroundCapture } from '../source/hooks/background-capture-lifecycle.mjs';

const PROVIDER_SESSION_ID = '88b2ff2e-b146-458c-85fc-109c7bc12f26';
const CAPTURE_HOOK_URL =
  'https://polygraph.example.test/hooks/capture/pch_abcdefghijklmnopqrstuvwxyz123456';
const DENY_REASON =
  'Polygraph cloud sessions create draft PRs. Re-run gh pr create as a single stand-alone command (no shell operators) with --draft.';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'polygraph-draft-enforcement-'));
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

function bashInput(command) {
  return {
    session_id: PROVIDER_SESSION_ID,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  };
}

function mcpInput(toolName, toolInput) {
  return {
    session_id: PROVIDER_SESSION_ID,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
  };
}

function allowOutput(result, updatedInput) {
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    },
  });
}

function denyOutput(result) {
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: DENY_REASON,
    },
  });
}

function noOutput(result) {
  assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
}

// ---------------------------------------------------------------------------
// Marker gating
// ---------------------------------------------------------------------------

test('without an active marker, a bare gh pr create is a silent no-op', async () => {
  const f = fixture();
  try {
    const result = await enforceDraftPr(
      bashInput('gh pr create --title "Add feature" --body "desc"'),
      { root: f.root, home: f.home }
    );
    noOutput(result);
    assert.equal(existsSync(f.hookLogPath), false);
  } finally {
    f.cleanup();
  }
});

test('without an active marker, a compound gh pr create is also a silent no-op', async () => {
  const f = fixture();
  try {
    const result = await enforceDraftPr(
      bashInput('gh pr create --title x && echo done'),
      { root: f.root, home: f.home }
    );
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

test('an invalid provider session id is a silent no-op', async () => {
  const f = fixture();
  try {
    const input = bashInput('gh pr create');
    input.session_id = 'not a valid id';
    const result = await enforceDraftPr(input, { root: f.root, home: f.home });
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Bash: simple gh pr create rewrite
// ---------------------------------------------------------------------------

test('a simple gh pr create with no draft flag gets --draft appended right after create', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await enforceDraftPr(bashInput('gh pr create'), {
      root: f.root,
      home: f.home,
    });
    allowOutput(result, { command: 'gh pr create --draft' });
  } finally {
    f.cleanup();
  }
});

test('--title/--body and their values (including quoting) are preserved byte-for-byte', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command =
      'gh pr create --title "Add a great feature" --body "See full description here"';
    const result = await enforceDraftPr(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    allowOutput(result, {
      command:
        'gh pr create --draft --title "Add a great feature" --body "See full description here"',
    });
  } finally {
    f.cleanup();
  }
});

test('--draft already present passes through untouched', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await enforceDraftPr(
      bashInput('gh pr create --title x --draft'),
      { root: f.root, home: f.home }
    );
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

test('-d already present passes through untouched', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await enforceDraftPr(bashInput('gh pr create -d'), {
      root: f.root,
      home: f.home,
    });
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

test('-d present among other flags passes through untouched', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await enforceDraftPr(
      bashInput('gh pr create --title x -d --body y'),
      { root: f.root, home: f.home }
    );
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

test('leading/trailing whitespace in the command is tolerated (and trimmed)', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await enforceDraftPr(
      bashInput('  gh pr create --title x  '),
      { root: f.root, home: f.home }
    );
    allowOutput(result, { command: 'gh pr create --draft --title x' });
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Bash: compound / ambiguous gh pr create denies
// ---------------------------------------------------------------------------

for (const [label, command] of [
  ['chained with &&', 'gh pr create --title x && echo done'],
  ['chained with ;', 'gh pr create --title x; echo done'],
  ['chained with ||', 'gh pr create --title x || echo failed'],
  ['piped', 'gh pr create --title x | cat'],
  ['redirected', 'gh pr create --title x > out.log'],
  ['backgrounded', 'gh pr create --title x &'],
  ['command substitution', 'gh pr create --title "$(whoami)"'],
  ['backticked substitution', 'gh pr create --title "`whoami`"'],
  ['multi-line', 'gh pr create --title x\necho done'],
  ['prefixed by another command', 'cd repo && gh pr create --title x'],
]) {
  test(`compound/ambiguous gh pr create (${label}) is denied`, async () => {
    const f = fixture();
    try {
      await activate(f);
      const result = await enforceDraftPr(bashInput(command), {
        root: f.root,
        home: f.home,
      });
      denyOutput(result);
    } finally {
      f.cleanup();
    }
  });
}

test('a compound command with no gh pr create at all is a silent no-op', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await enforceDraftPr(
      bashInput('npm test && npm run build'),
      { root: f.root, home: f.home }
    );
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Bash: non-matching commands are untouched
// ---------------------------------------------------------------------------

test('an unrelated Bash command produces no output', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await enforceDraftPr(bashInput('npm test'), {
      root: f.root,
      home: f.home,
    });
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

test('gh pr ready / gh pr edit / git push are left alone (not gh pr create)', async () => {
  const f = fixture();
  try {
    await activate(f);
    for (const command of ['gh pr ready 42', 'gh pr edit 7', 'git push']) {
      const result = await enforceDraftPr(bashInput(command), {
        root: f.root,
        home: f.home,
      });
      noOutput(result);
    }
  } finally {
    f.cleanup();
  }
});

test('a non-string tool_input.command produces no output', async () => {
  const f = fixture();
  try {
    await activate(f);
    const input = {
      session_id: PROVIDER_SESSION_ID,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {},
    };
    const result = await enforceDraftPr(input, { root: f.root, home: f.home });
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Bash: quoted flag-lookalikes and operators (fail-closed round 1)
// ---------------------------------------------------------------------------

test('a quoted --draft lookalike in --title is not mistaken for the real flag, and gets rewritten', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --title "add --draft support"';
    const result = await enforceDraftPr(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    allowOutput(result, {
      command: 'gh pr create --draft --title "add --draft support"',
    });
  } finally {
    f.cleanup();
  }
});

test('a quoted -d lookalike in --body is not mistaken for the real flag, and gets rewritten', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --body "we use the -d flag by convention"';
    const result = await enforceDraftPr(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    allowOutput(result, {
      command:
        'gh pr create --draft --body "we use the -d flag by convention"',
    });
  } finally {
    f.cleanup();
  }
});

test('a quoted && inside --body is not treated as a compound operator, and gets rewritten with quoting intact byte-for-byte', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --body "a && b"';
    const result = await enforceDraftPr(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    allowOutput(result, { command: 'gh pr create --draft --body "a && b"' });
  } finally {
    f.cleanup();
  }
});

test('a $( ) command substitution inside double quotes still executes there, so it is denied', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --body "run $(x)"';
    const result = await enforceDraftPr(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result);
  } finally {
    f.cleanup();
  }
});

test('an unbalanced quote is ambiguous and denied rather than silently passed through', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --title "unterminated';
    const result = await enforceDraftPr(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Bash: backslash-escaped quotes (fail-closed round 2)
// ---------------------------------------------------------------------------

test('a draft-flag-shaped substring behind an escaped quote inside --title is not exposed, and gets rewritten', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command =
      'gh pr create --title "she said \\"add --draft support\\" today"';
    const result = await enforceDraftPr(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    allowOutput(result, {
      command:
        'gh pr create --draft --title "she said \\"add --draft support\\" today"',
    });
  } finally {
    f.cleanup();
  }
});

test('an && hidden behind an escaped quote inside --body is still tracked as inside the quoted span, and gets rewritten', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --body "escaped \\" then && here"';
    const result = await enforceDraftPr(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    allowOutput(result, {
      command: 'gh pr create --draft --body "escaped \\" then && here"',
    });
  } finally {
    f.cleanup();
  }
});

test('a double backslash before the closing quote is a literal backslash, and the quote genuinely closes', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --title "ends with backslash\\\\"';
    const result = await enforceDraftPr(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    allowOutput(result, {
      command: 'gh pr create --draft --title "ends with backslash\\\\"',
    });
  } finally {
    f.cleanup();
  }
});

test('a command ending in a lone trailing backslash is ambiguous and denied', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --title x \\';
    const result = await enforceDraftPr(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result);
  } finally {
    f.cleanup();
  }
});

test('an apostrophe inside a double-quoted value does not toggle single-quote state, and gets rewritten', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --title "it\'s a great feature"';
    const result = await enforceDraftPr(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    allowOutput(result, {
      command: 'gh pr create --draft --title "it\'s a great feature"',
    });
  } finally {
    f.cleanup();
  }
});

test('a double quote inside a single-quoted value does not toggle double-quote state, and gets rewritten', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = "gh pr create --title 'she said \"hi\"'";
    const result = await enforceDraftPr(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    allowOutput(result, {
      command: "gh pr create --draft --title 'she said \"hi\"'",
    });
  } finally {
    f.cleanup();
  }
});

test('an escaped quote outside all quoting does not open a quote, and never resolves to silence', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --title foo\\"bar';
    const result = await enforceDraftPr(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    // Whatever the scanner resolves this to, it must never be silence: a
    // real, unambiguous `gh pr create` token sequence is present.
    assert.notDeepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    const parsed = JSON.parse(result.stdout);
    const decision = parsed.hookSpecificOutput.permissionDecision;
    assert.ok(
      decision === 'allow' || decision === 'deny',
      `expected allow or deny, got ${decision}`
    );
    if (decision === 'allow') {
      assert.equal(
        parsed.hookSpecificOutput.updatedInput.command,
        'gh pr create --draft --title foo\\"bar'
      );
    }
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Bash: non-anchored (prefixed) simple invocations (fail-closed round 1)
// ---------------------------------------------------------------------------

test('an inline env-var-prefixed gh pr create is rewritten with the prefix preserved', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'GH_TOKEN=x gh pr create --title x';
    const result = await enforceDraftPr(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    allowOutput(result, {
      command: 'GH_TOKEN=x gh pr create --draft --title x',
    });
  } finally {
    f.cleanup();
  }
});

test('a `time`-prefixed gh pr create is rewritten with the prefix preserved', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'time gh pr create --title x';
    const result = await enforceDraftPr(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    allowOutput(result, { command: 'time gh pr create --draft --title x' });
  } finally {
    f.cleanup();
  }
});

test('a `sudo`-prefixed gh pr create is rewritten with the prefix preserved', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'sudo gh pr create --title x';
    const result = await enforceDraftPr(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    allowOutput(result, { command: 'sudo gh pr create --draft --title x' });
  } finally {
    f.cleanup();
  }
});

test('ghe pr create (not the real gh binary) does not match and produces no output', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await enforceDraftPr(
      bashInput('ghe pr create --title x'),
      { root: f.root, home: f.home }
    );
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

test('gh prx create (not the real subcommand) does not match and produces no output', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await enforceDraftPr(
      bashInput('gh prx create --title x'),
      { root: f.root, home: f.home }
    );
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Bash: --draft=<value> (fail-closed round 1)
// ---------------------------------------------------------------------------

test('--draft=false is ambiguous intent and is denied, not rewritten', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await enforceDraftPr(
      bashInput('gh pr create --title x --draft=false'),
      { root: f.root, home: f.home }
    );
    denyOutput(result);
  } finally {
    f.cleanup();
  }
});

test('--draft=true already counts as draft and passes through untouched', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await enforceDraftPr(
      bashInput('gh pr create --title x --draft=true'),
      { root: f.root, home: f.home }
    );
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// MCP create_pull_request tools
// ---------------------------------------------------------------------------

test('an MCP create_pull_request call gets draft: true merged in, other fields untouched', async () => {
  const f = fixture();
  try {
    await activate(f);
    const toolInput = {
      owner: 'nrwl',
      repo: 'ocean',
      title: 'Add feature',
      body: 'desc',
      head: 'feature/x',
      base: 'main',
    };
    const result = await enforceDraftPr(
      mcpInput('mcp__github__create_pull_request', toolInput),
      { root: f.root, home: f.home }
    );
    allowOutput(result, { ...toolInput, draft: true });
  } finally {
    f.cleanup();
  }
});

test('an MCP create_pull_request call with draft already true is a no-op', async () => {
  const f = fixture();
  try {
    await activate(f);
    const toolInput = { owner: 'nrwl', repo: 'ocean', draft: true };
    const result = await enforceDraftPr(
      mcpInput('mcp__github__create_pull_request', toolInput),
      { root: f.root, home: f.home }
    );
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

test('an MCP create_pull_request call with draft: false gets it flipped to true', async () => {
  const f = fixture();
  try {
    await activate(f);
    const toolInput = { owner: 'nrwl', repo: 'ocean', draft: false };
    const result = await enforceDraftPr(
      mcpInput('mcp__github__create_pull_request', toolInput),
      { root: f.root, home: f.home }
    );
    allowOutput(result, { owner: 'nrwl', repo: 'ocean', draft: true });
  } finally {
    f.cleanup();
  }
});

test('a Polygraph-namespaced MCP create_pull_request tool also matches', async () => {
  const f = fixture();
  try {
    await activate(f);
    const toolInput = { owner: 'nrwl', repo: 'ocean' };
    const result = await enforceDraftPr(
      mcpInput('mcp__polygraph_polygraph-mcp__create_pull_request', toolInput),
      { root: f.root, home: f.home }
    );
    allowOutput(result, { ...toolInput, draft: true });
  } finally {
    f.cleanup();
  }
});

test('a non-matching MCP tool name produces no output', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await enforceDraftPr(
      mcpInput('mcp__github__update_pull_request', { owner: 'nrwl' }),
      { root: f.root, home: f.home }
    );
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Secret discipline
// ---------------------------------------------------------------------------

test('the result never leaks the capture URL', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await enforceDraftPr(bashInput('gh pr create'), {
      root: f.root,
      home: f.home,
    });
    assert.doesNotMatch(JSON.stringify(result), /pch_/);
    assert.doesNotMatch(JSON.stringify(result), /polygraph\.example\.test/);
  } finally {
    f.cleanup();
  }
});

test('a corrupt marker file is treated as absent (soft failure, no crash)', async () => {
  const f = fixture();
  try {
    const { mkdirSync, writeFileSync: write } = await import('node:fs');
    mkdirSync(join(f.root, 'background-capture'), { recursive: true });
    write(
      join(f.root, 'background-capture', `claude-${PROVIDER_SESSION_ID}.json`),
      'not json'
    );
    const result = await enforceDraftPr(bashInput('gh pr create'), {
      root: f.root,
      home: f.home,
    });
    noOutput(result);
  } finally {
    f.cleanup();
  }
});
