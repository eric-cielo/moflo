/**
 * Build-time resolution gate (issue #781 / #783).
 *
 * Static-analysis complement to the published-package drift guard. Crawls
 * every compiled `dist/src/cli/**\/*.js` file, extracts every computable
 * dynamic-import / relative-`require` target, and asserts that each target
 * resolves to a file that exists on disk under the moflo package root.
 *
 * The 4.9.0-rc.11 doctor bug is the canonical bug class this catches:
 *   await import(pathToFileURL(resolve(cliPkgRoot, '..', 'spells', 'dist',
 *     'core', 'platform-sandbox.js')).href)
 * — a path computed at runtime that pointed to a sibling workspace package
 * deleted in epic #586. ESLint can't see that the path is broken (#782's
 * traversal rule catches the literal `..` chain, but a contributor could
 * still smuggle the bad path through a constant), so we statically extract
 * targets here and assert they exist in the post-build layout.
 *
 * Why anchor on `dist/` instead of running `npm pack`:
 *   `npm pack --dry-run --json` is the truest source of truth but takes
 *   30+s on a populated tree. The dist/ tree IS the file set that gets
 *   packed (modulo `.map` files explicitly excluded by package.json#files),
 *   so static-checking dist/ is fast (<1s) and catches the same bug class.
 *   The consumer-install-smoke harness already covers the tarball-shape
 *   side of the invariant.
 *
 * What this catches:
 *   1. `await import('<string>')` / `import('<string>')` with relative-path
 *      literal arguments (`./foo.js`, `../bar.js`)
 *   2. `require('<string>')` / `require.resolve('<string>')` with relative
 *      literal arguments
 *
 * What this does NOT catch:
 *   - Targets computed via runtime concatenation of variables (would need
 *     symbolic execution; relies on #782's lint rule + #784's smoke instead)
 *   - Bare module specifiers (`'sql.js'`, `'fastembed'`) — those resolve
 *     via Node's module resolution and are validated by the
 *     consumer-install-smoke harness
 *
 * Comment stripping: deliberately omitted. tsc strips JSDoc and most
 * comments during compile (only `//#` directives and license headers
 * survive), so dist files contain little that would false-match our
 * regexes — and a contributor who buries `await import('./broken.js')` in
 * a real comment isn't who we're protecting against. False positives are
 * caught by the existence check failing on a known-good path, which is
 * easy to read.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { findRepoRoot } from '../_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const DIST_CLI_ROOT = join(REPO_ROOT, 'dist', 'src', 'cli');

interface Target {
  resolvedPath: string;
  fromFile: string;
  fromLine: number;
  raw: string;
  pattern: 'import()' | 'require()';
}

function* walkJs(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkJs(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.js')) continue;
    if (entry.name.endsWith('.test.js') || entry.name.endsWith('.spec.js')) continue;
    yield full;
  }
}

function isBareSpecifier(spec: string): boolean {
  if (spec.startsWith('./') || spec.startsWith('../')) return false;
  if (spec.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(spec)) return false;
  return true;
}

// `await import('<spec>')` / `import('<spec>')` — relative-path literals.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"`]+)['"]\s*\)/g;

// `require('<spec>')` / `require.resolve('<spec>')` — relative literals only.
const REQUIRE_RE = /\brequire(?:\.resolve)?\s*\(\s*['"]([^'"`]+)['"]\s*\)/g;

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}

function extractTargets(filePath: string): Target[] {
  const src = readFileSync(filePath, 'utf8');
  const fileDir = dirname(filePath);
  const targets: Target[] = [];

  // Pattern 1 + 4: import('...') and require('...')
  for (const re of [DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const spec = m[1];
      if (isBareSpecifier(spec)) continue;
      if (spec.startsWith('file://')) continue;
      targets.push({
        resolvedPath: resolve(fileDir, spec),
        fromFile: filePath,
        fromLine: lineOf(src, m.index),
        raw: m[0],
        pattern: re === DYNAMIC_IMPORT_RE ? 'import()' : 'require()',
      });
    }
  }

  return targets;
}

describe('dist resolution gate (issue #781 / #783)', () => {
  // Skip if dist/ hasn't been built. The CI smoke flow runs `npm run build`
  // before `npm test`, so this is only a local-dev convenience.
  const hasBuild = existsSync(join(DIST_CLI_ROOT, 'index.js'));

  // Hoist the dist walk + extraction into beforeAll so test 1 + test 2 share
  // the same target list (saves a redundant filesystem walk + regex sweep).
  // Reset inside beforeAll so watch-mode re-runs don't accumulate entries.
  let allTargets: Target[] = [];
  beforeAll(() => {
    allTargets = [];
    if (!hasBuild) return;
    for (const file of walkJs(DIST_CLI_ROOT)) {
      allTargets.push(...extractTargets(file));
    }
  });

  it.skipIf(!hasBuild)('every dynamic-import / require target in dist/ resolves to an existing file', () => {
    const offenders: string[] = [];
    for (const t of allTargets) {
      if (existsSync(t.resolvedPath)) continue;
      const fromRel = relative(REPO_ROOT, t.fromFile).replace(/\\/g, '/');
      const targetRel = relative(REPO_ROOT, t.resolvedPath).replace(/\\/g, '/');
      offenders.push(`${fromRel}:${t.fromLine} → ${targetRel}  [${t.pattern}: ${t.raw.replace(/\s+/g, ' ').slice(0, 80)}]`);
    }

    expect(
      offenders,
      `Dynamic-import / require targets in dist/ point to files that don't exist:\n  ${offenders.join('\n  ')}\n\n` +
        `These would throw ERR_MODULE_NOT_FOUND in a consumer install. Common causes:\n` +
        `  - File was renamed/moved/deleted but a caller still imports the old path\n` +
        `  - Path was computed against a sibling workspace package that doesn't exist (epic #586)\n` +
        `Fix the call site, run \`npm run build\`, and re-run this test.`,
    ).toEqual([]);
  });

  it.skipIf(!hasBuild)('extracts a non-trivial number of targets — sanity check that the regexes still match', () => {
    // Empirical floor: moflo's dist has thousands of imports. Anything below
    // 100 means a regex broke or the dist tree is empty.
    expect(allTargets.length, 'Resolution-gate extractor returned suspiciously few targets').toBeGreaterThan(100);
  });

  it.skipIf(!hasBuild)('rejects an obviously broken target (regression test for the test itself)', () => {
    // Synthesises the exact bug shape from 4.9.0-rc.11 and confirms our
    // extractor + existence check would have caught it. Keeps the gate
    // honest if anyone refactors the regexes.
    const fakeFile = join(DIST_CLI_ROOT, 'commands', 'doctor.js');
    const fakeSrc = `await import('../../../spells/dist/core/platform-sandbox.js');\n`;
    DYNAMIC_IMPORT_RE.lastIndex = 0;
    const m = DYNAMIC_IMPORT_RE.exec(fakeSrc);
    expect(m, 'extractor failed to match the canonical bug shape').not.toBeNull();
    const resolvedPath = resolve(dirname(fakeFile), m![1]);
    expect(
      existsSync(resolvedPath),
      `Synthesised broken-import target unexpectedly exists at ${resolvedPath} — has the layout changed? Update this regression test.`,
    ).toBe(false);
  });
});
