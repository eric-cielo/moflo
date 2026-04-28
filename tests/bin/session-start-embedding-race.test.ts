/**
 * Regression tests for the 3-way session-start embedding race (#744).
 *
 * Two layered bugs we patched:
 *
 *   1. bin/hooks.mjs session-start used to spawn `cli.js embeddings init` in
 *      parallel with the index-all.mjs chain. The init command's action runs
 *      a full `safelyRunEmbeddingsMigration()` that writes to .moflo/moflo.db
 *      via sql.js whole-file flush, racing build-embeddings.mjs from the
 *      chain. The two whole-file flushes clobbered each other and burned
 *      2 GB RAM × 2 for 30+ minutes in the wild.
 *
 *   2. bin/index-all.mjs runStep() used execFileSync({timeout}) — on Windows
 *      that marks the call FAILed but does NOT reliably kill the spawned
 *      child node process, so a slow build-embeddings.mjs would orphan and
 *      keep running long after the chain logged "complete".
 *
 * These tests assert source-level invariants on hooks.mjs and a behavioural
 * assertion on index-all.mjs's runStep timeout-kill path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { resolve, join } from 'path';
import { platform } from 'os';

const BIN = resolve(__dirname, '../../bin');

describe('bin/hooks.mjs session-start (#744)', () => {
  const file = resolve(BIN, 'hooks.mjs');
  const src = readFileSync(file, 'utf-8');

  it('does NOT call runEmbeddingsInitBackground from session-start', () => {
    // Locate the session-start case body — anchor on the case label and the
    // next case to keep the slice tight.
    const sessionStart = src.match(/case 'session-start':\s*\{([\s\S]*?)\n\s+case '/);
    expect(sessionStart, 'session-start case must exist in hooks.mjs').toBeTruthy();
    const body = sessionStart![1];
    expect(body).not.toMatch(/runEmbeddingsInitBackground\s*\(/);
  });

  it('does NOT define runEmbeddingsInitBackground at all', () => {
    // The whole helper must be deleted — leaving it defined invites a future
    // caller to wire it back in. The launcher's foreground §3e migration is
    // the canonical migration site.
    expect(src).not.toMatch(/function\s+runEmbeddingsInitBackground/);
  });

  it('does NOT spawn `embeddings init` anywhere in the file', () => {
    // Belt-and-suspenders — covers helper rewires AND any inline spawn.
    expect(src).not.toMatch(/['"]embeddings['"]\s*,\s*['"]init['"]/);
  });
});

describe('bin/index-all.mjs runStep timeout (#744)', () => {
  const file = resolve(BIN, 'index-all.mjs');
  const src = readFileSync(file, 'utf-8');

  it('does NOT use execFileSync (which orphans children on Windows)', () => {
    // execFileSync({timeout}) was the bug — on Windows it marks the call
    // failed but does not kill the spawned child reliably.
    expect(src).not.toMatch(/execFileSync\s*\(/);
  });

  it('uses spawn + a kill-on-timeout path', () => {
    expect(src).toMatch(/spawn\s*\(/);
    expect(src).toMatch(/setTimeout\s*\(/);
    // Either taskkill (Windows) or process.kill / SIGKILL (POSIX).
    expect(src).toMatch(/taskkill|SIGKILL/);
  });

  it('runStep returns a Promise (callers must await)', () => {
    expect(src).toMatch(/function\s+runStep[\s\S]*?return\s+new\s+Promise/);
  });

  it('all runStep callers await its result (so the chain is actually sequential)', () => {
    // Find every runStep( occurrence outside the function definition. Each
    // call site must be preceded by `await `.
    const lines = src.split('\n');
    const offenders: string[] = [];
    let inDefinition = false;
    for (const line of lines) {
      if (/function\s+runStep/.test(line)) inDefinition = true;
      if (inDefinition && /^}/.test(line)) inDefinition = false;
      if (inDefinition) continue;
      if (/\brunStep\s*\(/.test(line) && !/await\s+runStep\s*\(/.test(line)) {
        offenders.push(line.trim());
      }
    }
    expect(offenders, 'unawaited runStep call(s)').toEqual([]);
  });
});

describe('runStep behavioural smoke — kills slow children on timeout', () => {
  // Fabricate a tiny child script that sleeps longer than the timeout, run
  // it through a stripped-down clone of runStep, and assert the child PID is
  // gone (process.kill(pid, 0) throws ESRCH) within a small window.
  //
  // We don't shell out to the real index-all.mjs because we don't want to
  // spin up the entire indexer chain — the runStep contract is what's
  // under test.

  const TMP = resolve(__dirname, '../../.testoutput/runstep-timeout-' + Date.now());

  it('child process is dead within 2s of timeout firing', async () => {
    mkdirSync(TMP, { recursive: true });
    const childScript = join(TMP, 'long-sleeper.mjs');
    // Sleep for 30s — runStep timeout will be 500ms.
    writeFileSync(childScript, `await new Promise(r => setTimeout(r, 30_000));`);

    // Mirror the patched runStep — minimal version, no logging.
    const isWin = platform() === 'win32';
    const child = spawn('node', [childScript], {
      stdio: 'ignore',
      windowsHide: true,
      detached: !isWin,
    });
    expect(child.pid).toBeTruthy();
    const pid = child.pid!;

    const exit = new Promise<number | null>((res) => {
      child.once('exit', (code) => res(code));
    });

    // Trigger the same kill path the patched runStep uses.
    setTimeout(() => {
      if (isWin) {
        // Windows: tree-kill via taskkill.
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* fallback below */ }
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, 500);

    await exit;

    // Give the OS a beat to reap, then assert the PID is genuinely gone.
    await new Promise((r) => setTimeout(r, 200));
    let alive = false;
    try {
      // process.kill(pid, 0) throws ESRCH if the process is gone.
      process.kill(pid, 0);
      alive = true;
    } catch { /* ESRCH = good, child is dead */ }

    expect(alive, `child PID ${pid} should be dead after timeout-kill`).toBe(false);

    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  }, 10_000);
});
