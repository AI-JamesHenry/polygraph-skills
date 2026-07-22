import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const {
  mapClaudeTranscriptRecords,
  postBatch,
  readCompleteTranscriptRecords,
} = require('../source/hooks/hosted-parent-log-sidecar-entry.js');

const SIDECAR_PATH = join(
  import.meta.dirname,
  '..',
  'source',
  'hooks',
  'hosted-parent-log-sidecar-entry.js'
);

function toRecords(lines, baseOffset = 0) {
  let offset = baseOffset;
  return lines.map((line) => {
    const raw = JSON.stringify(line);
    const record = {
      raw,
      startOffset: offset,
      endOffset: offset + Buffer.byteLength(raw) + 1,
    };
    offset = record.endOffset;
    return record;
  });
}

function parsedLines(mapped) {
  return mapped.map((entry) => JSON.parse(entry.line));
}

test('sidecar accepts hosted capture capability URLs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-sidecar-hosted-url-'));
  const transcriptPath = join(dir, 'transcript.jsonl');
  const runtimePath = join(dir, 'runtime.json');
  writeFileSync(transcriptPath, '');

  try {
    const child = spawn(process.execPath, [SIDECAR_PATH], {
      env: {
        ...process.env,
        POLYGRAPH_PARENT_LOG_PARENT_SESSION_ID: 'provider-session-id',
        POLYGRAPH_PARENT_LOG_PATH: transcriptPath,
        POLYGRAPH_PARENT_LOG_RUNTIME_PATH: runtimePath,
        POLYGRAPH_PARENT_LOG_CAPTURE_HOOK_URL:
          'https://polygraph.example.test/nx-cloud/polygraph/hooks/capture/pch_abcdefghijklmnopqrstuvwxyz123456',
        POLYGRAPH_PARENT_LOG_IDLE_CLOSE_MS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const exitCode = await new Promise((resolve) => {
      child.once('close', resolve);
    });

    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /"status":"ready"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hosted transcript uploads use the nx-api request contract', async () => {
  let capturedUrl;
  let capturedRequest;
  const line = JSON.stringify({ type: 'user', message: 'hello' });

  await postBatch(
    'https://polygraph.example.test/nx-cloud/polygraph/hooks/capture/pch_abcdefghijklmnopqrstuvwxyz123456',
    'provider-session-id',
    [{ line }],
    async (url, request) => {
      capturedUrl = url;
      capturedRequest = request;
      return { ok: true };
    }
  );

  assert.equal(
    capturedUrl,
    'https://polygraph.example.test/nx-cloud/polygraph/hooks/capture/pch_abcdefghijklmnopqrstuvwxyz123456/transcript'
  );
  assert.deepEqual(JSON.parse(capturedRequest.body), {
    providerSessionId: 'provider-session-id',
    source: 'claude-transcript-v1',
    lines: [line],
  });
});

test('actual newlines in prompts and responses remain actual newlines', () => {
  const prompt = 'line one\nline two\n\nline four';
  const mapped = mapClaudeTranscriptRecords(
    toRecords([
      { type: 'user', message: { role: 'user', content: prompt } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer\nwith\nbreaks' }],
        },
      },
    ])
  );
  const lines = parsedLines(mapped);
  assert.equal(lines[0].type, 'user-prompt');
  assert.equal(lines[0].text, prompt);
  assert.equal(lines[1].type, 'text');
  assert.equal(lines[1].text, 'answer\nwith\nbreaks');
});

test('structured tool calls and results remain structured and distinguishable', () => {
  const mapped = mapClaudeTranscriptRecords(
    toRecords([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'git status' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: 'clean tree',
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-2',
              content: 'command not found',
              is_error: true,
            },
          ],
        },
      },
    ])
  );
  const lines = parsedLines(mapped);
  assert.equal(lines[0].type, 'tool-use');
  assert.equal(lines[0].toolName, 'Bash');
  assert.equal(JSON.parse(lines[0].input).command, 'git status');
  assert.equal(lines[1].type, 'tool-result');
  assert.equal(lines[1].isError, false);
  assert.equal(lines[2].type, 'tool-result');
  assert.equal(lines[2].isError, true);
});

test('duplicate source records map to identical idempotent event IDs', () => {
  const records = toRecords([
    { type: 'user', message: { role: 'user', content: 'replayed prompt' } },
  ]);
  const first = mapClaudeTranscriptRecords(records);
  const second = mapClaudeTranscriptRecords(records);
  assert.equal(
    JSON.parse(first[0].line).eventId,
    JSON.parse(second[0].line).eventId
  );
  assert.match(JSON.parse(first[0].line).eventId, /^transcript:0:/);

  const shifted = mapClaudeTranscriptRecords(toRecords([
    { type: 'user', message: { role: 'user', content: 'replayed prompt' } },
  ], 100));
  assert.notEqual(
    JSON.parse(first[0].line).eventId,
    JSON.parse(shifted[0].line).eventId
  );
});

test('reader returns only complete lines and resumes from a stable offset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-sidecar-read-'));
  const transcriptPath = join(dir, 'transcript.jsonl');
  try {
    const first = `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'first' },
    })}\n`;
    const partial = '{"type":"user","message":{"role":"user","content":"par';
    writeFileSync(transcriptPath, first + partial);

    const initial = readCompleteTranscriptRecords(transcriptPath, 0);
    assert.equal(initial.records.length, 1);
    assert.equal(initial.nextOffset, Buffer.byteLength(first));

    // Restart from the persisted offset once the partial line completes.
    appendFileSync(transcriptPath, 'tial"}}\n');
    const resumed = readCompleteTranscriptRecords(
      transcriptPath,
      initial.nextOffset
    );
    assert.equal(resumed.records.length, 1);
    assert.equal(
      JSON.parse(resumed.records[0].raw).message.content,
      'partial'
    );
    assert.equal(resumed.records[0].startOffset, initial.nextOffset);

    // Nothing new: offset is stable.
    const idle = readCompleteTranscriptRecords(
      transcriptPath,
      resumed.nextOffset
    );
    assert.deepEqual(idle, {
      records: [],
      nextOffset: resumed.nextOffset,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret-looking values are redacted before transmission', () => {
  const mapped = mapClaudeTranscriptRecords(
    toRecords([
      {
        type: 'user',
        message: {
          role: 'user',
          content: 'my token is github_pat_0123456789abcdefghij0123456789',
        },
      },
    ])
  );
  const line = mapped[0].line;
  assert.doesNotMatch(line, /github_pat_0123456789/);
  assert.match(line, /\[REDACTED\]/);
});
