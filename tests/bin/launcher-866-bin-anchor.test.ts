/**
 * Regression tests for issue #866 — stale-install repair races indexer chain
 * spawn, leaving an orphan running pre-upgrade argv.
 *
 * Symptom in the wild (motailz, 4.9.7 → 4.9.8 upgrade):
 *   - Launcher spawned `node .claude/scripts/index-all.mjs` from stale 4.9.7
 *     bytes (still has `--force`).
 *   - Section 3 sync overwrote `.claude/scripts/index-all.mjs` ~43 s later.
 *   - The already-detached chain kept running with the old `--force` argv,
 *     burning 4110 CPU-seconds re-embedding ~4000 rows the fingerprint gate
 *     (#858) would otherwise have skipped.
 *
 * Structural fix: anchor both the launcher's `hooks.mjs` spawn AND
 * hooks.mjs's `index-all.mjs` spawn on `node_modules/moflo/bin/` rather than
 * the `.claude/scripts/` mirror. The bin/ copy is updated atomically by
 * `npm install` (single-package, single-step), so it cannot be mid-overwrite
 * the way the synced mirror can during an upgrade session.
 *
 * Source-invariant tests pin the structural fix into the file so a future
 * "simplification" can't quietly regress it. Behavioural coverage already
 * exists in launcher-visibility.test.ts and session-start-embedding-race.test.ts;
 * this file is the cheap "did the fix actually land in source" gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const BIN = resolve(__dirname, '../../bin');

describe('bin/session-start-launcher.mjs §4 — anchor hooks.mjs spawn on npm bin (#866)', () => {
  const file = resolve(BIN, 'session-start-launcher.mjs');
  const src = readFileSync(file, 'utf-8');

  it('prefers node_modules/moflo/bin/hooks.mjs over the .claude/scripts/ mirror', () => {
    // The `hooksPkg`/`hooksMirror` pair must exist and the spawn target must
    // be the existsSync-gated preference of pkg over mirror. Mirrors the
    // existing `runMigrationsPkg`/`runMigrationsMirror` pattern immediately
    // below in the same section.
    expect(src).toMatch(/const\s+hooksPkg\s*=\s*resolve\(projectRoot,\s*['"]node_modules\/moflo\/bin\/hooks\.mjs['"]\)/);
    expect(src).toMatch(/const\s+hooksMirror\s*=\s*resolve\(projectRoot,\s*['"]\.claude\/scripts\/hooks\.mjs['"]\)/);
    expect(src).toMatch(/const\s+hooksScript\s*=\s*existsSync\(hooksPkg\)\s*\?\s*hooksPkg\s*:\s*hooksMirror/);
  });

  it('does NOT spawn hooks.mjs directly from the .claude/scripts mirror without a bin-pref guard', () => {
    // Pre-#866: `const hooksScript = resolve(projectRoot, '.claude/scripts/hooks.mjs');`
    // — a single-source path that races the section-3 sync. The fix must not
    // regress to that shape.
    expect(src).not.toMatch(/const\s+hooksScript\s*=\s*resolve\(projectRoot,\s*['"]\.claude\/scripts\/hooks\.mjs['"]\)\s*;/);
  });

  it('still spawns via fireAndForget so the launcher exits immediately', () => {
    // Sanity: don't accidentally make the spawn synchronous — the launcher
    // must return fast so Claude Code's SessionStart hook doesn't block.
    expect(src).toMatch(/fireAndForget\s*\(\s*['"]node['"]\s*,\s*\[\s*hooksScript\s*,\s*['"]session-start['"]\s*\]\s*,\s*['"]hooks session-start['"]\s*\)/);
  });
});

describe('bin/hooks.mjs session-start — anchor index-all.mjs spawn on npm bin (#866)', () => {
  const file = resolve(BIN, 'hooks.mjs');
  const src = readFileSync(file, 'utf-8');

  it('uses resolveBinOrLocal for the index-all.mjs spawn, not raw __dirname', () => {
    // Locate the session-start case body and assert on its spawn target.
    // Anchor on the case|default|close-brace boundary so this test can't
    // silently no-op if `session-start` ever becomes the last case.
    // Anchor on the `break;` that exits the case (rather than the next `case`
    // or any close brace) — `}` would match nested if/else closures, and the
    // next `case` would silently no-op if `session-start` ever became last.
    const sessionStart = src.match(/case 'session-start':\s*\{([\s\S]*?\n\s+break;)/);
    expect(sessionStart, 'session-start case must exist in hooks.mjs').toBeTruthy();
    const body = sessionStart![1];

    // Pre-#866 anti-pattern: `resolve(__dirname, 'index-all.mjs')` resolves to
    // .claude/scripts/index-all.mjs whenever hooks.mjs itself was loaded from
    // the synced mirror. Forbid the raw shape.
    expect(body).not.toMatch(/spawnWindowless\s*\(\s*['"]node['"]\s*,\s*\[\s*resolve\s*\(\s*__dirname\s*,\s*['"]index-all\.mjs['"]\s*\)\s*\]/);

    // Required shape: `resolveBinOrLocal('flo-index-all', 'index-all.mjs')`
    // — same helper hooks.mjs already uses for `index-guidance.mjs` (line ~474).
    expect(body).toMatch(/resolveBinOrLocal\s*\(\s*['"]flo-index-all['"]\s*,\s*['"]index-all\.mjs['"]\s*\)/);
    expect(body).toMatch(/spawnWindowless\s*\(\s*['"]node['"]\s*,\s*\[\s*indexAllScript\s*\]/);
  });

  it('logs a warning when index-all.mjs is unresolvable rather than silently no-op', () => {
    // log+advise: a missing chain script must surface (#854 posture). Prevents
    // a "session-start indexer never ran" silent failure.
    // Anchor on the `break;` that exits the case (rather than the next `case`
    // or any close brace) — `}` would match nested if/else closures, and the
    // next `case` would silently no-op if `session-start` ever became last.
    const sessionStart = src.match(/case 'session-start':\s*\{([\s\S]*?\n\s+break;)/);
    expect(sessionStart![1]).toMatch(/log\s*\(\s*['"]warn['"]\s*,\s*['"][^'"]*index-all\.mjs not found/);
  });

  it('resolveBinOrLocal still checks node_modules/moflo/bin before .claude/scripts', () => {
    // The helper itself is the load-bearing piece. Pin its bin-first ordering
    // so a future refactor can't silently flip the priority and reintroduce
    // the stale-mirror race.
    const helper = src.match(/function\s+resolveBinOrLocal\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
    expect(helper, 'resolveBinOrLocal helper must exist').toBeTruthy();
    const body = helper![0];

    const mofloIdx = body.indexOf("'node_modules/moflo/bin'");
    const mirrorIdx = body.indexOf("'.claude/scripts'");
    expect(mofloIdx).toBeGreaterThan(-1);
    expect(mirrorIdx).toBeGreaterThan(-1);
    expect(mofloIdx).toBeLessThan(mirrorIdx);
  });
});
