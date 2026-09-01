#!/usr/bin/env node

// Polygraph Cursor cloud-agent OIDC PROBE (spike tooling, not shipped).
//
// Purpose: prove, from inside a real Cursor Cloud Agent VM, that the agent
// socket mints OIDC identity tokens, and record exactly what a real token
// contains. This gates the implicit-session design: the bootstrap plan
// authenticates an unattended session-start with one of these tokens.
//
// Questions this probe answers:
//   1. Does POST /v1/tokens/oidc on CURSOR_AGENT_SOCKET work at all?
//   2. Which claims are actually populated? The docs advertise owner_email,
//      branch_name, repo_url, team_id, cloud_agent_id, source, automation_id;
//      the-coaching-bay's verifier only ever consumed agent_runtime,
//      repo_urls (array), team_id, sub. Real content decides our mapping.
//   3. Is the audience echoed back verbatim?
//   4. Header shape (alg, kid) for offline JWKS verification afterwards.
//   5. Mint latency, and whether it works on the very first hook event.
//
// The full token is recorded DELIBERATELY: it expires in 5 minutes, it is
// audience-bound, and no endpoint accepts it. Having the raw JWT lets us
// verify the signature against https://api.cursor.com/keys offline. Only
// ever run this on a Polygraph test repository.
//
// Output: appends one JSON record per invocation to
// /tmp/polygraph-cursor-diag/oidc-probe.jsonl. Never blocks the agent:
// always exits 0 with `{}` on stdout.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';

const DIAG_DIR = '/tmp/polygraph-cursor-diag';
const PROBE_FILE = join(DIAG_DIR, 'oidc-probe.jsonl');
const DEFAULT_CURSOR_AGENT_SOCKET = '/run/cursor/api.sock';
const CURSOR_TOKEN_PATH = '/v1/tokens/oidc';
// Production-shaped audience: the API origin the real bootstrap would target.
const PROBE_AUDIENCE = 'https://snapshot.app.trypolygraph.com';
const MINT_TIMEOUT_MS = 5_000;

function readStdin() {
  try {
    const input = readFileSync(0, 'utf8');
    return input.trim() ? JSON.parse(input) : {};
  } catch {
    return { polygraphProbeParseError: true };
  }
}

// Same request shape the-coaching-bay uses (wwdd-workload-auth.ts): plain
// node:http over the unix socket, body {aud}, response {token}.
function mintCursorOidcToken(socketPath, audience) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ aud: audience });
    const req = request(
      {
        socketPath,
        path: CURSOR_TOKEN_PATH,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (!response.statusCode || response.statusCode >= 300) {
            reject(
              new Error(
                `mint returned ${response.statusCode ?? 'no status'}: ${raw.slice(0, 300)}`,
              ),
            );
            return;
          }
          try {
            resolve({ raw, parsed: JSON.parse(raw) });
          } catch {
            reject(new Error(`mint response not JSON: ${raw.slice(0, 300)}`));
          }
        });
      },
    );
    req.setTimeout(MINT_TIMEOUT_MS, () => req.destroy(new Error('mint timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function decodeJwtPart(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return { polygraphProbeDecodeError: true };
  }
}

async function main() {
  const input = readStdin();
  mkdirSync(DIAG_DIR, { recursive: true });

  const socketPath =
    process.env.CURSOR_AGENT_SOCKET || DEFAULT_CURSOR_AGENT_SOCKET;

  const record = {
    time: new Date().toISOString(),
    hookEventName: input?.hook_event_name ?? '<missing>',
    conversationId: input?.conversation_id ?? null,
    socketPath,
    socketEnvVar: process.env.CURSOR_AGENT_SOCKET ?? null,
    socketExists: existsSync(socketPath),
    audienceRequested: PROBE_AUDIENCE,
  };

  if (record.socketExists) {
    const startedAt = Date.now();
    try {
      const { parsed } = await mintCursorOidcToken(socketPath, PROBE_AUDIENCE);
      record.mintMs = Date.now() - startedAt;
      record.responseKeys = Object.keys(parsed ?? {});
      const token = parsed?.token;
      if (typeof token === 'string' && token.split('.').length === 3) {
        const [header, payload] = token.split('.');
        record.jwtHeader = decodeJwtPart(header);
        record.jwtClaims = decodeJwtPart(payload);
        // Full token on purpose: 5-minute expiry, audience-bound, accepted
        // nowhere. Enables offline signature verification against the JWKS.
        record.jwt = token;
      } else {
        record.mintError = `response had no 3-part token: ${JSON.stringify(parsed).slice(0, 300)}`;
      }
    } catch (error) {
      record.mintMs = Date.now() - startedAt;
      record.mintError = String(error?.message ?? error);
    }
  }

  appendFileSync(PROBE_FILE, `${JSON.stringify(record)}\n`, 'utf8');
  process.stdout.write('{}\n');
}

await main().catch(() => {
  // Diagnostics must never fail the agent.
  process.stdout.write('{}\n');
});
