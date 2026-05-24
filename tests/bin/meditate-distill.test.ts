/**
 * End-to-end tests for the auto-meditate distill orchestrator (#1198) —
 * bin/meditate-distill.mjs.
 *
 * The headless Haiku call is replaced by a node stub via the
 * MOFLO_MEDITATE_DISTILL_NODE_STUB seam, so we can assert the full pipeline
 * (gates → snapshot → spawn → mark-distilled) cross-platform without a real
 * Claude CLI.
 *
 * Cross-platform (Rule #1): temp dirs via path, spawnSync arg arrays, no shell.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';

import { appendLedgerEntries, readLedger, pendingEntries } from '../../bin/lib/meditate.mjs';

const DISTILL_SCRIPT = resolve(__dirname, '../../bin/meditate-distill.mjs');

// A node stub standing in for `claude --print <prompt>`: records the prompt to a
// marker file, then exits with STUB_EXIT (default 0).
const STUB_SOURCE = `import { writeFileSync } from 'fs';
const args = process.argv.slice(2);
try { writeFileSync(process.env.STUB_MARKER, args.join('\\u0001')); } catch {}
process.exit(process.env.STUB_EXIT ? Number(process.env.STUB_EXIT) : 0);
`;

function makeTempRoot(label: string): { root: string; stub: string; marker: string } {
  const root = resolve(
    __dirname,
    '../../.testoutput/.test-meditatedist-' + label + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(join(root, '.moflo'), { recursive: true });
  const stub = resolve(root, 'stub-claude.mjs');
  writeFileSync(stub, STUB_SOURCE, 'utf-8');
  return { root, stub, marker: resolve(root, 'stub-invoked.marker') };
}
function cleanTempRoot(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows handle hold */ }
}
function enable(root: string) {
  writeFileSync(resolve(root, 'moflo.yaml'), 'auto_meditate:\n  enabled: true\n', 'utf-8');
}
function disable(root: string) {
  writeFileSync(resolve(root, 'moflo.yaml'), 'auto_meditate:\n  enabled: false\n', 'utf-8');
}
function runDistill(root: string, stub: string, marker: string, extraEnv: Record<string, string> = {}) {
  return spawnSync('node', [DISTILL_SCRIPT], {
    cwd: root,
    encoding: 'utf-8',
    timeout: 20_000,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
      MOFLO_MEDITATE_DISTILL_NODE_STUB: stub,
      STUB_MARKER: marker,
      ...extraEnv,
    },
  });
}

describe('meditate-distill', () => {
  let root: string;
  let stub: string;
  let marker: string;
  beforeEach(() => { ({ root, stub, marker } = makeTempRoot('main')); });
  afterEach(() => cleanTempRoot(root));

  it('distills the pending snapshot and marks it distilled on success', () => {
    enable(root);
    appendLedgerEntries(root, [
      { lesson: 'Route learnings writes through the daemon, never a raw db write.' },
      { lesson: 'Guard headless spawns with CLAUDE_CODE_HEADLESS to avoid recursion.' },
    ]);
    const r = runDistill(root, stub, marker);
    expect(r.status).toBe(0);

    // The stub (standing in for Haiku) was invoked with a prompt carrying the candidates.
    expect(existsSync(marker)).toBe(true);
    const prompt = readFileSync(marker, 'utf-8');
    expect(prompt).toContain('Route learnings writes through the daemon');
    expect(prompt).toContain('mcp__moflo__memory_store');

    // Both entries are now marked distilled.
    const led = readLedger(root);
    expect(pendingEntries(led)).toHaveLength(0);
    expect(led.entries.every((e: any) => e.distilled)).toBe(true);
  });

  it('does NOT spawn when the ledger has no pending entries', () => {
    enable(root);
    const r = runDistill(root, stub, marker);
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('is a no-op when explicitly disabled (enabled: false)', () => {
    disable(root);
    appendLedgerEntries(root, [{ lesson: 'A durable lesson that must not be distilled while off.' }]);
    const r = runDistill(root, stub, marker);
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(pendingEntries(readLedger(root))).toHaveLength(1);
  });

  it('is a no-op under CLAUDE_CODE_HEADLESS even when enabled (#860 self-guard)', () => {
    enable(root);
    appendLedgerEntries(root, [{ lesson: 'A durable lesson present during a headless run.' }]);
    const r = runDistill(root, stub, marker, { CLAUDE_CODE_HEADLESS: 'true' });
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(pendingEntries(readLedger(root))).toHaveLength(1);
  });

  it('retains pending entries when the headless run fails (retry next session)', () => {
    enable(root);
    appendLedgerEntries(root, [{ lesson: 'A durable lesson whose distill attempt fails this time.' }]);
    const r = runDistill(root, stub, marker, { STUB_EXIT: '1' });
    expect(r.status).toBe(0); // the orchestrator itself never errors out
    expect(existsSync(marker)).toBe(true); // it did try
    expect(pendingEntries(readLedger(root))).toHaveLength(1); // but nothing marked distilled
  });
});
