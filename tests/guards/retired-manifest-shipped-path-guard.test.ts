/**
 * `retired-files.json` may never name a path moflo still ships (#1414).
 *
 * The manifest tells every consumer's launcher which shipped files to delete on
 * upgrade, gated on a content-hash match. An entry for a path that is BACK in
 * the tree is self-contradictory: its `knownContentHashes` hold only the
 * pre-deletion content, while the file on the consumer's disk is whatever
 * moflo's own manifest sync just wrote from the package. Nothing matches, the
 * launcher classifies it `preserve`, and every session prints
 *
 *     moflo: retained N customized retired files (delete manually if unwanted)
 *
 * for files that were never customized and are not retired — pointing the user
 * at agent definitions that `agent-router`, `swarm`, and `flo-simplify` resolve
 * by name. Ten shipped core agents sat in that state because
 * `scripts/build-retired-files.mjs --seed` walks deletion commits and never
 * asked whether the path came back.
 *
 * The rule is already written down in `.claude/guidance/internal/retirement-workflow.md`
 * ("never ship a manifest entry for a path that exists in `node_modules/moflo/`").
 * This is what enforces it.
 *
 * NO EXEMPTIONS. A path in the tree is a path that ships, and there is no
 * version of "retired but still shipped" that is coherent. If this goes red,
 * withdraw the entry — `flo retire --rebuild-hashes` drops every offender and
 * reports what it removed. Do not add an allowlist.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './_helpers/eslint-harness.js';
import { trackedFiles } from './_helpers/tracked-files.js';

const MANIFEST_PATH = join(REPO_ROOT, 'retired-files.json');

interface RetiredEntry {
  path: string;
  retiredIn?: string;
  retiredBy?: string;
}

/**
 * git already reports `/`-separated paths on every platform, so only the
 * manifest side can carry `\` — from a hand edit on Windows. Normalizing it
 * stops such an entry slipping through by failing to string-match.
 */
function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Entries naming a path that is present in the tracked tree. Pure, so the
 * detector can be exercised against a synthetic manifest below rather than
 * only against the real one — a guard that has never been seen to fire is a
 * guard nobody knows works.
 */
export function shippedPathOffenders(
  entries: readonly RetiredEntry[],
  tracked: ReadonlySet<string>,
): string[] {
  return entries
    .filter((entry) => tracked.has(normalize(entry.path)))
    .map((entry) => `${entry.path}${entry.retiredIn ? ` (retiredIn ${entry.retiredIn})` : ''}`);
}

/**
 * Parsed here rather than through `loadManifest` from `scripts/build-retired-files.mjs`.
 * A guard that reuses the loader belonging to the tool it guards inherits that
 * tool's bugs — a loader that silently dropped entries would take the guard
 * green with it.
 */
function loadEntries(): RetiredEntry[] {
  const parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { retired?: RetiredEntry[] };
  return parsed.retired ?? [];
}

/**
 * The WHOLE tracked tree, not just `.claude`. Scoping the listing to the
 * prefixes the retirement tooling accepts today would leave the guard silently
 * under-scanning the moment those prefixes change — and a guard that checks
 * less than it claims is the one failure mode a guard must not have. Paths are
 * matched exactly, so widening the set costs nothing in false positives.
 *
 * Tracked-only, deliberately: an untracked working-tree file is not something
 * the npm tarball can ship, and keying on the tracked set is what makes a local
 * run and CI agree.
 *
 * Hoisted — `git ls-files` is a subprocess and every test here asks the same
 * question of the same tree.
 */
let trackedCache: Set<string> | null = null;
function trackedRepoPaths(): Set<string> {
  trackedCache ??= new Set(trackedFiles());
  return trackedCache;
}

describe('retired-files.json never names a still-shipped path (#1414)', () => {
  it('has no entry whose path is present in the tracked tree', () => {
    const entries = loadEntries();
    const tracked = trackedRepoPaths();

    // Both sides must be non-empty or the assertion below passes vacuously —
    // a broken loader would otherwise read as a clean guard forever.
    expect(entries.length, 'retired-files.json parsed to zero entries — loader regressed').toBeGreaterThan(0);
    expect(tracked.size, 'git ls-files returned nothing — listing regressed').toBeGreaterThan(0);

    const offenders = shippedPathOffenders(entries, tracked);

    expect(
      offenders,
      `retired-files.json names ${offenders.length} path(s) moflo still ships:\n  ${offenders.join('\n  ')}\n\n` +
        `Such an entry can only ever resolve to "customized, retained" on a consumer, because its\n` +
        `knownContentHashes predate the content the package now installs. Withdraw it:\n` +
        `  flo retire --rebuild-hashes\n` +
        `Do not allowlist it here.`,
    ).toEqual([]);
  });

  it('detects a violation when one is present', () => {
    // The real manifest is clean, so prove the detector fires against a
    // synthetic entry pointing at a file that genuinely is in the tree.
    const tracked = trackedRepoPaths();
    const [victim] = [...tracked].sort();
    expect(victim, 'no tracked path to build the negative case from').toBeTruthy();

    const offenders = shippedPathOffenders(
      [{ path: victim, retiredIn: '9.9.9' }, { path: '.claude/agents/gone/never-existed.md' }],
      tracked,
    );

    expect(offenders).toEqual([`${victim} (retiredIn 9.9.9)`]);
  });

  it('every manifest path is expressed with forward slashes', () => {
    // The launcher resolves these with path.resolve, which tolerates either
    // separator — but the guard above, `flo doctor`, and every diff review read
    // them as strings. One backslash entry would compare unequal everywhere.
    const offenders = loadEntries()
      .map((entry) => entry.path)
      .filter((p) => p.includes('\\'));
    expect(offenders, `retired-files.json paths must use '/': ${offenders.join(', ')}`).toEqual([]);
  });
});
