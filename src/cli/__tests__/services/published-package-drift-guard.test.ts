/**
 * Published-package drift guard (issue #585).
 *
 * Two static invariants that, if violated, would ship a broken consumer
 * install — the same class of bug as 4.8.87-rc.2 (issue #583). Pairs with
 * the consumer-smoke probe at `scripts/consumer-smoke/probe-bare-specifiers.mjs`:
 * the smoke catches it at runtime, this catches it in vitest in <100ms so a
 * dev sees the problem before they push.
 *
 *   1. **Files-array coverage**: every `@moflo/<pkg>` bare specifier used in
 *      moflo source must point to a module whose dist is in
 *      `package.json`'s `files` array. A bare import for a module not
 *      shipped in the tarball will throw `ERR_MODULE_NOT_FOUND` in any
 *      consumer install.
 *
 *   2. **Bare-import inventory**: snapshot the set of `@moflo/<pkg>`
 *      packages imported anywhere in source. New entries fail the test
 *      until they're added to ALLOWED_BARE_PACKAGES — at which point the
 *      dev has been forced to think about whether the consumer-smoke
 *      probe still covers them. (It auto-extends, but the static signal
 *      keeps the inventory honest.)
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    // Anchor on package.json + src/cli — survives the post-#602 layout
    // (no more src/modules/ tree) and refuses to false-match consumer
    // installs (which have no src/cli source tree).
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src', 'cli'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate moflo repo root from drift guard test.');
}

const REPO_ROOT = findRepoRoot();
const SRC_ROOT = join(REPO_ROOT, 'src');

// Auto-installed externals that intentionally aren't in moflo's `files` array.
// Adding to this list is a deliberate choice — every entry here costs the
// consumer an extra install on first use.
const AUTO_INSTALLED_EXTERNALS = new Set<string>();

// Pinned inventory of bare packages. New entries force a dev to verify the
// consumer-smoke probe still covers them.
const ALLOWED_BARE_PACKAGES = new Set<string>([]);

const BARE_RE = /(?:from|import)\s*\(?\s*['"](@moflo\/[a-z][a-z0-9_-]*)(?:\/[a-z0-9_/.-]+)?['"]/g;

// Skip JSDoc and line comments — they routinely show example imports for
// modules we don't actually depend on. The `tests/` and `__tests__/`
// directories are excluded because per-module test code may import the
// module's own siblings via bare specifier for ergonomics, but those
// imports never run inside a consumer install.
const TEST_DIRS = new Set(['__tests__', 'tests', 'test']);

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    if (TEST_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTs(full);
      continue;
    }
    if (!/\.(m?ts|m?js)$/.test(entry.name)) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    if (!entry.isFile()) continue;
    yield full;
  }
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('*') || trimmed.startsWith('//');
}

function scanBareImports(): Set<string> {
  const found = new Set<string>();
  for (const file of walkTs(SRC_ROOT)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('@moflo/')) continue;
    for (const line of text.split('\n')) {
      if (isCommentLine(line)) continue;
      if (!line.includes('@moflo/')) continue;
      BARE_RE.lastIndex = 0;
      let m;
      while ((m = BARE_RE.exec(line)) !== null) {
        found.add(m[1]);
      }
    }
  }
  return found;
}

interface PkgJson {
  files?: string[];
}

function shippedModules(): Set<string> {
  // After workspace-collapse epic #586, no `src/modules/<pkg>/dist/` entries
  // remain in the files array — every former workspace package is inlined
  // under src/cli/ and shipped via `dist/src/cli/`. Returning an empty set
  // keeps Test 1 honest: any reintroduction of a bare `@moflo/<pkg>`
  // specifier will fail because nothing is "shipped" under that name.
  return new Set<string>();
}

describe('published-package drift guard (issue #585)', () => {
  it('every @moflo/* bare specifier points to a module shipped in package.json files (or an allowed external)', () => {
    const used = scanBareImports();
    const shipped = shippedModules();
    const orphans: string[] = [];
    for (const spec of used) {
      if (shipped.has(spec)) continue;
      if (AUTO_INSTALLED_EXTERNALS.has(spec)) continue;
      orphans.push(spec);
    }
    expect(
      orphans,
      `These @moflo/* bare imports target modules not shipped in package.json "files":\n  ${orphans.join('\n  ')}\n` +
        `Either (a) add the module's dist to "files", (b) add to AUTO_INSTALLED_EXTERNALS if it's a real external, ` +
        `or (c) remove the import.`,
    ).toEqual([]);
  });

  it('inventory of @moflo/* bare specifiers matches the pinned allow-list', () => {
    const used = scanBareImports();
    const unexpected = [...used].filter((s) => !ALLOWED_BARE_PACKAGES.has(s));
    const missing = [...ALLOWED_BARE_PACKAGES].filter((s) => !used.has(s));
    expect(
      { unexpected, missing },
      `New or removed @moflo/* bare specifiers detected.\n` +
        `If intentional: update ALLOWED_BARE_PACKAGES in this file AND verify the consumer-smoke probe ` +
        `at scripts/consumer-smoke/probe-bare-specifiers.mjs covers the new path.`,
    ).toEqual({ unexpected: [], missing: [] });
  });

  it('files array no longer references the legacy src/modules/ tree', () => {
    // After epic #586 there should be zero `src/modules/<pkg>/...` entries
    // in the files array. Catches a regression that would resurrect the
    // old workspace layout.
    const pkg: PkgJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const filesArr = pkg.files ?? [];
    const stale = filesArr.filter(e => /^!?src\/modules\//.test(e));
    expect(
      stale,
      `package.json "files" still has src/modules/ entries:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });
});
