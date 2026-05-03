/**
 * Tests for `bin/lib/resolve-bin.mjs` — shared moflo bin-script resolver.
 *
 * Two halves:
 *
 * 1. Source-invariant pinning (cheap, no FS):
 *    The candidate-list ordering MUST stay bin-first to keep the #866 fix
 *    working. A future "simplification" that puts `.claude/scripts/` ahead of
 *    `node_modules/moflo/bin/` reintroduces the upgrade-session race that
 *    paid for #866 in real consumer time. The `mofloBinCandidates` pure
 *    function is exported precisely so this test can assert ordering without
 *    spinning up real fixtures.
 *
 * 2. Behavioural coverage (mkdtemp + touch files):
 *    Each candidate slot exercised independently — pkg, .bin alias, mirror,
 *    dev fallback. Verifies the existsSync gate picks the highest-priority
 *    available file and that includeDevFallback is opt-in.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { resolveMofloBin, mofloBinCandidates } from '../../bin/lib/resolve-bin.mjs';

describe('mofloBinCandidates — bin-first ordering invariant (#866 / #869)', () => {
  it('lists node_modules/moflo/bin before the .claude/scripts mirror', () => {
    const cands = mofloBinCandidates('/project', 'flo-index', 'index-guidance.mjs');
    const pkgIdx = cands.findIndex(c => c.includes(join('node_modules', 'moflo', 'bin')));
    const mirrorIdx = cands.findIndex(c => c.includes(join('.claude', 'scripts')));
    expect(pkgIdx).toBeGreaterThanOrEqual(0);
    expect(mirrorIdx).toBeGreaterThanOrEqual(0);
    expect(pkgIdx).toBeLessThan(mirrorIdx);
  });

  it('places node_modules/.bin alias between pkg and mirror', () => {
    const cands = mofloBinCandidates('/project', 'flo-index', 'index-guidance.mjs');
    const pkgIdx = cands.findIndex(c => c.includes(join('node_modules', 'moflo', 'bin')));
    const npmBinIdx = cands.findIndex(c => c.includes(join('node_modules', '.bin')));
    const mirrorIdx = cands.findIndex(c => c.includes(join('.claude', 'scripts')));
    expect(pkgIdx).toBeLessThan(npmBinIdx);
    expect(npmBinIdx).toBeLessThan(mirrorIdx);
  });

  it('omits the .bin slot when binName is null', () => {
    const cands = mofloBinCandidates('/project', null, 'hooks.mjs');
    expect(cands.some(c => c.includes(join('node_modules', '.bin')))).toBe(false);
    expect(cands.some(c => c.includes(join('node_modules', 'moflo', 'bin')))).toBe(true);
    expect(cands.some(c => c.includes(join('.claude', 'scripts')))).toBe(true);
  });

  it('appends dev fallback only when includeDevFallback is true', () => {
    const without = mofloBinCandidates('/project', 'flo-index', 'index-guidance.mjs');
    const withDev = mofloBinCandidates('/project', 'flo-index', 'index-guidance.mjs', { includeDevFallback: true });
    expect(without.length).toBe(withDev.length - 1);
    expect(withDev[withDev.length - 1]).toBe(resolve('/project', 'bin', 'index-guidance.mjs'));
    expect(without.some(c => c === resolve('/project', 'bin', 'index-guidance.mjs'))).toBe(false);
  });
});

describe('resolveMofloBin — picks highest-priority existing candidate', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'moflo-resolve-bin-'));
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows file-lock tolerance */ }
  });

  function touch(rel: string) {
    const abs = resolve(root, rel);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, '');
    return abs;
  }

  it('returns null when no candidate exists', () => {
    expect(resolveMofloBin(root, 'flo-index', 'missing.mjs')).toBeNull();
  });

  it('prefers node_modules/moflo/bin over the .claude/scripts mirror', () => {
    const pkg = touch('node_modules/moflo/bin/index-guidance.mjs');
    touch('.claude/scripts/index-guidance.mjs');
    expect(resolveMofloBin(root, 'flo-index', 'index-guidance.mjs')).toBe(pkg);
  });

  it('falls through to .claude/scripts when only the mirror exists', () => {
    const mirror = touch('.claude/scripts/index-guidance.mjs');
    expect(resolveMofloBin(root, 'flo-index', 'index-guidance.mjs')).toBe(mirror);
  });

  it('uses the bin/ dev fallback only when includeDevFallback is set', () => {
    const dev = touch('bin/build-embeddings.mjs');
    expect(resolveMofloBin(root, 'flo-embeddings', 'build-embeddings.mjs')).toBeNull();
    expect(
      resolveMofloBin(root, 'flo-embeddings', 'build-embeddings.mjs', { includeDevFallback: true }),
    ).toBe(dev);
  });

  it('skips the .bin slot when binName is null', () => {
    const pkg = touch('node_modules/moflo/bin/hooks.mjs');
    expect(resolveMofloBin(root, null, 'hooks.mjs')).toBe(pkg);
  });
});
