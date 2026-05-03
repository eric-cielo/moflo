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

  it('resolves hooks.mjs via the shared resolveMofloBin helper (bin-first by construction)', () => {
    // Post-#869: the inline pkg/mirror/script triple was lifted into
    // `bin/lib/resolve-bin.mjs`. The helper itself pins the bin-first
    // ordering — see tests/bin/resolve-bin.test.ts. Here we just assert the
    // launcher delegates to it for hooks.mjs.
    expect(src).toMatch(/const\s+hooksScript\s*=\s*resolveMofloBin\(\s*projectRoot\s*,\s*null\s*,\s*['"]hooks\.mjs['"]\s*\)/);
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
    // Anchor on the `break;` that exits the case — `}` would match nested
    // if/else closures inside the case, and `case '...'` would silently
    // no-op this test if `session-start` ever became the last case.
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
    const sessionStart = src.match(/case 'session-start':\s*\{([\s\S]*?\n\s+break;)/);
    expect(sessionStart![1]).toMatch(/log\s*\(\s*['"]warn['"]\s*,\s*['"][^'"]*index-all\.mjs not found/);
  });

  it('resolveBinOrLocal delegates to the shared resolveMofloBin helper', () => {
    // Post-#869: the per-file helper is now a thin wrapper that routes to
    // `bin/lib/resolve-bin.mjs`. Source-invariant pinning of the bin-first
    // ordering moved to tests/bin/resolve-bin.test.ts so it's tested once
    // at the load-bearing site, not duplicated per-callsite.
    const helper = src.match(/function\s+resolveBinOrLocal\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
    expect(helper, 'resolveBinOrLocal helper must exist').toBeTruthy();
    expect(helper![0]).toMatch(/return\s+resolveMofloBin\s*\(\s*projectRoot\s*,\s*binName\s*,\s*localScript\s*\)/);
  });
});
