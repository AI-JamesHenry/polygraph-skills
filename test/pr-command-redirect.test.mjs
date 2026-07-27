import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { redirectPrCommand } from '../source/hooks/pr-command-redirect.mjs';
import { activateBackgroundCapture } from '../source/hooks/background-capture-lifecycle.mjs';

const PROVIDER_SESSION_ID = '88b2ff2e-b146-458c-85fc-109c7bc12f26';
const CAPTURE_HOOK_URL =
  'https://polygraph.example.test/hooks/capture/pch_abcdefghijklmnopqrstuvwxyz123456';

const CREATE_DENY_REASON =
  'Polygraph cloud sessions create pull requests with the background_pr_create MCP tool, which opens a draft on a branch this session pushed. Call background_pr_create instead of gh.';
const READY_DENY_REASON =
  'Polygraph cloud sessions mark their own draft PR ready with the background_pr_ready MCP tool, which only transitions a PR this session created. Call background_pr_ready instead of gh.';
const EDIT_DENY_REASON =
  'Editing a Polygraph cloud-session PR is a human action. Ask the user to update it from the Polygraph session page, or include the change when creating the PR with background_pr_create.';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'polygraph-pr-command-redirect-'));
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

function denyOutput(result, reason) {
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
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
    const result = await redirectPrCommand(
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
    const result = await redirectPrCommand(
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
    const result = await redirectPrCommand(input, { root: f.root, home: f.home });
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Bash: gh pr create — always denied now, regardless of flags or shape
// ---------------------------------------------------------------------------

test('a simple gh pr create with no draft flag is denied', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await redirectPrCommand(bashInput('gh pr create'), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('gh pr create with --title/--body (including quoting) is denied', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command =
      'gh pr create --title "Add a great feature" --body "See full description here"';
    const result = await redirectPrCommand(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('gh pr create with --draft already present is denied, not passed through', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await redirectPrCommand(
      bashInput('gh pr create --title x --draft'),
      { root: f.root, home: f.home }
    );
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('gh pr create with -d already present is denied, not passed through', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await redirectPrCommand(bashInput('gh pr create -d'), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('leading/trailing whitespace in the command is tolerated', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await redirectPrCommand(
      bashInput('  gh pr create --title x  '),
      { root: f.root, home: f.home }
    );
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Bash: compound gh pr create — still denied (compound-ness no longer
// changes the outcome, since there is no rewrite path any more)
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
  test(`compound gh pr create (${label}) is denied`, async () => {
    const f = fixture();
    try {
      await activate(f);
      const result = await redirectPrCommand(bashInput(command), {
        root: f.root,
        home: f.home,
      });
      denyOutput(result, CREATE_DENY_REASON);
    } finally {
      f.cleanup();
    }
  });
}

test('a compound command with no gh pr create/ready/edit at all is a silent no-op', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await redirectPrCommand(
      bashInput('npm test && npm run build'),
      { root: f.root, home: f.home }
    );
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Bash: gh pr ready / gh pr edit — denied with their own human-action reason
// ---------------------------------------------------------------------------

test('gh pr ready is denied with the human-action reason', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await redirectPrCommand(bashInput('gh pr ready 42'), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, READY_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('gh pr edit is denied with the human-action reason', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await redirectPrCommand(bashInput('gh pr edit 7'), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, EDIT_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('gh pr ready hidden in a compound command is still denied', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await redirectPrCommand(
      bashInput('cd repo && gh pr ready 42'),
      { root: f.root, home: f.home }
    );
    denyOutput(result, READY_DENY_REASON);
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
    const result = await redirectPrCommand(bashInput('npm test'), {
      root: f.root,
      home: f.home,
    });
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

test('git push is left alone (branch observation covers it instead)', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await redirectPrCommand(bashInput('git push'), {
      root: f.root,
      home: f.home,
    });
    noOutput(result);
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
    const result = await redirectPrCommand(input, { root: f.root, home: f.home });
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Bash: quoted lookalikes and operators (fail-closed round 1) — still denied
// ---------------------------------------------------------------------------

test('a quoted --draft lookalike in --title does not change the create denial', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --title "add --draft support"';
    const result = await redirectPrCommand(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('a quoted "gh pr ready" phrase inside --body is not mistaken for the real invocation', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command =
      'gh pr create --body "we announced gh pr ready as the way to publish"';
    const result = await redirectPrCommand(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('a quoted && inside --body is not treated as ending detection early, and is still denied', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --body "a && b"';
    const result = await redirectPrCommand(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('a $( ) command substitution inside double quotes is denied', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --body "run $(x)"';
    const result = await redirectPrCommand(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('an unbalanced quote falls back to scanning the raw command, and is denied', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --title "unterminated';
    const result = await redirectPrCommand(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('an unbalanced quote with no real gh pr subcommand present is a silent no-op', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'echo "unterminated';
    const result = await redirectPrCommand(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Bash: backslash-escaped quotes (fail-closed round 2) — still denied
// ---------------------------------------------------------------------------

test('a draft-flag-shaped substring behind an escaped quote inside --title does not affect the denial', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command =
      'gh pr create --title "she said \\"add --draft support\\" today"';
    const result = await redirectPrCommand(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('an && hidden behind an escaped quote inside --body does not affect the denial', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --body "escaped \\" then && here"';
    const result = await redirectPrCommand(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('a double backslash before the closing quote is a literal backslash, and the command is still denied', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --title "ends with backslash\\\\"';
    const result = await redirectPrCommand(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('a command ending in a lone trailing backslash falls back to the raw scan, and is denied', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --title x \\';
    const result = await redirectPrCommand(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('an apostrophe inside a double-quoted value does not toggle single-quote state, and the command is still denied', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --title "it\'s a great feature"';
    const result = await redirectPrCommand(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('a double quote inside a single-quoted value does not toggle double-quote state, and the command is still denied', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = "gh pr create --title 'she said \"hi\"'";
    const result = await redirectPrCommand(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('an escaped quote outside all quoting does not open a quote, and never resolves to silence', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'gh pr create --title foo\\"bar';
    const result = await redirectPrCommand(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    // A real, unambiguous `gh pr create` token sequence is present, so this
    // must never resolve to silence.
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Bash: non-anchored (prefixed) invocations (fail-closed round 1) — denied
// ---------------------------------------------------------------------------

test('an inline env-var-prefixed gh pr create is denied', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'GH_TOKEN=x gh pr create --title x';
    const result = await redirectPrCommand(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('a `time`-prefixed gh pr create is denied', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'time gh pr create --title x';
    const result = await redirectPrCommand(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('a `sudo`-prefixed gh pr create is denied', async () => {
  const f = fixture();
  try {
    await activate(f);
    const command = 'sudo gh pr create --title x';
    const result = await redirectPrCommand(bashInput(command), {
      root: f.root,
      home: f.home,
    });
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('ghe pr create (not the real gh binary) does not match and produces no output', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await redirectPrCommand(
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
    const result = await redirectPrCommand(
      bashInput('gh prx create --title x'),
      { root: f.root, home: f.home }
    );
    noOutput(result);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// MCP create_pull_request tools — always denied now
// ---------------------------------------------------------------------------

test('an MCP create_pull_request call is denied with the create reason', async () => {
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
    const result = await redirectPrCommand(
      mcpInput('mcp__github__create_pull_request', toolInput),
      { root: f.root, home: f.home }
    );
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('an MCP create_pull_request call with draft already true is still denied', async () => {
  const f = fixture();
  try {
    await activate(f);
    const toolInput = { owner: 'nrwl', repo: 'ocean', draft: true };
    const result = await redirectPrCommand(
      mcpInput('mcp__github__create_pull_request', toolInput),
      { root: f.root, home: f.home }
    );
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('a Polygraph-namespaced MCP create_pull_request tool also matches and is denied', async () => {
  const f = fixture();
  try {
    await activate(f);
    const toolInput = { owner: 'nrwl', repo: 'ocean' };
    const result = await redirectPrCommand(
      mcpInput('mcp__polygraph_polygraph-mcp__create_pull_request', toolInput),
      { root: f.root, home: f.home }
    );
    denyOutput(result, CREATE_DENY_REASON);
  } finally {
    f.cleanup();
  }
});

test('a non-matching MCP tool name produces no output', async () => {
  const f = fixture();
  try {
    await activate(f);
    const result = await redirectPrCommand(
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
    const result = await redirectPrCommand(bashInput('gh pr create'), {
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
    const result = await redirectPrCommand(bashInput('gh pr create'), {
      root: f.root,
      home: f.home,
    });
    noOutput(result);
  } finally {
    f.cleanup();
  }
});
