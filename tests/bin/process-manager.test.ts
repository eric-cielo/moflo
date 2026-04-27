/**
 * Tests for bin/lib/process-manager.mjs
 *
 * Covers: spawn, dedup, killAll, getActive, prune, lock guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, utimesSync, mkdirSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { pathToFileURL } from 'url';
import { execFileSync } from 'child_process';

// We test via a small Node script that imports the ESM module,
// since vitest may run in CJS mode and can't directly import .mjs.
const BIN_LIB = resolve(__dirname, '../../bin/lib');
const PM_PATH = resolve(BIN_LIB, 'process-manager.mjs');

/** Create an isolated temp project root for each test. */
function makeTempRoot(): string {
  const root = resolve(__dirname, '../../.testoutput/.test-pm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(resolve(root, '.claude-flow'), { recursive: true });
  return root;
}

function cleanTempRoot(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
}

/** Run a snippet that imports process-manager.mjs and returns JSON output.
 *  Pass `timeout` when the snippet polls or otherwise needs more than 10s. */
function runPM(root: string, code: string, timeout = 10000): any {
  const pmURL = pathToFileURL(PM_PATH).href;
  const script = `
    import { createProcessManager } from '${pmURL}';
    const pm = createProcessManager('${root.replace(/\\/g, '/')}');
    const result = await (async () => { ${code} })();
    process.stdout.write(JSON.stringify(result));
  `;
  const out = execFileSync('node', ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    timeout,
    cwd: root,
  });
  return JSON.parse(out.trim());
}

describe('process-manager.mjs', () => {
  it('exists on disk', () => {
    expect(existsSync(PM_PATH)).toBe(true);
  });

  it('parses as valid ESM', () => {
    try {
      execFileSync('node', ['--check', PM_PATH], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      throw new Error(`Syntax error: ${err.stderr || err.message}`);
    }
  });
});

describe('spawn()', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('spawns a process and tracks PID in registry', () => {
    // Spawn a long-running sleep process
    const result = runPM(root, `
      const r = pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'test-sleep');
      return { pid: r.pid, skipped: r.skipped };
    `);
    expect(result.pid).toBeGreaterThan(0);
    expect(result.skipped).toBe(false);

    // Verify registry
    const registry = JSON.parse(readFileSync(join(root, '.claude-flow', 'background-pids.json'), 'utf-8'));
    expect(registry).toHaveLength(1);
    expect(registry[0].label).toBe('test-sleep');
    expect(registry[0].pid).toBe(result.pid);

    // Cleanup: kill the spawned process
    try { process.kill(result.pid, 'SIGTERM'); } catch { /* ok */ }
  });

  it('deduplicates by label when process is still alive', () => {
    // Spawn first
    const r1 = runPM(root, `
      const r = pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'dedup-test');
      return { pid: r.pid, skipped: r.skipped };
    `);
    expect(r1.skipped).toBe(false);

    // Spawn again with same label — should be skipped
    const r2 = runPM(root, `
      const r = pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'dedup-test');
      return { pid: r.pid, skipped: r.skipped };
    `);
    expect(r2.skipped).toBe(true);
    expect(r2.pid).toBe(r1.pid);

    // Cleanup
    try { process.kill(r1.pid, 'SIGTERM'); } catch { /* ok */ }
  });

  it('allows respawn after previous process dies', () => {
    // Spawn a process that exits immediately
    const r1 = runPM(root, `
      const r = pm.spawn('node', ['-e', 'process.exit(0)'], 'short-lived');
      return { pid: r.pid };
    `);

    // Wait a moment for it to exit
    try { execFileSync('node', ['-e', 'setTimeout(()=>{},500)'], { timeout: 2000 }); } catch { /* ok */ }

    // Respawn with same label should succeed (not skipped)
    const r2 = runPM(root, `
      const r = pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'short-lived');
      return { pid: r.pid, skipped: r.skipped };
    `);
    expect(r2.skipped).toBe(false);
    expect(r2.pid).not.toBe(r1.pid);

    // Cleanup
    try { process.kill(r2.pid, 'SIGTERM'); } catch { /* ok */ }
  });
});

describe('killAll()', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('kills all tracked processes and clears registry', () => {
    // Spawn two processes
    runPM(root, `
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'kill-a');
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'kill-b');
      return true;
    `);

    const regBefore = JSON.parse(readFileSync(join(root, '.claude-flow', 'background-pids.json'), 'utf-8'));
    expect(regBefore).toHaveLength(2);

    // Kill all
    const result = runPM(root, `return pm.killAll();`);
    expect(result.killed).toBe(2);

    // Registry should be empty
    const regAfter = JSON.parse(readFileSync(join(root, '.claude-flow', 'background-pids.json'), 'utf-8'));
    expect(regAfter).toHaveLength(0);
  });
});

describe('getActive() and prune()', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('getActive returns only alive processes', () => {
    // Spawn one that stays alive and one that exits
    runPM(root, `
      pm.spawn('node', ['-e', 'setTimeout(()=>{},60000)'], 'alive');
      pm.spawn('node', ['-e', 'process.exit(0)'], 'dead');
      return true;
    `);

    // The OS reaper finishes whenever it finishes — on Windows under
    // isolation-batch load it can lag arbitrarily, so any fixed sleep
    // (#672 leaked at both 500 ms and 2 s) is wrong by construction.
    const active = runPM(root, `
      const deadline = Date.now() + 20000;
      let active = pm.getActive();
      while (active.some((p) => p.label === 'dead') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        active = pm.getActive();
      }
      return active;
    `, 30000);
    expect(active.length).toBe(1);
    expect(active[0].label).toBe('alive');

    // Cleanup
    try { process.kill(active[0].pid, 'SIGTERM'); } catch { /* ok */ }
  });

  it('prune removes dead entries', () => {
    // Seed registry with a fake dead PID
    writeFileSync(
      join(root, '.claude-flow', 'background-pids.json'),
      JSON.stringify([{ pid: 99999999, label: 'ghost', cmd: 'node -e ...', startedAt: new Date().toISOString() }]),
    );

    const result = runPM(root, `return pm.prune();`);
    expect(result.pruned).toBe(1);
    expect(result.remaining).toBe(0);
  });

  it('getActive auto-prunes the file when stale entries are present (#634)', () => {
    // Seed registry with two dead PIDs and one live PID.
    writeFileSync(
      join(root, '.claude-flow', 'background-pids.json'),
      JSON.stringify([
        { pid: 99999998, label: 'ghost-a', cmd: 'node -e ...', startedAt: new Date().toISOString() },
        { pid: process.pid, label: 'parent-test', cmd: 'vitest', startedAt: new Date().toISOString() },
        { pid: 99999999, label: 'ghost-b', cmd: 'node -e ...', startedAt: new Date().toISOString() },
      ]),
    );

    const active = runPM(root, `return pm.getActive();`);
    expect(active.length).toBe(1);
    expect(active[0].label).toBe('parent-test');

    // Critical assertion: the file on disk was rewritten with the live subset.
    // This proves we're not leaving stale entries to accumulate across sessions
    // when session-end didn't fire (abnormal termination).
    const onDisk = JSON.parse(readFileSync(join(root, '.claude-flow', 'background-pids.json'), 'utf-8'));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].label).toBe('parent-test');
  });
});

describe('lock guard', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('acquires and checks lock', () => {
    const r1 = runPM(root, `
      const before = pm.isLocked();
      pm.acquireLock();
      const after = pm.isLocked();
      return { before, after };
    `);
    expect(r1.before).toBe(false);
    expect(r1.after).toBe(true);
  });

  it('lock expires after TTL (simulated by backdating mtime)', () => {
    // Write a lock file, then backdate its mtime by 60s
    const lockFile = join(root, '.claude-flow', 'spawn.lock');
    writeFileSync(lockFile, String(Date.now()));
    const past = new Date(Date.now() - 60000);
    utimesSync(lockFile, past, past);

    const result = runPM(root, `return pm.isLocked();`);
    expect(result).toBe(false);
  });

  it('killAll releases the lock', () => {
    runPM(root, `pm.acquireLock(); return true;`);
    expect(existsSync(join(root, '.claude-flow', 'spawn.lock'))).toBe(true);

    runPM(root, `pm.killAll(); return true;`);
    expect(existsSync(join(root, '.claude-flow', 'spawn.lock'))).toBe(false);
  });
});
