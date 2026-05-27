/**
 * Regression tests for issue #896 — launcher must heal stale hook entries
 * (extras), not just add missing ones, when `auto_update.hook_block_drift:
 * regenerate` is set.
 *
 * Symptom in the wild: consumers carrying the `gate.cjs session-reset`
 * SessionStart hook from before #842 were stuck on a `flo doctor --strict`
 * Hook Block Drift warning. The launcher honoured `regenerate` mode only on
 * the purely-additive path (`report.extra.length === 0`); when extras existed
 * (the actual repro), it fell back to warn and the consumer couldn't self-heal.
 *
 * These are source-invariant tests so a future "simplification" can't drop
 * the wholesale-preferred path and silently re-introduce the hang. End-to-end
 * coverage of the regeneration helpers themselves lives in
 * `src/cli/__tests__/services/hook-block-hash.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');

describe.each([
  ['bin/session-start-launcher.mjs', resolve(ROOT, 'bin', 'session-start-launcher.mjs')],
  ['.claude/scripts/session-start-launcher.mjs', resolve(ROOT, '.claude', 'scripts', 'session-start-launcher.mjs')],
])('%s — hook-block drift regenerate (#896)', (_label, file) => {
  const src = readFileSync(file, 'utf-8');

  it('prefers applyWholesaleRegeneration when the export is available', () => {
    // The whole point of #896: wholesale must be the primary path so stale
    // extras (gate.cjs session-reset, etc.) get dropped instead of preserved.
    expect(src).toMatch(/applyWholesaleRegeneration/);
    // Specifically: the wholesale-availability check must precede the
    // additive fallback.
    const idxWholesale = src.indexOf('applyWholesaleRegeneration');
    const idxAdditive = src.indexOf('applyAdditiveRegeneration');
    expect(idxWholesale).toBeGreaterThan(0);
    expect(idxAdditive).toBeGreaterThan(0);
    expect(idxWholesale, 'wholesale must be checked before additive').toBeLessThan(idxAdditive);
  });

  it('drops the report.extra.length === 0 guard from the wholesale branch', () => {
    // Pre-#896: `safeToRegenerate = wantRegenerate && report.extra.length === 0`
    // was the bug — extras (the repro case) made regenerate a no-op. The
    // wholesale path must NOT be gated on extras count. We pin the gating
    // shape so a refactor can't reintroduce the guard.
    const wholesaleLine = src.match(/const\s+wholesale\s*=\s*[^;]+;/);
    expect(wholesaleLine, 'wholesale gate must exist').toBeTruthy();
    expect(wholesaleLine![0]).toMatch(/wantRegenerate/);
    expect(wholesaleLine![0]).toMatch(/applyWholesaleRegeneration/);
    expect(wholesaleLine![0]).not.toMatch(/extra\.length/);
  });

  it('still respects the locked sentinel before any regeneration', () => {
    // Defence-in-depth: the locked: true opt-out is the user's documented
    // way to suppress drift surfacing. Wholesale regeneration must not run
    // before the locked check. Match the actual call sites (`mod.X(`) rather
    // than the bareword so a docstring mentioning the function name earlier
    // in the file (e.g. the #1227 default-mode comment) can't false-positive.
    const idxLockedCall = src.indexOf('mod.isHookBlockLocked(');
    const idxRegenCall = src.indexOf('mod.applyWholesaleRegeneration(');
    expect(idxLockedCall, 'mod.isHookBlockLocked( must be invoked').toBeGreaterThan(0);
    expect(idxRegenCall, 'mod.applyWholesaleRegeneration( must be invoked').toBeGreaterThan(0);
    expect(idxLockedCall, 'lock check must run before regeneration').toBeLessThan(idxRegenCall);
  });

  it('emits a mutation message naming both added and removed counts', () => {
    // Without removed counts the user sees `added 0 missing entries` for the
    // pure-extras case (e.g. only `gate.cjs session-reset` to remove) and
    // can't tell anything happened. Pin the shape.
    expect(src).toMatch(/removed\s+\$\{plural\(removed,\s*'stale entry'\)\}/);
    expect(src).toMatch(/added\s+\$\{plural\(added,\s*'missing entry'\)\}/);
  });
});
