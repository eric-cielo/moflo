/**
 * Regression tests for #1317 — POSIX session-end must not orphan the in-flight
 * indexer step.
 *
 * `pm.killAll()` (bin/hooks.mjs session-end) tree-kills on Windows via
 * `taskkill /T` but used to send a bare single-PID `SIGTERM` on POSIX. Because
 * `index-all.mjs` puts every step in its OWN process group (`detached: true`),
 * that signal could never reach the running step — and `index-all` installed no
 * signal handler, so it died instantly and left the step (usually
 * `build-embeddings`, ~2 GB of fastembed/ONNX) reparented to init, still
 * burning CPU and still writing `.moflo/moflo.db` after the session had ended.
 *
 * This is the #744 failure class arriving through a different door: #744 fixed
 * `index-all`'s own *timeout* reaping; nothing reaped from the outside.
 *
 * The behavioural tests below are POSIX-only *by construction* — the bug is
 * defined by the platform split, and Windows has no real POSIX signal
 * semantics. Windows is covered by the source-invariant tests at the bottom
 * (which run everywhere) plus the existing `taskkill /T` assertions in
 * src/cli/__tests__/cross-platform.test.ts.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import { pathToFileURL } from 'url';

const REPO_ROOT = resolve(__dirname, '../..');
const INDEX_ALL = resolve(REPO_ROOT, 'bin/index-all.mjs');
const PM_PATH = resolve(REPO_ROOT, 'bin/lib/process-manager.mjs');

const isWindows = process.platform === 'win32';

const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `fn()` is true or the deadline passes. Never a fixed sleep. */
async function waitFor(fn: () => boolean, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}

function makeTempRoot(tag: string): string {
  const root = resolve(
    REPO_ROOT,
    '.testoutput',
    `.test-${tag}-` + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(join(root, '.moflo'), { recursive: true });
  return root;
}

function cleanTempRoot(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
}

// ---------------------------------------------------------------------------
// index-all.mjs reaps its in-flight step on SIGTERM
// ---------------------------------------------------------------------------

describe.skipIf(isWindows)('index-all.mjs reaps the in-flight step on SIGTERM (#1317)', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot('idxall-sig'); });
  afterEach(() => { cleanTempRoot(root); });

  /**
   * Build a temp project whose step plan resolves to exactly one long-running
   * step. `index-all` resolves each step via `resolveMofloBin`, which probes
   * `node_modules/moflo/bin/<script>` first — so planting a sleeper there gives
   * us a real step, spawned by the real orchestrator, in its own process group.
   *
   * Everything else is deliberately absent so the plan stays a single step:
   *   - no `node_modules/moflo/bin/cli.js` / `node_modules/.bin/flo` / `bin/cli.js`
   *     → `pretrain` and `hnsw-rebuild` are skipped (CLI not found)
   *   - no `build-embeddings.mjs` planted → skipped (script not found)
   *   - moflo.yaml disables every other indexer
   */
  function plantProject(pidFile: string) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tmp-1317', version: '0.0.0' }));
    writeFileSync(
      join(root, 'moflo.yaml'),
      [
        'auto_index:',
        '  guidance: true',
        '  code_map: false',
        '  tests: false',
        '  patterns: false',
        '  reference: false',
        '',
      ].join('\n'),
    );

    const binDir = join(root, 'node_modules', 'moflo', 'bin');
    mkdirSync(binDir, { recursive: true });
    // Stands in for build-embeddings: announces its PID, then runs long enough
    // that it is unambiguously mid-flight when the signal arrives.
    writeFileSync(
      join(binDir, 'index-guidance.mjs'),
      [
        `import { writeFileSync } from 'node:fs';`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        `setTimeout(() => {}, 120000);`,
        '',
      ].join('\n'),
    );
  }

  /**
   * `findProjectRoot()` honours CLAUDE_PROJECT_DIR ahead of any cwd walk, and
   * falls back to the topmost ancestor holding `.moflo/moflo.db` — which, for a
   * temp root nested under `.testoutput/`, is this repo. Both would point the
   * chain at the real project and run the real indexers. Pin it to the temp root.
   */
  function chainEnv() {
    return {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
      // Bypass the per-step fingerprint gate so the step always runs.
      FLO_FORCE_INDEX: '1',
    };
  }

  it('kills the step process rather than orphaning it', async () => {
    const pidFile = join(root, 'step.pid');
    plantProject(pidFile);

    const chain = spawn(process.execPath, [INDEX_ALL], {
      cwd: root,
      stdio: 'ignore',
      env: chainEnv(),
    });
    const chainPid = chain.pid!;
    expect(chainPid).toBeGreaterThan(0);

    // Wait until the step is genuinely in flight.
    const started = await waitFor(() => existsSync(pidFile));
    expect(started, 'planted step never started — plan resolution changed?').toBe(true);
    const stepPid = Number(readFileSync(pidFile, 'utf-8').trim());
    expect(stepPid).toBeGreaterThan(0);
    expect(isAlive(stepPid)).toBe(true);

    // Exactly what pm.killAll() does to the chain on session-end.
    process.kill(chainPid, 'SIGTERM');

    const chainDead = await waitFor(() => !isAlive(chainPid));
    expect(chainDead, 'index-all did not exit on SIGTERM').toBe(true);

    // THE REGRESSION: before #1317 this step survived, reparented to init, and
    // kept running for its full duration.
    const stepDead = await waitFor(() => !isAlive(stepPid));
    if (!stepDead) {
      try { process.kill(-stepPid, 'SIGKILL'); } catch { /* best effort */ }
      try { process.kill(stepPid, 'SIGKILL'); } catch { /* best effort */ }
    }
    expect(stepDead, `step ${stepPid} was orphaned by session-end SIGTERM`).toBe(true);
  }, 45000);

  /**
   * The literal acceptance criterion from #1317: the chain is mid-flight, the
   * session-end hook calls pm.killAll(), and no step process survives. The two
   * tests either side of this one cover the halves (index-all's own signal
   * reaping; killAll's group-kill); this one composes them through the real
   * session-end entry point, which is what consumers actually hit.
   */
  it('leaves no surviving step when pm.killAll() reaps a mid-flight chain', async () => {
    const pidFile = join(root, 'step.pid');
    plantProject(pidFile);

    const mod = await import(pathToFileURL(PM_PATH).href);
    const pm = mod.createProcessManager(root);

    // pm.spawn passes no env, so the chain would inherit this worker's
    // CLAUDE_PROJECT_DIR (the real repo). Point it at the temp root for the
    // duration of the spawn, exactly as the session-end hook's environment
    // would be pointed at the consumer's project.
    const prevRoot = process.env.CLAUDE_PROJECT_DIR;
    const prevForce = process.env.FLO_FORCE_INDEX;
    process.env.CLAUDE_PROJECT_DIR = root;
    process.env.FLO_FORCE_INDEX = '1';
    let spawned: { pid: number | null };
    try {
      spawned = pm.spawn(process.execPath, [INDEX_ALL], 'sequential indexing chain');
    } finally {
      if (prevRoot === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prevRoot;
      if (prevForce === undefined) delete process.env.FLO_FORCE_INDEX;
      else process.env.FLO_FORCE_INDEX = prevForce;
    }

    const chainPid = spawned.pid!;
    expect(chainPid).toBeGreaterThan(0);

    expect(await waitFor(() => existsSync(pidFile)), 'chain never reached a step').toBe(true);
    const stepPid = Number(readFileSync(pidFile, 'utf-8').trim());
    expect(isAlive(stepPid)).toBe(true);

    // The session-end call itself — bin/hooks.mjs:353.
    const result = pm.killAll();
    expect(result.killed).toBe(1);

    expect(await waitFor(() => !isAlive(chainPid)), 'chain survived killAll').toBe(true);

    const stepDead = await waitFor(() => !isAlive(stepPid));
    if (!stepDead) {
      try { process.kill(-stepPid, 'SIGKILL'); } catch { /* best effort */ }
      try { process.kill(stepPid, 'SIGKILL'); } catch { /* best effort */ }
    }
    expect(stepDead, `step ${stepPid} survived pm.killAll() — orphaned`).toBe(true);
  }, 45000);

  it('logs the reap so an orphan report is diagnosable', async () => {
    const pidFile = join(root, 'step.pid');
    plantProject(pidFile);

    const chain = spawn(process.execPath, [INDEX_ALL], {
      cwd: root,
      stdio: 'ignore',
      env: chainEnv(),
    });
    const chainPid = chain.pid!;

    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    const stepPid = Number(readFileSync(pidFile, 'utf-8').trim());

    process.kill(chainPid, 'SIGTERM');
    await waitFor(() => !isAlive(chainPid));
    await waitFor(() => !isAlive(stepPid));

    const logPath = join(root, '.moflo', 'logs', 'hooks.log');
    const logged = await waitFor(
      () => existsSync(logPath) && /SIGNAL SIGTERM/.test(readFileSync(logPath, 'utf-8')),
    );
    expect(logged, 'no SIGNAL line in hooks.log after reap').toBe(true);

    try { process.kill(stepPid, 'SIGKILL'); } catch { /* already gone */ }
  }, 45000);
});

// ---------------------------------------------------------------------------
// killAll() is a tree-kill on POSIX too
// ---------------------------------------------------------------------------

type CreateProcessManager = (root: string) => {
  spawn(cmd: string, args: string[], label: string): { pid: number | null; skipped: boolean };
  killAll(): { killed: number; total: number };
};

describe.skipIf(isWindows)('killAll() tree-kills on POSIX (#1317)', () => {
  let createProcessManager: CreateProcessManager;
  let root: string;

  beforeAll(async () => {
    const mod = await import(pathToFileURL(PM_PATH).href);
    createProcessManager = mod.createProcessManager as CreateProcessManager;
  });

  beforeEach(() => { root = makeTempRoot('pm-tree'); });
  afterEach(() => { cleanTempRoot(root); });

  it('kills children the tracked process left in its process group', async () => {
    const childPidFile = join(root, 'child.pid');
    const pm = createProcessManager(root);

    // pm.spawn is detached, so the tracked PID leads its own group. The
    // grandchild here is spawned NON-detached, so it stays in that group —
    // the case a bare single-PID SIGTERM silently missed.
    const parentSrc = [
      `const { spawn } = require('child_process');`,
      `const { writeFileSync } = require('fs');`,
      `const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore' });`,
      `writeFileSync(${JSON.stringify(childPidFile)}, String(c.pid));`,
      `setTimeout(() => {}, 120000);`,
    ].join('\n');

    const r = pm.spawn(process.execPath, ['-e', parentSrc], 'tree-kill-probe');
    expect(r.pid).toBeGreaterThan(0);

    expect(await waitFor(() => existsSync(childPidFile))).toBe(true);
    const childPid = Number(readFileSync(childPidFile, 'utf-8').trim());
    expect(isAlive(childPid)).toBe(true);

    const result = pm.killAll();
    expect(result.killed).toBe(1);

    expect(await waitFor(() => !isAlive(r.pid!)), 'tracked parent survived killAll').toBe(true);

    const childDead = await waitFor(() => !isAlive(childPid));
    if (!childDead) { try { process.kill(childPid, 'SIGKILL'); } catch { /* ok */ } }
    expect(childDead, `child ${childPid} orphaned by killAll`).toBe(true);
  }, 45000);

  it('falls back to a bare-PID kill for an entry that leads no process group', async () => {
    const pm = createProcessManager(root);

    // pm.spawn() is always detached, so a probe spawned through it would lead
    // its own group and the group-kill would succeed — never reaching the
    // fallback. Spawn NON-detached instead: the child stays in this process's
    // group and leads none of its own, which is the shape a registry entry
    // written by registerBackgroundPid() can have. Then register it by hand.
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore' });
    child.on('error', () => { /* ignore */ });
    child.unref();
    const pid = child.pid!;
    expect(pid).toBeGreaterThan(0);

    // Prove the premise rather than assuming it: no process group has this ID,
    // so killAll's `process.kill(-pid, ...)` is guaranteed to throw ESRCH.
    expect(() => process.kill(-pid, 0)).toThrow();

    writeFileSync(
      join(root, '.moflo', 'background-pids.json'),
      JSON.stringify([{
        pid,
        label: 'non-leader-probe',
        cmd: 'node -e setTimeout',
        startedAt: new Date().toISOString(),
      }]),
    );

    const result = pm.killAll();
    expect(result.killed).toBe(1);

    const dead = await waitFor(() => !isAlive(pid));
    if (!dead) { try { process.kill(pid, 'SIGKILL'); } catch { /* ok */ } }
    expect(dead, 'bare-PID fallback failed to reap a non-group-leader entry').toBe(true);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Source invariants — run on every platform, including Windows
// ---------------------------------------------------------------------------

describe('signal-reaping source invariants (#1317)', () => {
  const mirrors = [
    ['bin/index-all.mjs', resolve(REPO_ROOT, 'bin/index-all.mjs')],
    ['.claude/scripts/index-all.mjs', resolve(REPO_ROOT, '.claude/scripts/index-all.mjs')],
  ] as const;

  for (const [label, path] of mirrors) {
    it(`${label} wires killProcessTree to SIGTERM/SIGINT`, () => {
      const src = readFileSync(path, 'utf-8');
      expect(src).toContain('handleTerminationSignal');
      expect(src).toContain('killProcessTree(currentChild)');
      expect(src).toMatch(/for \(const sig of \['SIGTERM', 'SIGINT'\]\)/);
      // Windows-only console signal stays behind a platform guard (Rule #1).
      expect(src).toMatch(/platform\(\) === 'win32'[\s\S]{0,120}SIGBREAK/);
    });
  }

  const reapers = [
    ['bin/lib/process-manager.mjs', resolve(REPO_ROOT, 'bin/lib/process-manager.mjs'), 'entry.pid'],
    ['.claude/scripts/lib/process-manager.mjs', resolve(REPO_ROOT, '.claude/scripts/lib/process-manager.mjs'), 'entry.pid'],
    ['bin/lib/registry-cleanup.cjs', resolve(REPO_ROOT, 'bin/lib/registry-cleanup.cjs'), 'entries[i].pid'],
    ['.claude/scripts/lib/registry-cleanup.cjs', resolve(REPO_ROOT, '.claude/scripts/lib/registry-cleanup.cjs'), 'entries[i].pid'],
  ] as const;

  for (const [label, path, pidExpr] of reapers) {
    it(`${label} group-kills on POSIX with a bare-PID fallback`, () => {
      const src = readFileSync(path, 'utf-8');
      expect(src).toContain(`process.kill(-${pidExpr}, 'SIGTERM')`);
      expect(src).toContain(`process.kill(${pidExpr}, 'SIGTERM')`);
      // Windows tree-kill must be untouched.
      expect(src).toContain("'/T', '/F', '/PID'");
    });
  }
});
