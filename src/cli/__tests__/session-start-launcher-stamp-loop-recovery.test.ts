/**
 * Launcher recovery from the indefinite version-stamp re-detect loop (#1173).
 *
 * Two related defenses are exercised:
 *
 *   - Option B (eager-stamp recovery, lines ~736 in session-start-launcher.mjs)
 *     If a prior session reached §3f and wrote upgrade-notice.json with
 *     status='completed' + to=<installedVersion> but was killed before §3g
 *     committed the version stamp, the next launcher detects the same
 *     "upgrade pending" condition and re-runs the full upgrade work
 *     indefinitely. Option B reads the prior notice at §0-pre, and when it
 *     matches the installed version writes the stamp eagerly + skips the
 *     upgrade work block.
 *
 *   - Option D (exit-handler guard for in-progress notice, §0-pre + §3f)
 *     process.on('exit') drops the in-progress notice if the launcher aborts
 *     before §3f. §3f sets `upgradeNoticeFinalized = true` so the handler does
 *     NOT delete the short-TTL 'completed' notice on a clean exit. This test
 *     verifies the negative branch (finalized=true → notice survives); the
 *     positive branch (abort mid-flight → notice cleared) is covered by the
 *     defense's eyeball-simple wiring (one bool flag + one exit handler) and
 *     would require flaky SIGTERM-timing tests to exercise end-to-end.
 *
 * Fixture is the minimal-non-dogfood shape used by
 * session-start-launcher-daemon-behind.test.ts.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findRepoRoot } from './_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const LAUNCHER = join(REPO_ROOT, 'bin', 'session-start-launcher.mjs');

interface Fixture {
  stamp: string;
  installed: string;
  priorNotice?: { status: 'completed' | 'in-progress'; kind: string; from: string | null; to: string };
}

function makeConsumer(opts: Fixture): string {
  const tmp = mkdtempSync(join(tmpdir(), 'moflo-stamp-loop-'));
  mkdirSync(join(tmp, '.claude'), { recursive: true });
  mkdirSync(join(tmp, '.moflo'), { recursive: true });
  mkdirSync(join(tmp, 'node_modules', 'moflo', 'bin'), { recursive: true });

  writeFileSync(
    join(tmp, 'package.json'),
    JSON.stringify({ name: 'stamp-loop-fixture', version: '0.0.0' }, null, 2),
  );
  writeFileSync(
    join(tmp, 'node_modules', 'moflo', 'package.json'),
    JSON.stringify({ name: 'moflo', version: opts.installed }, null, 2),
  );
  writeFileSync(join(tmp, '.moflo', 'moflo-version'), opts.stamp);
  // Stub cli.js so any fire-and-forget spawn the launcher does exits fast.
  writeFileSync(join(tmp, 'node_modules', 'moflo', 'bin', 'cli.js'), 'process.exit(0);\n');

  if (opts.priorNotice) {
    const now = Date.now();
    writeFileSync(
      join(tmp, '.moflo', 'upgrade-notice.json'),
      JSON.stringify({
        ...opts.priorNotice,
        at: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        changes: 0,
      }),
    );
  }
  return tmp;
}

function rmConsumerWithRetry(root: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { rmSync(root, { recursive: true, force: true }); return; } catch {
      const deadline = Date.now() + 100;
      while (Date.now() < deadline) { /* spin */ }
    }
  }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function runLauncher(cwd: string) {
  return spawnSync('node', [LAUNCHER], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: {
      ...process.env,
      CI: '1',
      CLAUDE_PROJECT_DIR: cwd,
    },
    input: '',
  });
}

describe('launcher #1173 — version-stamp loop recovery', () => {
  let consumerRoot: string;

  afterEach(() => {
    if (consumerRoot) rmConsumerWithRetry(consumerRoot);
  });

  it('Option B: eager-stamps when prior notice shows completed for installedVersion', () => {
    consumerRoot = makeConsumer({
      stamp: '4.10.5',
      installed: '4.10.12',
      priorNotice: { status: 'completed', kind: 'upgrade', from: '4.10.5', to: '4.10.12' },
    });

    const result = runLauncher(consumerRoot);
    expect(result.status, `launcher stderr: ${result.stderr}`).toBe(0);

    expect(readFileSync(join(consumerRoot, '.moflo', 'moflo-version'), 'utf-8')).toBe('4.10.12');
    expect(result.stdout).toMatch(/recovered version stamp at 4\.10\.12/);
    expect(result.stdout).toMatch(/#1173/);
  });

  it('Option B: falls through to full upgrade when prior notice is for a different version', () => {
    consumerRoot = makeConsumer({
      stamp: '4.10.5',
      installed: '4.10.13',
      priorNotice: { status: 'completed', kind: 'upgrade', from: '4.10.5', to: '4.10.12' },
    });

    const result = runLauncher(consumerRoot);
    expect(result.status, `launcher stderr: ${result.stderr}`).toBe(0);

    // Stamp should land at the newly-installed version, not at the stale notice.to.
    expect(readFileSync(join(consumerRoot, '.moflo', 'moflo-version'), 'utf-8')).toBe('4.10.13');
    // Full upgrade ran — emit recognisable from the normal upgrade path.
    expect(result.stdout).toMatch(/upgraded/);
    expect(result.stdout).not.toMatch(/recovered version stamp/);
  });

  it('Option B: falls through to full upgrade when prior notice is in-progress (not completed)', () => {
    consumerRoot = makeConsumer({
      stamp: '4.10.5',
      installed: '4.10.12',
      priorNotice: { status: 'in-progress', kind: 'upgrade', from: '4.10.5', to: '4.10.12' },
    });

    const result = runLauncher(consumerRoot);
    expect(result.status, `launcher stderr: ${result.stderr}`).toBe(0);

    expect(readFileSync(join(consumerRoot, '.moflo', 'moflo-version'), 'utf-8')).toBe('4.10.12');
    expect(result.stdout).toMatch(/upgraded/);
    expect(result.stdout).not.toMatch(/recovered version stamp/);
  });

  it('Option B: runs normal upgrade when no prior notice exists (no recovery signal)', () => {
    consumerRoot = makeConsumer({ stamp: '4.10.5', installed: '4.10.12' });

    const result = runLauncher(consumerRoot);
    expect(result.status, `launcher stderr: ${result.stderr}`).toBe(0);

    expect(readFileSync(join(consumerRoot, '.moflo', 'moflo-version'), 'utf-8')).toBe('4.10.12');
    expect(result.stdout).not.toMatch(/recovered version stamp/);
  });

  it('Option D guard: completed notice survives a clean exit (upgradeNoticeFinalized prevents cleanup)', () => {
    // If §3f sets upgradeNoticeFinalized=true correctly, the process.on('exit')
    // handler skips the unlink branch and the short-TTL 'completed' notice
    // remains on disk for the statusline to render. If the wiring is wrong,
    // the exit handler would delete the file we just wrote.
    consumerRoot = makeConsumer({ stamp: '4.10.5', installed: '4.10.12' });

    const result = runLauncher(consumerRoot);
    expect(result.status, `launcher stderr: ${result.stderr}`).toBe(0);

    const noticePath = join(consumerRoot, '.moflo', 'upgrade-notice.json');
    expect(existsSync(noticePath)).toBe(true);
    const notice = JSON.parse(readFileSync(noticePath, 'utf-8'));
    expect(notice.status).toBe('completed');
    expect(notice.to).toBe('4.10.12');
  });

  // Regression guard for the BLOCKING quality finding on the original Option D
  // patch: a comment-only "covers SIGTERM" claim left the primary failure mode
  // (5s SessionStart hook-timeout SIGTERM on POSIX) uncovered, because POSIX
  // SIGTERM kills without firing process.on('exit'). Explicit SIGTERM + SIGINT
  // handlers are required. This source-shape test catches accidental removal
  // of those handlers; a true SIGTERM-cleanup behavior test was deemed too
  // platform-flaky (Windows TerminateProcess doesn't run any Node handler;
  // POSIX timing of the spawn → in-progress write → SIGTERM window is racy).
  it('Option D wiring: SIGTERM + SIGINT handlers are registered for cleanup coverage', () => {
    const launcherSrc = readFileSync(LAUNCHER, 'utf-8');
    expect(launcherSrc).toMatch(/process\.on\('SIGTERM',/);
    expect(launcherSrc).toMatch(/process\.on\('SIGINT',/);
    // Both must invoke the shared cleanup before exiting.
    expect(launcherSrc).toMatch(/clearAbortedUpgradeNotice\(\);\s*process\.exit\(143\)/);
    expect(launcherSrc).toMatch(/clearAbortedUpgradeNotice\(\);\s*process\.exit\(130\)/);
  });
});
