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

describe('bin/session-start-launcher.mjs — daemon version-skew detection (#1056, promoted to §2a)', () => {
  const file = resolve(BIN, 'session-start-launcher.mjs');
  const src = readFileSync(file, 'utf-8');

  it('compares installed moflo version against the daemon-lock version field', () => {
    // The §2a block reads installed version from node_modules/moflo/package.json
    // and daemon version from the lock, then uses semver-BEHIND comparison
    // (not just !==, so downgrade-test daemons ahead of installed are left
    // alone).
    expect(src).toMatch(/node_modules\/moflo\/package\.json/);
    // readFileSync takes (path, encoding) — outer JSON.parse(...).version.
    // The regex needs to tolerate the inner readFileSync close-paren before
    // matching the JSON.parse close + .version. Use [\s\S]*? to span the
    // nested calls non-greedily.
    expect(src).toMatch(/JSON\.parse\(\s*readFileSync\([\s\S]*?\)\s*\)\s*\.version/);
    expect(src).toMatch(/lock\?\.\s*version|lock\.version/);
    expect(src).toMatch(/compareVersionsSemver\(\s*daemonVersion\s*,\s*installedVersion\s*\)\s*<\s*0/);
  });

  it('fires the detached recycler on BEHIND via fireAndForget with a "daemon-behind-recycle" label', () => {
    // The §2a block hands the kill+wait+restart to bin/lib/daemon-recycler.mjs
    // detached so the launcher's foreground cost stays ~ms (within the 5000ms
    // SessionStart hook budget). The label is the named diagnosis doctor reads
    // via daemon-recycle.last.json.
    expect(src).toMatch(/fireAndForget\(\s*['"]node['"]\s*,\s*\[\s*recyclerPath/);
    expect(src).toMatch(/['"]daemon-behind-recycle['"]/);
  });

  it('emits a user-visible mutation message naming both versions', () => {
    // Per feedback_no_layered_workarounds — no silent catches. The emitMutation
    // call surfaces what changed via the launcher's stdout protocol to Claude.
    expect(src).toMatch(/emitMutation\(\s*['"]recycled stale daemon['"]/);
    expect(src).toMatch(/behind:\s*daemon\s+v\$\{observed\}/);
    expect(src).toMatch(/installed\s+v\$\{installedVersion\}/);
  });

  it('treats a missing version field as behind (pre-#1054 daemon)', () => {
    // Lock payloads written by daemons pre-version-publishing have no
    // version field. The §2a block treats `!daemonVersion` as behind
    // by construction, so they get recycled. Pin the fallback diagnosis
    // text so it stays user-comprehensible.
    expect(src).toMatch(/!daemonVersion\s*\|\|\s*compareVersionsSemver/);
    expect(src).toMatch(/<pre-1054 \/ unknown>/);
  });

  it('removes the pre-#1054 mtime-margin heuristic', () => {
    // The old check was a 5-second mtime margin — now eliminated by the
    // exact semver comparison. Per root-cause-discipline, no
    // belt-and-suspenders: the version check supersedes the margin.
    expect(src).not.toMatch(/STALE_DAEMON_MTIME_SKEW_MS/);
    expect(src).not.toMatch(/predates current install/);
  });

  it('uses semver-BEHIND (not !==) so ahead-of-installed daemons are left alone', () => {
    // Downgrade-testing scenario: developer pins moflo to an older version
    // while the running daemon is at a newer one. The recycle must be
    // one-way (BEHIND only) so the test daemon isn't killed.
    expect(src).toMatch(/compareVersionsSemver/);
    expect(src).not.toMatch(/daemonVersion\s*!==\s*installedVersion/);
  });

  it('surfaces version-check errors via emitWarning instead of silent catch', () => {
    // The §2a block is wrapped in try/catch; the catch must route through
    // emitWarning so a parse/I/O failure shows up in the launcher's
    // user-visible output (per #854 / feedback_no_layered_workarounds).
    expect(src).toMatch(
      /daemon-behind check failed[\s\S]{0,80}emitWarning|emitWarning[\s\S]{0,80}daemon-behind check failed/,
    );
  });

  it('§2a runs BEFORE §3 (placement invariant)', () => {
    // The whole point of the §2a promotion (#1054 follow-up) is to run the
    // version-skew check early so §3's heavy file-sync work can't starve
    // it out under the SessionStart hook timeout. Pin the source ordering.
    const s2aIdx = src.search(/daemon-behind-recycle/);
    const s3Idx = src.indexOf('// ── 3. Auto-sync scripts');
    expect(s2aIdx).toBeGreaterThan(-1);
    expect(s3Idx).toBeGreaterThan(-1);
    expect(s2aIdx).toBeLessThan(s3Idx);
  });
});
