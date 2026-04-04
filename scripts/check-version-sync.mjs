#!/usr/bin/env node
/**
 * Verify root and CLI package.json versions match.
 * Runs as prepublishOnly guard to prevent publishing with drifted versions.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const rootVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;
const cliVersion = JSON.parse(readFileSync(join(root, 'src/packages/cli/package.json'), 'utf-8')).version;

if (rootVersion !== cliVersion) {
  console.error(`✗ Version mismatch: root=${rootVersion}, cli=${cliVersion}`);
  console.error('  Run "npm version <ver> --no-git-tag-version" from the repo root to sync.');
  process.exit(1);
}

console.log(`✓ Version sync OK: ${rootVersion}`);
