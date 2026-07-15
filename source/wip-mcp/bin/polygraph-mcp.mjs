#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherDir = dirname(fileURLToPath(import.meta.url));
const vendoredEntry = join(
  launcherDir,
  '..',
  'vendor',
  'bin',
  'polygraph-mcp.mjs'
);

if (!existsSync(vendoredEntry)) {
  console.error(
    `Missing vendored Polygraph WIP MCP entrypoint at ${vendoredEntry}. ` +
      'Build the matching Ocean spike bundle and copy its complete runnable distribution into wip-mcp/vendor before installing this plugin.'
  );
  process.exit(78);
}

const result = spawnSync(
  process.execPath,
  [vendoredEntry, ...process.argv.slice(2)],
  {
    env: process.env,
    stdio: 'inherit',
  }
);

if (result.error) {
  console.error(`Failed to launch the vendored Polygraph WIP MCP: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
