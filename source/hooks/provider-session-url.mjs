#!/usr/bin/env node

// Isolated, fail-closed resolution of the Claude provider session URL.
//
// The hosted `background_session_start` contract requires the exact URL of
// the current provider (Claude) session. The visible Claude session URL uses
// its own opaque identifier, so it must never be fabricated by combining
// `CLAUDE_CODE_SESSION_ID` with a URL prefix. This module accepts only an
// explicit provider-supplied session URL, validates it, and returns the
// canonical value to pass through the MCP request unchanged. Anything else
// is rejected.
//
// This repository has no supported automatic source for the value: it must
// be supplied explicitly (for example the Claude-Session link the Claude
// Code environment provides for the current session, or a session URL the
// user pastes when invoking the skill). That input requirement is a
// documented integration boundary of the private preview.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const PROVIDER_SESSION_URL_ORIGINS = [
  'https://claude.ai',
  'https://claude.com',
];

const MAX_URL_LENGTH = 2_000;
const SESSION_ROUTE_PATTERN = /^\/code\/[A-Za-z0-9][A-Za-z0-9_-]{7,199}$/;
// Unexpanded shell/template placeholders and prompt-style angle brackets are
// never part of a real provider session URL.
const PLACEHOLDER_PATTERN = /[${}<>]|CLAUDE_CODE_SESSION_ID/i;

function invalid(reason) {
  return new Error(`Invalid Claude provider session URL: ${reason}.`);
}

export function resolveProviderSessionUrl(input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw invalid('a non-empty session URL is required');
  }
  const candidate = input.trim();
  if (candidate.length > MAX_URL_LENGTH) {
    throw invalid('the URL is unreasonably long');
  }
  if (PLACEHOLDER_PATTERN.test(candidate)) {
    throw invalid('the URL contains an unexpanded placeholder');
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw invalid('the URL is malformed');
  }
  if (parsed.protocol !== 'https:') {
    throw invalid('the URL must use HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw invalid('the URL must not embed credentials');
  }
  if (parsed.search || parsed.hash) {
    throw invalid('the URL must not carry query parameters or fragments');
  }
  if (!PROVIDER_SESSION_URL_ORIGINS.includes(parsed.origin)) {
    throw invalid('the URL is not on a supported Claude origin');
  }
  if (!SESSION_ROUTE_PATTERN.test(parsed.pathname)) {
    throw invalid('the URL is not a Claude session route');
  }
  return `${parsed.origin}${parsed.pathname}`;
}

async function runCli() {
  try {
    process.stdout.write(`${resolveProviderSessionUrl(process.argv[2])}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Invalid Claude provider session URL.'}\n`
    );
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) await runCli();
