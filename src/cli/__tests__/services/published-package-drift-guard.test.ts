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
import { join, relative } from 'node:path';
import { findRepoRoot } from '../_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
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

  it('no src/modules/ references re-enter source, scripts, bin, or shipped guidance/skills', () => {
    // Issue #661: post-collapse audit. The src/modules/ tree was deleted in
    // PR #602 — every reference to it in code, scripts, comments, or shipped
    // docs is stale and either misleading or actively wrong. Catches the next
    // engineer who copies an old path from git history.
    //
    // Scope: production-relevant trees only. Historical refs in docs/ (e.g.
    // ADRs that describe the collapse itself) are explicitly excluded.
    const SCAN_ROOTS = [
      join(REPO_ROOT, 'src', 'cli'),
      join(REPO_ROOT, 'bin'),
      join(REPO_ROOT, 'scripts'),
      join(REPO_ROOT, '.claude', 'guidance', 'shipped'),
      join(REPO_ROOT, '.claude', 'skills'),
      join(REPO_ROOT, '.claude', 'scripts'),
    ];
    const STALE_RE = /\bsrc\/modules\//;
    // Lines that mention `src/modules/` to *document its absence* are allowed:
    // typical phrasings — "no longer", "deleted", "WRONG", "pre-collapse",
    // "Replaced the pre-#XXX", etc. Any line missing these markers is a
    // real violation.
    const HISTORICAL_MARKERS = /no longer|deleted|removed|WRONG|pre-collapse|pre-#?\d|formerly|workspace tree|workspace-collapse|was the|used to|legacy|stale|banned/i;
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      if (!existsSync(root)) continue;
      for (const file of walkAll(root)) {
        // Skip the drift guard itself — it intentionally talks about the
        // legacy tree to assert its absence.
        if (file.endsWith('published-package-drift-guard.test.ts')) continue;
        if (file.endsWith('.db') || file.endsWith('.bin') || file.endsWith('.wasm')) continue;
        const text = readFileSync(file, 'utf8');
        if (!STALE_RE.test(text)) continue;
        const rel = relative(REPO_ROOT, file).replace(/\\/g, '/');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!STALE_RE.test(lines[i])) continue;
          if (HISTORICAL_MARKERS.test(lines[i])) continue;
          offenders.push(`${rel}:${i + 1}`);
        }
      }
    }
    expect(
      offenders,
      `Stale src/modules/ refs detected (collapse #586/#602 deleted that tree):\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no `.claude-flow` paths re-enter source, scripts, bin, or shipped guidance (#699)', () => {
    // Issue #699: moflo owns its runtime state under `.moflo/`. The legacy
    // `.claude-flow/` path is migration-only — every reintroduction in
    // production code is a regression that would split state between two
    // dirs on consumer machines. Catches mechanical sweeps that miss spots.
    //
    // Scope: production-relevant trees only. Test fixtures inside __tests__/
    // are excluded — those create temp dirs and don't ship.
    //
    // `.claude/scripts/` is intentionally NOT scanned: it's a runtime sync
    // target for bin/ scripts (refreshed by session-start-launcher.mjs on
    // version drift) and not part of the published package. Stale copies
    // there auto-resolve on the next moflo upgrade.
    const SCAN_ROOTS = [
      join(REPO_ROOT, 'src', 'cli'),
      join(REPO_ROOT, 'bin'),
      join(REPO_ROOT, 'scripts'),
      join(REPO_ROOT, '.claude', 'guidance', 'shipped'),
      join(REPO_ROOT, '.claude', 'helpers'), // shipped (#735): writers here re-create `.claude-flow/`
      join(REPO_ROOT, '.claude', 'skills'),
    ];
    const CLAUDE_FLOW_RE = /\.claude-flow/;
    // Lines that intentionally reference `.claude-flow` for migration or
    // legacy-fallback reasons must carry one of these explicit markers. Vague
    // word-soup ("legacy" alone, "migration") is intentionally NOT allowed —
    // exemption must be a deliberate token an author types on purpose.
    const ALLOWED_MARKERS = /\bLEGACY(?:-CONFIG|-V2|:)?\b|pre-#699|claude-flow-backup-/;
    // The migration helpers themselves must talk about `.claude-flow` —
    // that's their entire purpose. Skip the files outright so we don't have
    // to sprinkle markers on every line.
    const MIGRATION_FILES = new Set([
      'src/cli/services/moflo-paths.ts',
      'bin/lib/moflo-paths.mjs',
    ]);

    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      if (!existsSync(root)) continue;
      for (const file of walkAll(root)) {
        // Skip the drift guard itself (talks about both names) and the
        // __tests__ tree (test fixtures may create .claude-flow temp dirs
        // intentionally, e.g. to assert the migration runs).
        if (file.endsWith('published-package-drift-guard.test.ts')) continue;
        if (file.endsWith('moflo-paths-migration.test.ts')) continue;
        if (/[/\\]__tests__[/\\]/.test(file)) continue;
        if (file.endsWith('.db') || file.endsWith('.bin') || file.endsWith('.wasm')) continue;
        const rel = relative(REPO_ROOT, file).replace(/\\/g, '/');
        if (MIGRATION_FILES.has(rel)) continue;
        const text = readFileSync(file, 'utf8');
        if (!CLAUDE_FLOW_RE.test(text)) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!CLAUDE_FLOW_RE.test(lines[i])) continue;
          if (ALLOWED_MARKERS.test(lines[i])) continue;
          offenders.push(`${rel}:${i + 1}`);
        }
      }
    }
    expect(
      offenders,
      `Stale .claude-flow paths detected (issue #699 migrated runtime state to .moflo).\n` +
        `If a reference is intentional (legacy fallback, migration code), add one of these\n` +
        `explicit markers to the same line: LEGACY, LEGACY-CONFIG, LEGACY-V2, pre-#699,\n` +
        `or "claude-flow-backup-". For migration helpers, add the path to\n` +
        `MIGRATION_FILES in this file.\n` +
        `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no `npm install @moflo/<pkg>` strings remain in source or shipped guidance', () => {
    // Issue #661: moflo publishes as a single npm package called `moflo`. Any
    // `npm install @moflo/cli` (or @moflo/neural, @moflo/memory, …) string in
    // user-facing output sends consumers to a 404. Catches both error
    // messages and example commands.
    const SCAN_ROOTS = [
      join(REPO_ROOT, 'src', 'cli'),
      join(REPO_ROOT, 'bin'),
      join(REPO_ROOT, 'scripts'),
      join(REPO_ROOT, '.claude', 'guidance', 'shipped'),
      join(REPO_ROOT, '.claude', 'skills'),
      join(REPO_ROOT, '.claude', 'scripts'),
    ];
    const STALE_RE = /npm\s+install\s+(?:-g\s+)?@moflo\//;
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      if (!existsSync(root)) continue;
      for (const file of walkAll(root)) {
        if (file.endsWith('published-package-drift-guard.test.ts')) continue;
        if (file.endsWith('.db') || file.endsWith('.bin') || file.endsWith('.wasm')) continue;
        const text = readFileSync(file, 'utf8');
        if (!STALE_RE.test(text)) continue;
        const rel = relative(REPO_ROOT, file).replace(/\\/g, '/');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (STALE_RE.test(lines[i])) offenders.push(`${rel}:${i + 1}`);
        }
      }
    }
    expect(
      offenders,
      `Stale "npm install @moflo/<pkg>" strings — moflo publishes as a single package called "moflo":\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});

/**
 * Walk every file under `dir`, recursively. Excludes node_modules, dist,
 * .git, and other generated directories. Yields absolute paths for any file
 * — caller filters by extension.
 */
function* walkAll(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    if (entry.name === '.swarm' || entry.name === '.claude-flow' || entry.name === '.moflo') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkAll(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    yield full;
  }
}
