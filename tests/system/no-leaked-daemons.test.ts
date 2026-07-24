/**
 * Regression guard: shelling out to the CLI from a test must not leak a daemon.
 *
 * `CLI.maybeAutoStartDaemon()` is gated on `daemon.auto_start`, which is `true`
 * in DEFAULT_CONFIG. A test that runs `bin/cli.js` inside a throwaway tmp
 * project has no `moflo.yaml` to say otherwise, so every invocation spawned a
 * `detached: true` + `unref()`'d daemon. When the test removed its tmp dir the
 * daemon survived holding a deleted cwd — permanently orphaned, because there
 * is no lockfile left to contend for and no project root to match it to. One
 * full suite run leaked several; across runs they accumulated into dozens of
 * ~87MB processes that only `doctor --fix` could reap (63 were found in one
 * dogfood session).
 *
 * `MOFLO_TEST_SKIP_DAEMON_AUTOSTART=1` (set in vitest.setup.ts, inherited by
 * subprocesses) closes it. This test proves the guard actually reaches the
 * spawned CLI rather than merely being set — the failure mode was precisely a
 * mitigation that looked present but never applied (the old comment in
 * worktree-durable-sharing-e2e.test.ts claimed MOFLO_DAEMON_PORT prevented the
 * spawn; it only steers write routing).
 *
 * POSIX-only assertions: counting live processes portably needs `ps`/`/proc`,
 * and the Windows tasklist chain is exactly what vitest.setup.ts disables
 * elsewhere for cost. The guard itself is platform-independent (a single env
 * check before any spawn), so covering it on POSIX is sufficient.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'bin', 'cli.js');
const POSIX = process.platform !== 'win32';
const CAN_RUN = POSIX && fs.existsSync(CLI);

/**
 * Count live daemons started from this repo's SOURCE tree. Session daemons run
 * from `node_modules/moflo/bin/cli.js`, so keying on the source path counts
 * only test-spawned ones and never touches the developer's real daemon.
 */
function sourceTreeDaemons(): number {
  const needle = path.join(REPO_ROOT, 'bin', 'cli.js');
  let out = '';
  try {
    out = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf-8' });
  } catch {
    return -1; // ps unavailable — caller skips
  }
  return out
    .split(/\r?\n/)
    .filter((l) => l.includes(needle) && l.includes('daemon') && l.includes('start'))
    // Exclude our own `ps` pipeline / shell, whose argv contains the needle.
    .filter((l) => !l.includes('-eo') && !l.includes('ps '))
    .length;
}

describe('no leaked daemons from CLI subprocesses', () => {
  it.skipIf(!CAN_RUN)('repeated `flo` calls in a throwaway project spawn no daemon', () => {
    const before = sourceTreeDaemons();
    if (before < 0) return; // no ps — nothing to assert

    const dir = fs.mkdtempSync(path.join(tmpdir(), 'no-leak-daemon-'));
    try {
      // No moflo.yaml here on purpose — that is the exact condition that made
      // DEFAULT_CONFIG's `auto_start: true` apply and leak.
      expect(fs.existsSync(path.join(dir, 'moflo.yaml'))).toBe(false);

      // Use a REAL subcommand, not `--version`: version/help short-circuit
      // before CLI init reaches maybeAutoStartDaemon, so probing with them
      // passes even with the guard removed. Verified by hand — `--version` in a
      // tmp project spawns nothing either way, while `memory list` spawns a
      // daemon with the guard cleared and none with it set.
      for (let i = 0; i < 3; i++) {
        try {
          execFileSync(process.execPath, [CLI, 'memory', 'list', '-n', 'learnings'], {
            cwd: dir,
            encoding: 'utf-8',
            env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 60_000,
          });
        } catch {
          /* exit code is irrelevant — we only care that nothing was spawned */
        }
      }

      // Autostart is fire-and-forget; give a spawn time to appear if it happened.
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1500)'], { timeout: 10_000 });

      expect(
        sourceTreeDaemons(),
        'a CLI subprocess spawned a daemon — MOFLO_TEST_SKIP_DAEMON_AUTOSTART is not reaching it',
      ).toBe(before);
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* best-effort */
      }
    }
  }, 120_000);

  it('vitest.setup.ts sets the guard, and the CLI honors it before any spawn', () => {
    // The env half.
    expect(process.env.MOFLO_TEST_SKIP_DAEMON_AUTOSTART).toBe('1');

    // The source half: the check must sit ahead of loadMofloConfig, or a repo
    // with `auto_start: true` would still spawn before reaching it.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'cli', 'index.ts'), 'utf-8');
    const fn = src.indexOf('private async maybeAutoStartDaemon');
    expect(fn, 'maybeAutoStartDaemon not found — did it get renamed?').toBeGreaterThan(-1);
    const body = src.slice(fn, fn + 2500);
    const guard = body.indexOf('MOFLO_TEST_SKIP_DAEMON_AUTOSTART');
    const cfg = body.indexOf('loadMofloConfig');
    expect(guard, 'autostart guard missing').toBeGreaterThan(-1);
    expect(guard, 'guard must precede the config read').toBeLessThan(cfg);
  });
});
