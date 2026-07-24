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
  observeBranchIdentity,
  resolveCurrentBranch,
} from '../source/hooks/pr-branch-observer.mjs';
import { activateBackgroundCapture } from '../source/hooks/background-capture-lifecycle.mjs';

const PROVIDER_SESSION_ID = '88b2ff2e-b146-458c-85fc-109c7bc12f26';
const CAPTURE_HOOK_URL =
  'https://polygraph.example.test/hooks/capture/pch_abcdefghijklmnopqrstuvwxyz123456';
// A raw commit SHA, as `.git/HEAD` holds during a detached checkout.
const DETACHED_HEAD_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'polygraph-branch-observer-'));
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
    branchStatePath: join(
      root,
      'background-capture',
      `claude-${PROVIDER_SESSION_ID}.branch.json`
    ),
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
  const repoDir = mkdtempSync(join(tmpdir(), 'polygraph-branch-repo-'));
  mkdirSync(join(repoDir, '.git'));
  writeFileSync(join(repoDir, '.git', 'HEAD'), headContent);
  return repoDir;
}

function checkoutBranch(repoDir, branch) {
  writeFileSync(join(repoDir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
}

// ---------------------------------------------------------------------------
// resolveCurrentBranch: branch resolution
// ---------------------------------------------------------------------------

test('resolveCurrentBranch reads a symbolic HEAD ref', () => {
  const repo = makeRepo('ref: refs/heads/feature/cool-thing\n');
  try {
    assert.equal(resolveCurrentBranch(repo), 'feature/cool-thing');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('resolveCurrentBranch returns null for a detached HEAD', () => {
  const repo = makeRepo(`${DETACHED_HEAD_SHA}\n`);
  try {
    assert.equal(resolveCurrentBranch(repo), null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('resolveCurrentBranch returns null outside any repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-no-repo-'));
  try {
    assert.equal(resolveCurrentBranch(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveCurrentBranch walks up from a nested cwd to find the repo root', () => {
  const repo = makeRepo('ref: refs/heads/main\n');
  try {
    const nested = join(repo, 'libs', 'ocean', 'deep', 'nested');
    mkdirSync(nested, { recursive: true });
    assert.equal(resolveCurrentBranch(nested), 'main');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// observeBranchIdentity: marker-absent silence
// ---------------------------------------------------------------------------

test('without an active marker, invocation is a silent local no-op', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/main\n');
  try {
    let fetchCalls = 0;
    const result = await observeBranchIdentity(
      { session_id: PROVIDER_SESSION_ID, cwd: repo },
      {
        root: f.root,
        home: f.home,
        fetchImpl: async () => {
          fetchCalls += 1;
          return { ok: true };
        },
      }
    );
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(fetchCalls, 0);
    // No fs writes at all beyond the (negative) marker check.
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
    let fetchCalls = 0;
    const result = await observeBranchIdentity(
      { session_id: 'not a valid id', cwd: repo },
      {
        root: f.root,
        home: f.home,
        fetchImpl: async () => {
          fetchCalls += 1;
          return { ok: true };
        },
      }
    );
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(fetchCalls, 0);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// observeBranchIdentity: fire-once-per-branch, with an active marker
// ---------------------------------------------------------------------------

test('reports a branch change once and persists lastReportedBranch', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);

    const posts = [];
    const result = await observeBranchIdentity(
      { session_id: PROVIDER_SESSION_ID, cwd: repo },
      {
        root: f.root,
        home: f.home,
        fetchImpl: async (url, request) => {
          posts.push({ url, body: JSON.parse(request.body) });
          return { ok: true };
        },
      }
    );

    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `${CAPTURE_HOOK_URL}/pr`);
    assert.deepEqual(posts[0].body, {
      providerSessionId: PROVIDER_SESSION_ID,
      kind: 'branch_active',
      branch: 'feature/x',
      eventId: 'branch:feature/x',
    });

    const persisted = JSON.parse(readFileSync(f.branchStatePath, 'utf8'));
    assert.equal(persisted.lastReportedBranch, 'feature/x');

    // A second invocation on the same branch must not fire again.
    const second = await observeBranchIdentity(
      { session_id: PROVIDER_SESSION_ID, cwd: repo },
      {
        root: f.root,
        home: f.home,
        fetchImpl: async () => {
          posts.push('unexpected-second-post');
          return { ok: true };
        },
      }
    );
    assert.deepEqual(second, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(posts.length, 1);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('fires again with a fresh eventId once the branch changes', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/main\n');
  try {
    await activate(f);
    const posts = [];
    const fetchImpl = async (url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    };

    await observeBranchIdentity(
      { session_id: PROVIDER_SESSION_ID, cwd: repo },
      { root: f.root, home: f.home, fetchImpl }
    );
    checkoutBranch(repo, 'feature/y');
    await observeBranchIdentity(
      { session_id: PROVIDER_SESSION_ID, cwd: repo },
      { root: f.root, home: f.home, fetchImpl }
    );

    assert.equal(posts.length, 2);
    assert.equal(posts[0].branch, 'main');
    assert.equal(posts[0].eventId, 'branch:main');
    assert.equal(posts[1].branch, 'feature/y');
    assert.equal(posts[1].eventId, 'branch:feature/y');

    const persisted = JSON.parse(readFileSync(f.branchStatePath, 'utf8'));
    assert.equal(persisted.lastReportedBranch, 'feature/y');
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an active marker with a detached HEAD produces no event', async () => {
  const f = fixture();
  const repo = makeRepo(`${DETACHED_HEAD_SHA}\n`);
  try {
    await activate(f);
    let fetchCalls = 0;
    const result = await observeBranchIdentity(
      { session_id: PROVIDER_SESSION_ID, cwd: repo },
      {
        root: f.root,
        home: f.home,
        fetchImpl: async () => {
          fetchCalls += 1;
          return { ok: true };
        },
      }
    );
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(fetchCalls, 0);
    assert.equal(existsSync(f.branchStatePath), false);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// observeBranchIdentity: POST failures are soft and retry-safe
// ---------------------------------------------------------------------------

test('a failed report leaves lastReportedBranch unset so the next invocation retries', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/main\n');
  try {
    await activate(f);
    let attempts = 0;
    const failing = await observeBranchIdentity(
      { session_id: PROVIDER_SESSION_ID, cwd: repo },
      {
        root: f.root,
        home: f.home,
        fetchImpl: async () => {
          attempts += 1;
          return { ok: false, status: 500 };
        },
      }
    );

    assert.deepEqual(failing, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(attempts, 1);
    assert.equal(existsSync(f.branchStatePath), false);

    // The failure is recorded in the shared hook-failure log, without ever
    // including the capture capability URL.
    const logRaw = readFileSync(f.hookLogPath, 'utf8').trim();
    const entry = JSON.parse(logRaw);
    assert.equal(entry.hook, 'pr-branch-observer:reportBranch');
    assert.equal(entry.providerSessionId, PROVIDER_SESSION_ID);
    assert.doesNotMatch(logRaw, /pch_/);
    assert.doesNotMatch(logRaw, /polygraph\.example\.test/);

    // A later, successful invocation retries and persists.
    const posts = [];
    const succeeding = await observeBranchIdentity(
      { session_id: PROVIDER_SESSION_ID, cwd: repo },
      {
        root: f.root,
        home: f.home,
        fetchImpl: async (url, request) => {
          posts.push(JSON.parse(request.body));
          return { ok: true };
        },
      }
    );
    assert.deepEqual(succeeding, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].branch, 'main');
    const persisted = JSON.parse(readFileSync(f.branchStatePath, 'utf8'));
    assert.equal(persisted.lastReportedBranch, 'main');
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a thrown network error is soft, logged, and does not persist', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/main\n');
  try {
    await activate(f);
    const result = await observeBranchIdentity(
      { session_id: PROVIDER_SESSION_ID, cwd: repo },
      {
        root: f.root,
        home: f.home,
        fetchImpl: async () => {
          throw new Error('network unreachable');
        },
      }
    );
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(existsSync(f.branchStatePath), false);

    const entry = JSON.parse(readFileSync(f.hookLogPath, 'utf8').trim());
    assert.equal(entry.hook, 'pr-branch-observer:reportBranch');
    assert.match(entry.error, /network unreachable/);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a repository outside any provider marker root never leaks the capture URL in results', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/main\n');
  try {
    await activate(f);
    const result = await observeBranchIdentity(
      { session_id: PROVIDER_SESSION_ID, cwd: repo },
      {
        root: f.root,
        home: f.home,
        fetchImpl: async () => ({ ok: true }),
      }
    );
    assert.doesNotMatch(JSON.stringify(result), /pch_/);
    assert.doesNotMatch(JSON.stringify(result), /polygraph\.example\.test/);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// observeBranchIdentity: git push -> branch_pushed
// ---------------------------------------------------------------------------

function pushInput(repo, command = 'git push -u origin feature/x', extra = {}) {
  return {
    session_id: PROVIDER_SESSION_ID,
    cwd: repo,
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout: 'To github.com:org/repo.git\n', stderr: '' },
    ...extra,
  };
}

test('a standalone git push reports branch_pushed after the branch_active report', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const posts = [];
    const result = await observeBranchIdentity(pushInput(repo), {
      root: f.root,
      home: f.home,
      fetchImpl: async (url, request) => {
        posts.push({ url, body: JSON.parse(request.body) });
        return { ok: true };
      },
    });

    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body.kind, 'branch_active');
    assert.equal(posts[1].body.kind, 'branch_pushed');
    assert.equal(posts[1].body.branch, 'feature/x');
    assert.match(posts[1].body.eventId, /^push:feature\/x:[0-9a-f]{16}$/);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a git push on an already-reported branch still reports branch_pushed', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const posts = [];
    const fetchImpl = async (url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    };

    // First invocation reports the branch; second is the push.
    await observeBranchIdentity(
      { session_id: PROVIDER_SESSION_ID, cwd: repo },
      { root: f.root, home: f.home, fetchImpl }
    );
    await observeBranchIdentity(pushInput(repo), {
      root: f.root,
      home: f.home,
      fetchImpl,
    });

    assert.equal(posts.length, 2);
    assert.equal(posts[0].kind, 'branch_active');
    assert.equal(posts[1].kind, 'branch_pushed');
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a repeated identical push dedupes by eventId while fresh push output records again', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const posts = [];
    const fetchImpl = async (url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    };

    const sameOutput = {
      tool_response: { stdout: 'same push output', stderr: '' },
    };
    const freshOutput = {
      tool_response: { stdout: 'different push output', stderr: '' },
    };
    await observeBranchIdentity(pushInput(repo, 'git push', sameOutput), {
      root: f.root,
      home: f.home,
      fetchImpl,
    });
    await observeBranchIdentity(pushInput(repo, 'git push', sameOutput), {
      root: f.root,
      home: f.home,
      fetchImpl,
    });
    await observeBranchIdentity(pushInput(repo, 'git push', freshOutput), {
      root: f.root,
      home: f.home,
      fetchImpl,
    });

    const pushPosts = posts.filter((post) => post.kind === 'branch_pushed');
    assert.equal(pushPosts.length, 3);
    // The hook itself posts every time; dedupe is server-side by eventId, so
    // identical pushes must carry the identical id and fresh output a new one.
    assert.equal(pushPosts[0].eventId, pushPosts[1].eventId);
    assert.notEqual(pushPosts[1].eventId, pushPosts[2].eventId);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('compound, interrupted, and non-push commands never report branch_pushed', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    const posts = [];
    const fetchImpl = async (url, request) => {
      posts.push(JSON.parse(request.body));
      return { ok: true };
    };
    const options = { root: f.root, home: f.home, fetchImpl };

    await observeBranchIdentity(
      pushInput(repo, 'git commit -m x && git push'),
      options
    );
    await observeBranchIdentity(
      pushInput(repo, 'git push', {
        tool_response: { stdout: '', stderr: '', interrupted: true },
      }),
      options
    );
    await observeBranchIdentity(pushInput(repo, 'git pushx origin'), options);
    await observeBranchIdentity(
      pushInput(repo, 'echo "git push is fun"'),
      options
    );

    assert.equal(posts.filter((post) => post.kind === 'branch_pushed').length, 0);
    // Only the initial branch_active from the first invocation.
    assert.equal(posts.length, 1);
    assert.equal(posts[0].kind, 'branch_active');
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a failed branch_pushed report is soft and logged without breaking the hook', async () => {
  const f = fixture();
  const repo = makeRepo('ref: refs/heads/feature/x\n');
  try {
    await activate(f);
    let calls = 0;
    const result = await observeBranchIdentity(pushInput(repo), {
      root: f.root,
      home: f.home,
      fetchImpl: async () => {
        calls += 1;
        // First call (branch_active) succeeds, second (branch_pushed) fails.
        if (calls === 1) return { ok: true };
        throw new Error('network unreachable');
      },
    });

    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    const lines = readFileSync(f.hookLogPath, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines.at(-1));
    assert.equal(entry.hook, 'pr-branch-observer:reportPush');
    assert.match(entry.error, /network unreachable/);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});
