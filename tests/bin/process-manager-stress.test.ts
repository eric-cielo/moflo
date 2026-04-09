/**
 * Stress and scenario tests for bin/lib/process-manager.mjs
 * and bin/lib/registry-cleanup.cjs.
 *
 * Covers:
 *   - Concurrent session-restore (thundering-herd)
 *   - Full lifecycle: session-start → work → session-end → 0 orphans
 *   - Mass spawn with dedup
 *   - Registry corruption resilience
 *   - killAll idempotency
 *   - Rapid spawn-kill cycles
 *   - Mixed alive/dead registry
 *   - Lock contention (multiple acquires)
 *   - Spawn with invalid command
 *   - registry-cleanup.cjs (CJS sync helper)
 *   - Many unique labels at scale
 *   - Spawn after killAll (fresh start)
 *   - Registry format edge cases
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync, readFileSync, writeFileSync, utimesSync, mkdirSync, rmSync,
} from 'fs';
import { resolve, join } from 'path';
import { pathToFileURL } from 'url';
import { execFileSync, execSync } from 'child_process';

const BIN_LIB = resolve(__dirname, '../../bin/lib');
const PM_PATH = resolve(BIN_LIB, 'process-manager.mjs');
const CLEANUP_PATH = resolve(BIN_LIB, 'registry-cleanup.cjs');

function makeTempRoot(): string {
  const root = resolve(
    __dirname,
    '../../.testoutput/.test-pm-stress-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(resolve(root, '.claude-flow'), { recursive: true });
  return root;
}

function cleanTempRoot(root: string) {
  // Kill any leftover processes tracked in the registry
  const pidFile = join(root, '.claude-flow', 'background-pids.json');
  try {
    if (existsSync(pidFile)) {
      const entries = JSON.parse(readFileSync(pidFile, 'utf-8'));
      if (Array.isArray(entries)) {
        for (const e of entries) {
          try { process.kill(e.pid, 'SIGTERM'); } catch { /* ok */ }
        }
      }
    }
  } catch { /* ok */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
}

/** Run an ESM snippet against process-manager.mjs */
function runPM(root: string, code: string): any {
  const pmURL = pathToFileURL(PM_PATH).href;
  const script = `
    import { createProcessManager } from '${pmURL}';
    const pm = createProcessManager('${root.replace(/\\/g, '/')}');
    const result = await (async () => { ${code} })();
    process.stdout.write(JSON.stringify(result));
  `;
  const out = execFileSync('node', ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    timeout: 15000,
    cwd: root,
  });
  return JSON.parse(out.trim());
}

function readRegistry(root: string): any[] {
  const p = join(root, '.claude-flow', 'background-pids.json');
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function wait(ms: number) {
  execFileSync('node', ['-e', `setTimeout(()=>{},${ms})`], { timeout: ms + 5000 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stress: concurrent session-restore (thundering-herd prevention)
// ─────────────────────────────────────────────────────────────────────────────

describe('concurrent session-restore (thundering-herd)', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('5x concurrent spawns with same labels → dedup to exactly 1 per label', () => {
    // Simulate the real session-start pattern: spawn 3 labeled background tasks
    // Do it 5 times (simulating 5 concurrent session-restores), each in sequence.
    // The lock + dedup should prevent duplicates.
    const labels = ['index-guidance', 'generate-code-map', 'learning-service'];

    // First "session-restore" — spawns 3 fresh processes
    const r1 = runPM(root, `
      const results = [];
      for (const label of ${JSON.stringify(labels)}) {
        results.push(pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], label));
      }
      return results;
    `);
    expect(r1.filter((r: any) => !r.skipped)).toHaveLength(3);

    // 4 more "session-restores" — all should be deduped
    for (let i = 0; i < 4; i++) {
      const rN = runPM(root, `
        const results = [];
        for (const label of ${JSON.stringify(labels)}) {
          results.push(pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], label));
        }
        return results;
      `);
      // All 3 should be skipped
      expect(rN.filter((r: any) => r.skipped)).toHaveLength(3);
    }

    // Verify: exactly 3 entries in registry
    const reg = readRegistry(root);
    expect(reg).toHaveLength(3);
    expect(reg.map((e: any) => e.label).sort()).toEqual(labels.sort());
  });

  it('lock prevents concurrent session-restores from both spawning', () => {
    // Acquire lock, then try to spawn — the caller should check isLocked() first
    runPM(root, `pm.acquireLock(); return true;`);

    const locked = runPM(root, `return pm.isLocked();`);
    expect(locked).toBe(true);

    // A well-behaved caller would check isLocked() and skip:
    const r = runPM(root, `
      if (pm.isLocked()) return { skippedDueToLock: true };
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'should-not-run');
      return { skippedDueToLock: false };
    `);
    expect(r.skippedDueToLock).toBe(true);

    // Registry should be empty
    expect(readRegistry(root)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full lifecycle: session-start → work → session-end → 0 orphans
// ─────────────────────────────────────────────────────────────────────────────

describe('full lifecycle', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('session-start spawns → session-end kills → 0 orphans', () => {
    // Step 1: session-start — spawn 4 background tasks
    runPM(root, `
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'indexer');
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'codemap');
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'pretrain');
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'hnsw');
      return true;
    `);

    // Verify 4 processes alive
    const active1 = runPM(root, `return pm.getActive();`);
    expect(active1).toHaveLength(4);

    // Step 2: session-end — kill all
    const killResult = runPM(root, `return pm.killAll();`);
    expect(killResult.killed).toBe(4);

    // Step 3: verify 0 orphans
    const active2 = runPM(root, `return pm.getActive();`);
    expect(active2).toHaveLength(0);

    // Registry should be empty
    expect(readRegistry(root)).toHaveLength(0);

    // Lock should be cleared
    expect(existsSync(join(root, '.claude-flow', 'spawn.lock'))).toBe(false);
  });

  it('new session after previous session-end works cleanly', () => {
    // Session 1: spawn + kill
    runPM(root, `
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'worker-a');
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'worker-b');
      return true;
    `);
    runPM(root, `return pm.killAll();`);

    // Session 2: spawn again with same labels — should succeed (not skipped)
    const r = runPM(root, `
      const a = pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'worker-a');
      const b = pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'worker-b');
      return { a, b };
    `);
    expect(r.a.skipped).toBe(false);
    expect(r.b.skipped).toBe(false);
    expect(r.a.pid).toBeGreaterThan(0);
    expect(r.b.pid).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mass spawn with dedup
// ─────────────────────────────────────────────────────────────────────────────

describe('mass spawn', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('10 spawns with 5 unique labels → exactly 5 processes', () => {
    const r = runPM(root, `
      const labels = ['a', 'b', 'c', 'd', 'e'];
      const results = [];
      // Spawn each label twice
      for (let round = 0; round < 2; round++) {
        for (const label of labels) {
          results.push(pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], label));
        }
      }
      return {
        total: results.length,
        spawned: results.filter(r => !r.skipped).length,
        deduped: results.filter(r => r.skipped).length,
        active: pm.getActive().length,
      };
    `);
    expect(r.total).toBe(10);
    expect(r.spawned).toBe(5);
    expect(r.deduped).toBe(5);
    expect(r.active).toBe(5);
  });

  it('8 unique labels all spawn successfully', () => {
    const r = runPM(root, `
      const labels = ['daemon', 'indexer', 'codemap', 'pretrain', 'hnsw', 'neural-1', 'neural-2', 'ewc'];
      const results = [];
      for (const label of labels) {
        results.push({ label, ...pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], label) });
      }
      return {
        count: results.length,
        allSpawned: results.every(r => !r.skipped && r.pid > 0),
        uniquePids: new Set(results.map(r => r.pid)).size,
      };
    `);
    expect(r.count).toBe(8);
    expect(r.allSpawned).toBe(true);
    expect(r.uniquePids).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Registry corruption resilience
// ─────────────────────────────────────────────────────────────────────────────

describe('registry corruption resilience', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('handles corrupt JSON in registry', () => {
    writeFileSync(join(root, '.claude-flow', 'background-pids.json'), '{{{not json');
    // Should not throw — readRegistry returns []
    const r = runPM(root, `
      const active = pm.getActive();
      const spawned = pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'after-corrupt');
      return { active: active.length, spawned: spawned.skipped };
    `);
    expect(r.active).toBe(0);
    expect(r.spawned).toBe(false); // not skipped — fresh spawn
  });

  it('handles non-array JSON in registry (e.g. object)', () => {
    writeFileSync(
      join(root, '.claude-flow', 'background-pids.json'),
      JSON.stringify({ notAnArray: true }),
    );
    const r = runPM(root, `return pm.getActive();`);
    expect(r).toEqual([]);
  });

  it('handles empty file', () => {
    writeFileSync(join(root, '.claude-flow', 'background-pids.json'), '');
    const r = runPM(root, `return pm.getActive();`);
    expect(r).toEqual([]);
  });

  it('handles missing .claude-flow directory', () => {
    const bareRoot = resolve(
      __dirname,
      '../../.testoutput/.test-pm-bare-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    );
    mkdirSync(bareRoot, { recursive: true });

    try {
      // Should create .claude-flow/ on first spawn
      const r = runPM(bareRoot, `
        const spawned = pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'bootstrap');
        return { pid: spawned.pid, skipped: spawned.skipped };
      `);
      expect(r.skipped).toBe(false);
      expect(r.pid).toBeGreaterThan(0);
      expect(existsSync(join(bareRoot, '.claude-flow', 'background-pids.json'))).toBe(true);
    } finally {
      cleanTempRoot(bareRoot);
    }
  });

  it('handles registry with entries missing pid field', () => {
    writeFileSync(
      join(root, '.claude-flow', 'background-pids.json'),
      JSON.stringify([{ label: 'no-pid', cmd: 'node' }]),
    );
    // isAlive(undefined) should return false, not throw
    const r = runPM(root, `return pm.getActive();`);
    expect(r).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// killAll edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('killAll edge cases', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('killAll on empty registry returns 0', () => {
    const r = runPM(root, `return pm.killAll();`);
    expect(r.killed).toBe(0);
    expect(r.total).toBe(0);
  });

  it('killAll is idempotent — calling twice is safe', () => {
    runPM(root, `
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'idem-a');
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'idem-b');
      return true;
    `);

    const r1 = runPM(root, `return pm.killAll();`);
    expect(r1.killed).toBe(2);

    const r2 = runPM(root, `return pm.killAll();`);
    expect(r2.killed).toBe(0);
    expect(r2.total).toBe(0);
  });

  it('killAll with mix of alive and already-dead processes', () => {
    // Spawn one alive and seed one dead
    runPM(root, `
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'alive');
      return true;
    `);

    // Manually add a dead PID to registry
    const reg = readRegistry(root);
    reg.push({ pid: 99999999, label: 'dead', cmd: 'fake', startedAt: new Date().toISOString() });
    writeFileSync(join(root, '.claude-flow', 'background-pids.json'), JSON.stringify(reg));

    const r = runPM(root, `return pm.killAll();`);
    // Only the alive one should count as killed
    expect(r.killed).toBe(1);
    expect(r.total).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rapid spawn-kill cycles
// ─────────────────────────────────────────────────────────────────────────────

describe('rapid spawn-kill cycles', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('5 rapid cycles of spawn → killAll', { timeout: 30000 }, () => {
    for (let i = 0; i < 5; i++) {
      const spawned = runPM(root, `
        pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'cycle-a');
        pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'cycle-b');
        return pm.getActive().length;
      `);
      expect(spawned).toBe(2);

      const killed = runPM(root, `return pm.killAll();`);
      expect(killed.killed).toBe(2);
    }

    // Final state: empty
    expect(readRegistry(root)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Spawn with invalid command
// ─────────────────────────────────────────────────────────────────────────────

describe('spawn with invalid command', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('returns { pid: null, skipped: false } for non-existent command', () => {
    const r = runPM(root, `
      return pm.spawn('nonexistent-command-that-does-not-exist-12345', [], 'bad-cmd');
    `);
    expect(r.skipped).toBe(false);
    expect(r.pid).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// prune accuracy
// ─────────────────────────────────────────────────────────────────────────────

describe('prune accuracy', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('prune keeps alive and removes dead in mixed registry', () => {
    // Spawn 2 alive + seed 3 dead
    runPM(root, `
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'keeper-1');
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'keeper-2');
      return true;
    `);

    const reg = readRegistry(root);
    for (let i = 0; i < 3; i++) {
      reg.push({ pid: 99999990 + i, label: `ghost-${i}`, cmd: 'fake', startedAt: new Date().toISOString() });
    }
    writeFileSync(join(root, '.claude-flow', 'background-pids.json'), JSON.stringify(reg));

    const r = runPM(root, `return pm.prune();`);
    expect(r.pruned).toBe(3);
    expect(r.remaining).toBe(2);

    // Verify the remaining are the alive ones
    const alive = readRegistry(root);
    expect(alive).toHaveLength(2);
    expect(alive.every((e: any) => e.label.startsWith('keeper-'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// registry-cleanup.cjs (CJS sync helper)
// ─────────────────────────────────────────────────────────────────────────────

describe('registry-cleanup.cjs', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('exists on disk and parses', () => {
    expect(existsSync(CLEANUP_PATH)).toBe(true);
    execFileSync('node', ['--check', CLEANUP_PATH], { timeout: 5000 });
  });

  it('killTrackedSync kills processes and clears registry', () => {
    // Spawn processes via the ESM module
    runPM(root, `
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'cleanup-a');
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'cleanup-b');
      return true;
    `);
    expect(readRegistry(root)).toHaveLength(2);

    // Use the CJS helper to clean up (simulating session-end)
    const result = execFileSync('node', ['-e', `
      const { killTrackedSync } = require('${CLEANUP_PATH.replace(/\\/g, '/')}');
      const killed = killTrackedSync('${root.replace(/\\/g, '/')}');
      process.stdout.write(String(killed));
    `], { encoding: 'utf-8', timeout: 10000 });

    expect(parseInt(result.trim())).toBe(2);

    // Registry should be cleared
    const reg = readRegistry(root);
    expect(reg).toHaveLength(0);
  });

  it('killTrackedSync removes spawn lock', () => {
    // Create a lock file
    writeFileSync(join(root, '.claude-flow', 'spawn.lock'), String(Date.now()));
    expect(existsSync(join(root, '.claude-flow', 'spawn.lock'))).toBe(true);

    execFileSync('node', ['-e', `
      const { killTrackedSync } = require('${CLEANUP_PATH.replace(/\\/g, '/')}');
      killTrackedSync('${root.replace(/\\/g, '/')}');
    `], { encoding: 'utf-8', timeout: 10000 });

    expect(existsSync(join(root, '.claude-flow', 'spawn.lock'))).toBe(false);
  });

  it('killTrackedSync handles empty/missing registry gracefully', () => {
    // No registry file at all
    const result = execFileSync('node', ['-e', `
      const { killTrackedSync } = require('${CLEANUP_PATH.replace(/\\/g, '/')}');
      const killed = killTrackedSync('${root.replace(/\\/g, '/')}');
      process.stdout.write(String(killed));
    `], { encoding: 'utf-8', timeout: 10000 });

    expect(parseInt(result.trim())).toBe(0);
  });

  it('killTrackedSync handles corrupt registry', () => {
    writeFileSync(join(root, '.claude-flow', 'background-pids.json'), 'NOT-JSON!!!');

    const result = execFileSync('node', ['-e', `
      const { killTrackedSync } = require('${CLEANUP_PATH.replace(/\\/g, '/')}');
      const killed = killTrackedSync('${root.replace(/\\/g, '/')}');
      process.stdout.write(String(killed));
    `], { encoding: 'utf-8', timeout: 10000 });

    // Should not throw, returns 0
    expect(parseInt(result.trim())).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lock contention
// ─────────────────────────────────────────────────────────────────────────────

describe('lock contention', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('second acquireLock does not throw when lock is fresh', () => {
    // Two acquires in sequence — second should silently skip (lock exists, not stale)
    const r = runPM(root, `
      pm.acquireLock();
      const first = pm.isLocked();
      pm.acquireLock(); // should not throw
      const second = pm.isLocked();
      return { first, second };
    `);
    expect(r.first).toBe(true);
    expect(r.second).toBe(true);
  });

  it('lock can be re-acquired after release', () => {
    const r = runPM(root, `
      pm.acquireLock();
      const locked1 = pm.isLocked();
      pm.releaseLock();
      const released = pm.isLocked();
      pm.acquireLock();
      const locked2 = pm.isLocked();
      return { locked1, released, locked2 };
    `);
    expect(r.locked1).toBe(true);
    expect(r.released).toBe(false);
    expect(r.locked2).toBe(true);
  });

  it('stale lock can be overwritten by acquireLock', () => {
    // Create a stale lock (mtime = 60s ago)
    const lockFile = join(root, '.claude-flow', 'spawn.lock');
    writeFileSync(lockFile, String(Date.now()));
    const past = new Date(Date.now() - 60000);
    utimesSync(lockFile, past, past);

    // Lock should be considered expired
    const r = runPM(root, `
      const wasLocked = pm.isLocked();
      pm.acquireLock(); // should overwrite stale lock
      const nowLocked = pm.isLocked();
      return { wasLocked, nowLocked };
    `);
    expect(r.wasLocked).toBe(false);
    expect(r.nowLocked).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-module consistency: ESM spawn → CJS cleanup
// ─────────────────────────────────────────────────────────────────────────────

describe('cross-module ESM→CJS consistency', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('processes spawned by ESM module are killable by CJS cleanup', () => {
    // Spawn 3 processes via ESM process-manager
    runPM(root, `
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'cross-a');
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'cross-b');
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'cross-c');
      return true;
    `);
    expect(readRegistry(root)).toHaveLength(3);

    // Kill via CJS helper (simulating what session-end does)
    const killed = execFileSync('node', ['-e', `
      const { killTrackedSync } = require('${CLEANUP_PATH.replace(/\\/g, '/')}');
      process.stdout.write(String(killTrackedSync('${root.replace(/\\/g, '/')}')));
    `], { encoding: 'utf-8', timeout: 10000 });

    expect(parseInt(killed.trim())).toBe(3);

    // ESM module should see empty active list
    const active = runPM(root, `return pm.getActive();`);
    expect(active).toHaveLength(0);
  });

  it('CJS cleanup followed by ESM spawn starts fresh', () => {
    // Spawn via ESM
    runPM(root, `
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'fresh-a');
      return true;
    `);

    // CJS cleanup
    execFileSync('node', ['-e', `
      const { killTrackedSync } = require('${CLEANUP_PATH.replace(/\\/g, '/')}');
      killTrackedSync('${root.replace(/\\/g, '/')}');
    `], { encoding: 'utf-8', timeout: 10000 });

    // Respawn via ESM — should not be deduped
    const r = runPM(root, `
      const result = pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'fresh-a');
      return result;
    `);
    expect(r.skipped).toBe(false);
    expect(r.pid).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Registry field validation
// ─────────────────────────────────────────────────────────────────────────────

describe('registry field validation', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('spawn writes correct fields to registry', () => {
    runPM(root, `
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'field-check');
      return true;
    `);

    const reg = readRegistry(root);
    expect(reg).toHaveLength(1);

    const entry = reg[0];
    expect(entry).toHaveProperty('pid');
    expect(entry).toHaveProperty('label', 'field-check');
    expect(entry).toHaveProperty('cmd');
    expect(entry).toHaveProperty('startedAt');
    expect(typeof entry.pid).toBe('number');
    expect(entry.pid).toBeGreaterThan(0);
    expect(entry.cmd).toContain('node');
    expect(entry.cmd).toContain('setTimeout');
    // startedAt should be an ISO date string
    expect(new Date(entry.startedAt).toISOString()).toBe(entry.startedAt);
  });

  it('cmd field is truncated to 200 chars', () => {
    const longArg = 'x'.repeat(300);
    runPM(root, `
      pm.spawn('node', ['-e', '${longArg}'], 'long-cmd');
      return true;
    `);

    const reg = readRegistry(root);
    expect(reg[0].cmd.length).toBeLessThanOrEqual(200);
  });
});
