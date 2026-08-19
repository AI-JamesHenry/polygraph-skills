#!/usr/bin/env node

// Polygraph Cursor cloud-agent DIAGNOSTIC hook (spike tooling, not shipped).
//
// Purpose: discover, from inside a real Cursor Cloud Agent VM, everything the
// docs do not specify:
//   - the exact hook input payload per event (field names, shapes),
//   - the on-disk transcript file format at `transcript_path`,
//   - which environment variables exist in the VM (names only for sensitive),
//   - whether state under /tmp survives between hook invocations and runs.
//
// It is intentionally capture-everything: only ever install it on a Polygraph
// test repository, never a customer repository.
//
// Output channels, in order of preference:
//   1. Append to /tmp/polygraph-cursor-diag/ inside the VM (events.jsonl plus
//      a transcript snapshot). Retrieve by sending the agent a follow-up
//      prompt asking it to print those files, or via a shell in Cursor's UI.
//   2. If the env var POLYGRAPH_DIAG_URL is set (configure it as a Cursor
//      dashboard secret on the test environment), POST each record there too.
//
// The hook never blocks the agent: it always exits 0 with `{}` on stdout.

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { basename, join } from 'node:path';

const DIAG_DIR = '/tmp/polygraph-cursor-diag';
const EVENTS_FILE = join(DIAG_DIR, 'events.jsonl');
const MAX_TRANSCRIPT_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const POST_TIMEOUT_MS = 5_000;
const SENSITIVE_NAME_PATTERN =
  /AUTH|COOKIE|CREDENTIAL|KEY|PASSWORD|PRIVATE|SECRET|TOKEN/i;

function readStdin() {
  try {
    const input = readFileSync(0, 'utf8');
    return input.trim() ? JSON.parse(input) : {};
  } catch {
    return { polygraphDiagParseError: true };
  }
}

function redactedEnvironment(environment) {
  return Object.fromEntries(
    Object.keys(environment)
      .sort()
      .map((name) => [
        name,
        SENSITIVE_NAME_PATTERN.test(name)
          ? `<redacted:length=${String(environment[name] ?? '').length}>`
          : environment[name],
      ])
  );
}

function snapshotTranscript(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) {
    return { snapshot: null, size: null };
  }
  const size = statSync(transcriptPath).size;
  if (size > MAX_TRANSCRIPT_SNAPSHOT_BYTES) {
    return { snapshot: null, size };
  }
  const target = join(DIAG_DIR, `transcript-${basename(transcriptPath)}`);
  copyFileSync(transcriptPath, target);
  return { snapshot: target, size };
}

async function postRecord(url, record) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch {
    // Best-effort delivery. The on-disk record is the primary channel.
  }
}

async function main() {
  const input = readStdin();
  mkdirSync(DIAG_DIR, { recursive: true });

  const transcriptPath =
    input?.transcript_path ?? process.env.CURSOR_TRANSCRIPT_PATH ?? null;

  const record = {
    time: new Date().toISOString(),
    pid: process.pid,
    hookEventName: input?.hook_event_name ?? '<missing>',
    input,
    environment: redactedEnvironment(process.env),
    transcript: snapshotTranscript(transcriptPath),
    cwd: process.cwd(),
  };

  appendFileSync(EVENTS_FILE, `${JSON.stringify(record)}\n`, 'utf8');

  const diagUrl = process.env.POLYGRAPH_DIAG_URL;
  if (diagUrl) {
    await postRecord(diagUrl, record);
    // On stop, also ship the transcript itself: the VM may be recycled
    // before we retrieve files interactively.
    if (input?.hook_event_name === 'stop' && record.transcript.snapshot) {
      await postRecord(diagUrl, {
        time: record.time,
        kind: 'transcript',
        transcriptPath,
        content: readFileSync(record.transcript.snapshot, 'utf8'),
      });
    }
  }

  process.stdout.write('{}\n');
}

await main().catch(() => {
  // Diagnostics must never fail the agent.
  process.stdout.write('{}\n');
});
