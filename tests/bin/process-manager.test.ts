/**
 * Tests for bin/lib/process-manager.mjs
 *
 * Covers: spawn, dedup, killAll, getActive, prune, lock guard.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, utimesSync, mkdirSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { pathToFileURL } from 'url';

const BIN_LIB = resolve(__dirname, '../../bin/lib');
const PM_PATH = resolve(BIN_LIB, 'process-manager.mjs');

// Loaded once via dynamic import in beforeAll; previously every test wrapped
// each operation in `execFileSync('node', '--input-type=module', ...)`, which
// under Windows maxForks=2 fork contention couldn't reliably get a child Node
// process within the per-test budget (each test cost 1-3 outer subprocess
// spawns of 5+ s each). The module is side-effect-free at the top level so a
// dynamic import is equivalent.
type CreateProcessManager = (root: string) => {
  spawn(cmd: string, args: string[], label: string): { pid: number | null; skipped: boolean };
  killAll(): { killed: number; total: number };
  getActive(): Array<{ pid: number; label: string; cmd: string; startedAt: string }>;
  prune(): { pruned: number; remaining: number };
  isLocked(): boolean;
  acquireLock(): void;
  releaseLock(): void;
  readonly root: string;
};
let createProcessManager: CreateProcessManager;

beforeAll(async () => {
  const mod = await import(pathToFileURL(PM_PATH).href);
  createProcessManager = mod.createProcessManager as CreateProcessManager;
});

/** Create an isolated temp project root for each test. */
function makeTempRoot(): string {
  const root = resolve(__dirname, '../../.testoutput/.test-pm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(resolve(root, '.moflo'), { recursive: true });
  return root;
}

function cleanTempRoot(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
}

/** Sleep helper for polling loops below. */
const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

describe('process-manager.mjs', () => {
  it('exists on disk', () => {
    expect(existsSync(PM_PATH)).toBe(true);
  });

  it('parses as valid ESM', () => {
    // beforeAll already imported the module; reaching here means the dynamic
    // import succeeded. Assert the documented export shape.
    expect(typeof createProcessManager).toBe('function');
  });
});

describe('spawn()', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('spawns a process and tracks PID in registry', () => {
    const pm = createProcessManager(root);
    const r = pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'test-sleep');
    expect(r.pid).toBeGreaterThan(0);
    expect(r.skipped).toBe(false);

    // Verify registry
    const registry = JSON.parse(readFileSync(join(root, '.moflo', 'background-pids.json'), 'utf-8'));
    expect(registry).toHaveLength(1);
    expect(registry[0].label).toBe('test-sleep');
    expect(registry[0].pid).toBe(r.pid);

    // Cleanup: kill the spawned process
    try { process.kill(r.pid!, 'SIGTERM'); } catch { /* ok */ }
  });

  it('deduplicates by label when process is still alive', () => {
    const pm = createProcessManager(root);
    const r1 = pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'dedup-test');
    expect(r1.skipped).toBe(false);

    // Spawn again with same label — should be skipped
    const r2 = pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'dedup-test');
    expect(r2.skipped).toBe(true);
    expect(r2.pid).toBe(r1.pid);

    // Cleanup
    try { process.kill(r1.pid!, 'SIGTERM'); } catch { /* ok */ }
  });

  it('allows respawn after previous process dies', async () => {
    const pm = createProcessManager(root);
    const r1 = pm.spawn('node', ['-e', 'process.exit(0)'], 'short-lived');

    // Poll getActive until the OS reaper clears the previous PID, then respawn.
    // Same fix as the `getActive returns only alive processes` test below —
    // any fixed sleep is wrong by construction (#672 leaked at 500 ms and 2 s).
    const deadline = Date.now() + 20000;
    while (pm.getActive().some(p => p.label === 'short-lived') && Date.now() < deadline) {
      await sleep(100);
    }
    const r2 = pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'short-lived');
    expect(r2.skipped).toBe(false);
    expect(r2.pid).not.toBe(r1.pid);

    // Cleanup
    try { process.kill(r2.pid!, 'SIGTERM'); } catch { /* ok */ }
  }, 30000);
});

describe('killAll()', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('kills all tracked processes and clears registry', () => {
    const pm = createProcessManager(root);
    pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'kill-a');
    pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'kill-b');

    const regBefore = JSON.parse(readFileSync(join(root, '.moflo', 'background-pids.json'), 'utf-8'));
    expect(regBefore).toHaveLength(2);

    const result = pm.killAll();
    expect(result.killed).toBe(2);

    // Registry should be empty
    const regAfter = JSON.parse(readFileSync(join(root, '.moflo', 'background-pids.json'), 'utf-8'));
    expect(regAfter).toHaveLength(0);
  });
});

describe('getActive() and prune()', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('getActive returns only alive processes', async () => {
    const pm = createProcessManager(root);
    pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'alive');
    pm.spawn('node', ['-e', 'process.exit(0)'], 'dead');

    // The OS reaper finishes whenever it finishes — on Windows under
    // isolation-batch load it can lag arbitrarily, so any fixed sleep
    // (#672 leaked at both 500 ms and 2 s) is wrong by construction.
    const deadline = Date.now() + 20000;
    let active = pm.getActive();
    while (active.some(p => p.label === 'dead') && Date.now() < deadline) {
      await sleep(100);
      active = pm.getActive();
    }
    expect(active.length).toBe(1);
    expect(active[0].label).toBe('alive');

    // Cleanup
    try { process.kill(active[0].pid, 'SIGTERM'); } catch { /* ok */ }
  }, 30000);

  it('prune removes dead entries', () => {
    // Seed registry with a fake dead PID
    writeFileSync(
      join(root, '.moflo', 'background-pids.json'),
      JSON.stringify([{ pid: 99999999, label: 'ghost', cmd: 'node -e ...', startedAt: new Date().toISOString() }]),
    );

    const pm = createProcessManager(root);
    const result = pm.prune();
    expect(result.pruned).toBe(1);
    expect(result.remaining).toBe(0);
  });

  it('getActive auto-prunes the file when stale entries are present (#634)', () => {
    // Seed registry with two dead PIDs and one live PID.
    writeFileSync(
      join(root, '.moflo', 'background-pids.json'),
      JSON.stringify([
        { pid: 99999998, label: 'ghost-a', cmd: 'node -e ...', startedAt: new Date().toISOString() },
        { pid: process.pid, label: 'parent-test', cmd: 'vitest', startedAt: new Date().toISOString() },
        { pid: 99999999, label: 'ghost-b', cmd: 'node -e ...', startedAt: new Date().toISOString() },
      ]),
    );

    const pm = createProcessManager(root);
    const active = pm.getActive();
    expect(active.length).toBe(1);
    expect(active[0].label).toBe('parent-test');

    // Critical assertion: the file on disk was rewritten with the live subset.
    // This proves we're not leaving stale entries to accumulate across sessions
    // when session-end didn't fire (abnormal termination).
    const onDisk = JSON.parse(readFileSync(join(root, '.moflo', 'background-pids.json'), 'utf-8'));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].label).toBe('parent-test');
  });
});

describe('lock guard', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('acquires and checks lock', () => {
    const pm = createProcessManager(root);
    const before = pm.isLocked();
    pm.acquireLock();
    const after = pm.isLocked();
    expect(before).toBe(false);
    expect(after).toBe(true);
  });

  it('lock expires after TTL (simulated by backdating mtime)', () => {
    // Write a lock file, then backdate its mtime by 60s
    const lockFile = join(root, '.moflo', 'spawn.lock');
    writeFileSync(lockFile, String(Date.now()));
    const past = new Date(Date.now() - 60000);
    utimesSync(lockFile, past, past);

    const pm = createProcessManager(root);
    expect(pm.isLocked()).toBe(false);
  });

  it('killAll releases the lock', () => {
    const pm = createProcessManager(root);
    pm.acquireLock();
    expect(existsSync(join(root, '.moflo', 'spawn.lock'))).toBe(true);

    pm.killAll();
    expect(existsSync(join(root, '.moflo', 'spawn.lock'))).toBe(false);
  });
});
