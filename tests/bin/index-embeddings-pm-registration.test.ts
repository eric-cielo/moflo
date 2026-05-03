/**
 * Regression tests for #886 — index-patterns.mjs and index-guidance.mjs must
 * register their detached `build-embeddings.mjs` background spawns with the
 * shared ProcessManager (`bin/lib/process-manager.mjs`).
 *
 * Before this fix both files used raw `spawn(..., { detached: true })` with
 * `child.unref()`. The resulting `node build-embeddings.mjs` PIDs:
 *
 *   1. matched doctor's `findZombieProcesses` regex (cmdline contains "moflo")
 *   2. had a dead immediate parent (the index-*.mjs script exited before the
 *      embedding job finished)
 *   3. were NOT in `.moflo/background-pids.json`, so doctor's tracked-PID
 *      allowlist did not skip them
 *
 * Result: a transient `⚠ Zombie Processes` warning on `flo doctor --strict`
 * during smoke / first-session-after-install.
 *
 * The fix is to spawn through `createProcessManager(...).spawn(...)` so each
 * PID is registered, deduped, and reaped at session-end / smoke teardown.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const BIN = resolve(__dirname, '../../bin');

describe('bin/index-patterns.mjs background-embedding spawn (#886)', () => {
  const file = resolve(BIN, 'index-patterns.mjs');
  const src = readFileSync(file, 'utf-8');

  it('imports createProcessManager from process-manager.mjs', () => {
    expect(src).toMatch(/from\s+['"]\.\/lib\/process-manager\.mjs['"]/);
    expect(src).toMatch(/createProcessManager/);
  });

  it('does NOT import raw `spawn` from child_process', () => {
    // Raw spawn import re-introduces the zombie-flagging path. The shared
    // pm.spawn helper is the only sanctioned way to start a background
    // moflo node process from this file.
    expect(src).not.toMatch(/from\s+['"]child_process['"]/);
  });

  it('does NOT call raw spawn() (detached or otherwise)', () => {
    // Defence in depth — even without an import, `await import('child_process')`
    // would re-introduce the regression. Match any `spawn(` token NOT preceded
    // by `pm.` or `.spawn` (which is the sanctioned ProcessManager helper).
    const stripComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(stripComments).not.toMatch(/(?<!\.)\bspawn\s*\(/);
  });

  it('uses pm.spawn with a stable namespace-derived label', () => {
    // The label must be stable so dedup correctly skips a second spawn from
    // index-all.mjs's later `build-embeddings` step within the lock window.
    expect(src).toMatch(/pm\.spawn\s*\(/);
    expect(src).toMatch(/build-embeddings-\$\{NAMESPACE\}/);
  });
});

describe('bin/index-guidance.mjs background-embedding spawn (#886)', () => {
  const file = resolve(BIN, 'index-guidance.mjs');
  const src = readFileSync(file, 'utf-8');

  it('imports createProcessManager from process-manager.mjs', () => {
    expect(src).toMatch(/from\s+['"]\.\/lib\/process-manager\.mjs['"]/);
    expect(src).toMatch(/createProcessManager/);
  });

  it('does NOT dynamically import child_process for the embedding spawn', () => {
    // The previous code did `const { spawn } = await import('child_process')`
    // immediately before the detached spawn. That path is gone.
    expect(src).not.toMatch(/await\s+import\s*\(\s*['"]child_process['"]\s*\)/);
  });

  it('does NOT call raw spawn() (detached or otherwise)', () => {
    const stripComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(stripComments).not.toMatch(/(?<!\.)\bspawn\s*\(/);
  });

  it('uses pm.spawn with a stable namespace-derived label', () => {
    expect(src).toMatch(/pm\.spawn\s*\(/);
    expect(src).toMatch(/build-embeddings-\$\{NAMESPACE\}/);
  });
});

describe('harness/consumer-smoke/lib/checks.mjs (#886 follow-up)', () => {
  const file = resolve(__dirname, '../../harness/consumer-smoke/lib/checks.mjs');
  const src = readFileSync(file, 'utf-8');

  it('does NOT allowlist `Zombie Processes` (root cause is fixed)', () => {
    // Allowlist removal is part of the ticket's acceptance criteria — keeping
    // the entry would mask a regression of the underlying registration bug.
    const allowlist = src.match(/SMOKE_ALLOWED_DOCTOR_WARNINGS\s*=\s*\[([\s\S]*?)\]/);
    expect(allowlist, 'allowlist constant must exist').toBeTruthy();
    expect(allowlist![1]).not.toMatch(/['"]Zombie Processes['"]/);
  });
});
