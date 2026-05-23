/**
 * Canonical shipped-scripts manifest contract (#1191).
 *
 * Replaces the two fragmented parity guards (init-copy-maps "shipped script
 * lists agree" + post-install-bootstrap-drift-guard) that existed only because
 * the script/helper lists were hand-duplicated across four files. There is now
 * ONE source — bin/lib/shipped-scripts.json — read by every consumer via
 * loadShippedScripts. This test asserts:
 *
 *   1. The manifest is valid and its three lists are non-empty.
 *   2. Every listed file actually exists on disk (typo / missing-file guard —
 *      the real value the old parity tests provided).
 *   3. All four consumers read the manifest and carry NO re-introduced inline
 *      list (the drift the single-source design eliminates).
 *   4. package.json still wires + ships the postinstall bootstrap.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findRepoRoot } from './_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const MANIFEST_PATH = join(REPO_ROOT, 'bin/lib/shipped-scripts.json');

function readManifest(): { scriptFiles: string[]; binHelperFiles: string[]; sourceHelperFiles: string[] } {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
}

describe('shipped-scripts manifest (#1191)', () => {
  it('is valid JSON with three non-empty string lists', () => {
    const m = readManifest();
    for (const key of ['scriptFiles', 'binHelperFiles', 'sourceHelperFiles'] as const) {
      expect(Array.isArray(m[key]), `${key} must be an array`).toBe(true);
      expect(m[key].length, `${key} must be non-empty`).toBeGreaterThan(0);
      for (const entry of m[key]) expect(typeof entry).toBe('string');
    }
  });

  it('every scriptFiles entry exists in bin/', () => {
    const missing = readManifest().scriptFiles.filter((f) => !existsSync(resolve(REPO_ROOT, 'bin', f)));
    expect(missing, `bin/ missing scripts: ${missing.join(', ')}`).toEqual([]);
  });

  it('every binHelperFiles entry exists in bin/', () => {
    const missing = readManifest().binHelperFiles.filter((f) => !existsSync(resolve(REPO_ROOT, 'bin', f)));
    expect(missing, `bin/ missing helpers: ${missing.join(', ')}`).toEqual([]);
  });

  it('every sourceHelperFiles entry exists in .claude/helpers/', () => {
    const missing = readManifest().sourceHelperFiles.filter(
      (f) => !existsSync(resolve(REPO_ROOT, '.claude/helpers', f)),
    );
    expect(missing, `.claude/helpers/ missing entries: ${missing.join(', ')}`).toEqual([]);
  });

  // No-drift guard: every consumer must READ the manifest (via loadShippedScripts)
  // and must NOT carry a re-introduced inline copy of the list. The single tell of
  // a regression is a literal `'session-start-launcher.mjs'` string sitting in the
  // consumer source — the manifest JSON is the only file allowed to contain it.
  const CONSUMERS = [
    'bin/session-start-launcher.mjs',
    'scripts/post-install-bootstrap.mjs',
    'src/cli/init/executor.ts',
    'src/cli/init/moflo-init.ts',
  ];

  it.each(CONSUMERS)('%s reads the manifest via loadShippedScripts', (rel) => {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf-8');
    expect(src, `${rel} must call loadShippedScripts`).toMatch(/loadShippedScripts\s*\(/);
  });

  it.each(CONSUMERS)('%s carries no re-introduced inline script list', (rel) => {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf-8');
    const { scriptFiles } = readManifest();
    // A re-introduced inline array embeds many script names as quoted literals;
    // a few incidental references (a comment, a one-off spawn) are fine. Half or
    // more of the list appearing as literals is the unambiguous tell of a relapse.
    const literalHits = scriptFiles.filter((f) => src.includes(`'${f}'`) || src.includes(`"${f}"`));
    expect(
      literalHits.length,
      `${rel} appears to carry an inline script list (${literalHits.join(', ')}) — read shipped-scripts.json instead`,
    ).toBeLessThan(scriptFiles.length / 2);
  });

  it('package.json postinstall chains the bootstrap script', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.scripts.postinstall).toContain('post-install-bootstrap.mjs');
  });

  it('package.json files[] ships the bootstrap script and the manifest', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.files).toContain('scripts/post-install-bootstrap.mjs');
    // bin/lib/shipped-scripts.json ships via the bin/** glob — assert that glob is present.
    expect(pkg.files.some((g: string) => g === 'bin/**' || g.startsWith('bin/'))).toBe(true);
  });
});
