import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(
  new URL('../source/wip-mcp/bin/polygraph-mcp.mjs', import.meta.url)
);

const vendoredEntry = fileURLToPath(
  new URL(
    '../source/wip-mcp/vendor/bin/polygraph-mcp.mjs',
    import.meta.url
  )
);

test('WIP MCP launcher is pinned to the vendored Ocean runtime', () => {
  const source = readFileSync(launcher, 'utf8');

  assert.equal(existsSync(vendoredEntry), true);
  assert.match(source, /vendor[\s\S]*bin[\s\S]*polygraph-mcp\.mjs/);
  assert.match(source, /Missing vendored Polygraph WIP MCP entrypoint/);
  assert.doesNotMatch(source, /@polygraph\/mcp|@latest/);
  assert.doesNotMatch(source, /POLYGRAPH_SERVICE_ACCOUNT_SECRET/);
});
