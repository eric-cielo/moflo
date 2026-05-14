/**
 * Source-invariant tests for the launcher's stopDaemon escalation pattern.
 *
 * Pre-fix behaviour: stopDaemon sent bare `process.kill(pid, 'SIGTERM')` on
 * every platform, then unconditionally unlinked the lockfile and returned
 * `stalePid !== null` regardless of whether the daemon actually died. On
 * Windows, `process.kill(pid, 'SIGTERM')` either silently force-kills or
 * fails entirely; in either case the catch swallowed the outcome and the
 * launcher reported success. If the daemon survived, it then re-wrote the
 * lockfile with its stale PID + pre-upgrade version, defeating the
 * section-3a-pre version-skew recovery (#1056) and leaving the statusline
 * stuck on `📊 ?` until manual `flo daemon restart`.
 *
 * Post-fix: escalation mirrors src/cli/commands/daemon.ts:killBackgroundDaemon
 * — graceful signal → 3s liveness poll → force kill → 1s OS-reap poll →
 * unlink only when the PID is confirmed dead.
 *
 * These are source-invariant tests (cf. launcher-1056-version-skew.test.ts) —
 * they read the launcher and assert the structural invariants. End-to-end
 * behavioural coverage lives in tests/system/launcher-version-skew-upgrade-
 * boundary.test.ts which exercises the recycle path under a real daemon.
 *
 * Both the source-of-truth copy (bin/) and the dogfood-synced copy
 * (.claude/scripts/) are verified to stay in lock-step.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const LAUNCHER_PATHS = [
  resolve(__dirname, '../../bin/session-start-launcher.mjs'),
  resolve(__dirname, '../../.claude/scripts/session-start-launcher.mjs'),
];

for (const launcherPath of LAUNCHER_PATHS) {
  const label = launcherPath.endsWith('.claude/scripts/session-start-launcher.mjs') ||
    launcherPath.endsWith('.claude\\scripts\\session-start-launcher.mjs')
    ? '.claude/scripts/session-start-launcher.mjs'
    : 'bin/session-start-launcher.mjs';

  describe(`${label} — stopDaemon escalation invariants`, () => {
    const src = readFileSync(launcherPath, 'utf-8');

    // Extract just the stopDaemon function (and its sibling helpers) so the
    // assertions below don't accidentally match unrelated code further down.
    const stopBlock = extractStopDaemonBlock(src);

    it('declares an EPERM-aware liveness check (foreign-owned daemons are alive)', () => {
      // The prior `catch { return false; }` falsely reported foreign-owned
      // processes as dead, letting the lockfile be unlinked under them.
      // Match: function isDaemonPidAlive ... err.code === 'EPERM'
      expect(src).toMatch(/function\s+isDaemonPidAlive\s*\(/);
      expect(src).toMatch(/err\?\.\s*code\s*===\s*['"]EPERM['"]|err\s*&&\s*err\.code\s*===\s*['"]EPERM['"]/);
    });

    it('uses Atomics.wait for sync sleep (no CPU spin)', () => {
      // Per feedback_async_by_default — sync waits must yield the thread at
      // the OS level, not busy-loop. Atomics.wait is the canonical primitive
      // (matches src/cli/shared/utils/atomic-file-write.ts:131).
      expect(src).toMatch(/Atomics\.wait\(/);
      expect(src).toMatch(/SharedArrayBuffer\(\s*4\s*\)/);
    });

    it('checks liveness before signalling — already-dead PIDs are clean', () => {
      // If the PID in the lockfile is already gone, we go straight to
      // unlinking. The escalation cost should only be paid when there's a
      // live process to kill.
      expect(stopBlock).toMatch(/isDaemonPidAlive\(\s*stalePid\s*\)/);
    });

    it('platform-split shutdown — Windows goes straight to /F /T (no graceful), Unix uses SIGTERM first', () => {
      // Pre-fix this test enforced a "Windows bare taskkill /PID first" step,
      // but `taskkill /PID` (no /F) on a headless Node daemon sends a window-
      // close message that a non-GUI process can't receive and always fails
      // with the visible 'process can only be terminated forcefully' error.
      // The graceful step was dead code that wasted up to 3s polling for
      // death-that-couldn't-happen — exactly what blew the 3000ms SessionStart
      // hook timeout and starved §3a-pre. Windows now goes straight to /F /T.
      //
      // Linux/macOS still get the graceful SIGTERM step because SIGTERM is a
      // real signal the daemon's shutdown handler can trap for a clean sql.js
      // flush before SIGKILL escalation.
      expect(stopBlock).toMatch(/process\.platform\s*===\s*['"]win32['"]/);
      // Windows: /F /T present, bare /PID (without /F) absent.
      expect(stopBlock).toMatch(/['"]\/F['"]\s*,\s*['"]\/T['"]\s*,\s*['"]\/PID['"]/);
      expect(stopBlock).not.toMatch(/execFileSync\(\s*['"]taskkill['"]\s*,\s*\[\s*['"]\/PID['"]/);
      // Unix: SIGTERM graceful step preserved.
      expect(stopBlock).toMatch(/process\.kill\(\s*stalePid\s*,\s*['"]SIGTERM['"]\s*\)/);
    });

    it('polls for death up to 3s after the Unix SIGTERM graceful signal', () => {
      // The daemon's shutdown handler does a final sql.js dump which under
      // load can take ~1s. 3s is the canonical budget on Unix where the
      // graceful signal actually works (mirrors killBackgroundDaemon's
      // 1s + retry cycle). Windows skips this poll entirely since there is
      // no graceful path.
      expect(stopBlock).toMatch(/Date\.now\(\)\s*\+\s*3000/);
      expect(stopBlock).toMatch(/while\s*\(\s*Date\.now\(\)\s*<\s*gracefulDeadline\s*\)/);
      expect(stopBlock).toMatch(/sleepSyncMs\(\s*100\s*\)/);
    });

    it('force-kills when graceful signal is ignored — taskkill /F /T on Windows, SIGKILL on Unix', () => {
      // /T kills the daemon's entire process tree (any spawned headless
      // workers go with it). On Unix, SIGKILL is uncatchable.
      expect(stopBlock).toMatch(/['"]\/F['"]\s*,\s*['"]\/T['"]\s*,\s*['"]\/PID['"]/);
      expect(stopBlock).toMatch(/process\.kill\(\s*stalePid\s*,\s*['"]SIGKILL['"]\s*\)/);
    });

    it('polls for OS-reap after force kill', () => {
      // SIGKILL/TerminateProcess is async at the OS level — the PID can
      // outlive the kill call by a few hundred ms during cleanup. Verify
      // we don't unlink the lockfile until the OS confirms the PID is gone.
      expect(stopBlock).toMatch(/forceDeadline/);
      expect(stopBlock).toMatch(/Date\.now\(\)\s*\+\s*1000/);
    });

    it('preserves the lockfile and returns false when the daemon survives both signals', () => {
      // This is the load-bearing new invariant. Unlinking the lockfile under
      // a surviving daemon was the bug — the daemon would re-write the lock
      // with its stale PID, perpetuating the version-skew loop. Now we leave
      // the lockfile so the next session can re-attempt.
      expect(stopBlock).toMatch(/if\s*\(\s*!killed\s*\)\s*\{[\s\S]*?emitWarning[\s\S]*?return\s+false/);
    });

    it('surfaces the survival case via emitWarning, not silent catch', () => {
      // Per feedback_no_layered_workarounds — no silent failure paths. The
      // user must see when the daemon refused to die so they can intervene.
      expect(stopBlock).toMatch(/emitWarning\([^)]*stopDaemon/);
      expect(stopBlock).toMatch(/did not exit|survived/);
    });

    it('only unlinks the lockfile after confirming the PID is dead', () => {
      // The unlinkSync call must live BELOW the survival-check return — if a
      // future refactor moves it above, the bug regresses. Lockfile preservation
      // depends on this ordering.
      const survivalReturn = stopBlock.search(/emitWarning\([^)]*stopDaemon[\s\S]*?return\s+false/);
      const unlinkIdx = stopBlock.indexOf('unlinkSync(lockFile)');
      expect(survivalReturn).toBeGreaterThan(-1);
      expect(unlinkIdx).toBeGreaterThan(survivalReturn);
    });

    it('does not regress to the pre-fix bare process.kill SIGTERM pattern', () => {
      // The pre-fix line was: `try { process.kill(stalePid, 'SIGTERM'); } catch { /* already dead */ }`
      // followed immediately by `try { unlinkSync(lockFile); }`. Pin against
      // that exact shape so a future "simplification" cannot reintroduce it.
      expect(stopBlock).not.toMatch(
        /try\s*\{\s*process\.kill\(\s*stalePid\s*,\s*['"]SIGTERM['"]\s*\)\s*;?\s*\}\s*catch\s*\{[^}]*\}\s*\}\s*try\s*\{\s*unlinkSync/,
      );
    });
  });
}

/**
 * Both copies of the launcher must stay byte-identical at the stopDaemon
 * function — they're synced by `bin/lib/file-sync.mjs` and any drift breaks
 * the dogfood loop. (See feedback_eldar_dogfood_guidance_layout — root and
 * shipped/ both check in.)
 */
describe('launcher stopDaemon — synced copies stay in lock-step', () => {
  it('bin/ and .claude/scripts/ copies share the same stopDaemon block', () => {
    const binSrc = readFileSync(LAUNCHER_PATHS[0], 'utf-8');
    const dogSrc = readFileSync(LAUNCHER_PATHS[1], 'utf-8');
    expect(extractStopDaemonBlock(binSrc)).toEqual(extractStopDaemonBlock(dogSrc));
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the stopDaemon function body plus its sibling helpers
 * (sleepSyncMs, isDaemonPidAlive). Bracket-counts so we don't accidentally
 * match unrelated code further down the file. Returns the trimmed slice.
 */
function extractStopDaemonBlock(src: string): string {
  // Start at the sleep buffer declaration — it's the first thing in the
  // stopDaemon helper cluster.
  const startMarker = 'const STOP_SLEEP_BUF';
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`stopDaemon helper cluster not found (missing ${startMarker})`);
  }

  // End at recycleDaemon — the function that follows stopDaemon.
  const endMarker = 'function recycleDaemon';
  const endIdx = src.indexOf(endMarker, startIdx);
  if (endIdx === -1) {
    throw new Error('recycleDaemon end-marker not found after stopDaemon');
  }

  return src.slice(startIdx, endIdx).trim();
}
