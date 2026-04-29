/**
 * Shared scaffolding for the populated-consumer harness's sql.js probe
 * subprocesses. Every probe writes a short `.mjs` script into the consumer
 * dir, runs it via `runNode`, parses the JSON its last stdout line emits,
 * and cleans up — this helper collapses that pattern.
 *
 * Probes load `sql.js` via `createRequire(import.meta.url)` so they exercise
 * the same module resolution path the launcher uses; the helper handles the
 * createRequire/pathToFileURL plumbing so each probe body only carries the
 * sql.js logic it actually needs.
 *
 * Probes write a single JSON line on the FIRST stdout line — the helper
 * tolerates wasm-loader chatter on later lines by parsing only the first.
 */

import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { runNode } from './proc.mjs';
import { record } from './report.mjs';

const PROBE_HARNESS = `
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sqlInit = require('sql.js');
function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}
`;

/**
 * Run a sql.js probe inline. The body has access to: `sqlInit` (the default
 * export from sql.js, an async initializer) and `emit(value)` which writes
 * the result as a single JSON line.
 *
 * Returns the parsed JSON, or null on failure (failure is recorded under
 * `<label>:probe`).
 */
export function runSqlJsProbe(consumerDir, label, body, runOpts = {}) {
  const probePath = join(consumerDir, `__${label}-probe.mjs`);
  writeFileSync(probePath, `${PROBE_HARNESS}\n${body}\n`);
  let result;
  try {
    result = runNode(probePath, [], { cwd: consumerDir, timeout: 60_000, ...runOpts });
  } finally {
    rmSync(probePath, { force: true });
  }
  if (result.code !== 0) {
    record(`${label}:probe`, 'fail', `exit ${result.code}: ${(result.stderr || result.stdout).slice(0, 300)}`);
    return null;
  }
  const firstLine = result.stdout.trim().split('\n').find(line => line.startsWith('{') || line.startsWith('['));
  if (!firstLine) {
    record(`${label}:probe`, 'fail', `no JSON line in stdout: ${result.stdout.slice(0, 200)}`);
    return null;
  }
  try {
    return JSON.parse(firstLine);
  } catch (err) {
    record(`${label}:probe`, 'fail', `JSON parse failed (${err.message}): ${firstLine.slice(0, 200)}`);
    return null;
  }
}

/**
 * Path-aware variant: builds the probe path with a guaranteed unique name
 * so concurrent probes (the MCP-clobber check spawns one alongside another)
 * don't collide. Returns the path so callers can pass it to `spawn` if they
 * need a long-lived process instead of `runNode`.
 */
export function writeStandaloneProbe(consumerDir, label, body) {
  const probePath = join(consumerDir, `__${label}-${Date.now()}.mjs`);
  writeFileSync(probePath, `${PROBE_HARNESS}\n${body}\n`);
  return probePath;
}
