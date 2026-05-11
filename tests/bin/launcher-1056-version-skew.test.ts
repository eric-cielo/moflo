/**
 * Regression tests for epic #1054 / story #1056 — daemon version-skew
 * detection in the SessionStart launcher.
 *
 * The pre-#1054 launcher used an mtime-margin heuristic to detect "stale"
 * daemons that survived an `npm install moflo@<new>`: compare the daemon
 * lock's `startedAt` to `node_modules/moflo/package.json`'s mtime, with a
 * 5-second clock-skew margin. This shipped 4.9.37 with two consumer-visible
 * regressions because a daemon launched JUST before npm rewrote package.json
 * passed the margin and kept running pre-upgrade code (#1054 case study).
 *
 * Post-#1054 the launcher reads the daemon lock's `version` field (added by
 * `acquireDaemonLock` in `src/cli/services/daemon-lock.ts`) and compares it
 * exactly to `node_modules/moflo/package.json`'s `version`. Missing version
 * — a pre-#1054 daemon — is treated as a mismatch by construction.
 *
 * These are source-invariant tests (cf. launcher-854-fixes.test.ts) — they
 * read the launcher and assert the structural invariants. End-to-end
 * coverage lives in tests/system/multi-process-write-visibility.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const BIN = resolve(__dirname, '../../bin');

describe('bin/session-start-launcher.mjs — daemon version-skew detection (#1056)', () => {
  const file = resolve(BIN, 'session-start-launcher.mjs');
  const src = readFileSync(file, 'utf-8');

  it('compares installed moflo version against the daemon-lock version field', () => {
    // The version-skew block reads version from both sides and compares them.
    expect(src).toMatch(/JSON\.parse\(readFileSync\(mofloPkgPathForRecycle[\s\S]{0,80}\)\.version/);
    expect(src).toMatch(/lock\?\.\s*version|lock\.version/);
    expect(src).toMatch(/daemonVersion\s*!==\s*installedVersion/);
  });

  it('recycles the daemon with a "daemon-version-skew" label on mismatch', () => {
    // The label is the named diagnosis — doctor's Daemon Version Skew check
    // (#1059) will consume the same name so users can correlate.
    expect(src).toMatch(/recycleDaemon\(\s*lockFile,\s*['"]daemon-version-skew['"]/);
  });

  it('emits a user-visible mutation message naming both versions', () => {
    // Per feedback_no_layered_workarounds — no silent catches. The emitMutation
    // call surfaces what changed via the launcher's stdout protocol to Claude.
    expect(src).toMatch(/emitMutation\(\s*['"]recycled stale daemon['"]/);
    expect(src).toMatch(/version skew/);
    expect(src).toMatch(/installed.*\$\{installedVersion\}/);
  });

  it('treats a missing version field as a mismatch (pre-#1054 daemon)', () => {
    // Lock payloads written by daemons pre-version-publishing have no
    // version field. The launcher must treat undefined !== installedVersion
    // as a mismatch (it naturally does — `undefined !== 'x.y.z'` is true).
    // Pin the fallback diagnosis text so it stays user-comprehensible.
    expect(src).toMatch(/<pre-1054 \/ unknown>/);
  });

  it('removes the pre-#1054 mtime-margin heuristic', () => {
    // The old check was a 5-second mtime margin — now eliminated by the
    // exact version comparison. Per root-cause-discipline, no
    // belt-and-suspenders: the version check supersedes the margin.
    expect(src).not.toMatch(/STALE_DAEMON_MTIME_SKEW_MS/);
    expect(src).not.toMatch(/predates current install/);
  });

  it('surfaces version-check errors via emitWarning instead of silent catch', () => {
    // The entire version-skew block is wrapped in try/catch; the catch must
    // route through emitWarning so a parse/I/O failure shows up in the
    // launcher's user-visible output (per #854 / feedback_no_layered_workarounds).
    expect(src).toMatch(
      /daemon version-skew check failed[\s\S]{0,80}emitWarning|emitWarning[\s\S]{0,80}daemon version-skew check failed/,
    );
  });
});
