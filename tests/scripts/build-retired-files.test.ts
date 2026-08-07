/**
 * Tests for the retired-files build script (#1133).
 *
 * Covers:
 *  1. `hashesForPath` walks every commit reachable from `sinceRef` that
 *     touched the path — not a 3-deep window (#1133).
 *  2. The committed retired-files.json has no entry that lost coverage
 *     under the rebuild (every entry still includes >= 1 hash).
 *  3. `--rebuild-hashes` is idempotent — re-running produces no diff.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { spawnSync } from 'child_process';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as buildRetired from '../../scripts/build-retired-files.mjs';

const repoRoot = resolve(__dirname, '..', '..');
const manifestPath = resolve(repoRoot, 'retired-files.json');

interface RetiredEntry {
  path: string;
  knownContentHashes: string[];
  retiredIn?: string;
  retiredBy?: string;
}
interface RetiredManifest {
  version: number;
  retired: RetiredEntry[];
}

function loadManifest(): RetiredManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf-8'));
}

describe('build-retired-files.mjs (#1133)', () => {
  // These tests walk git history for paths that were deleted commits ago.
  // A shallow clone (`actions/checkout@v5` without `fetch-depth: 0`) returns
  // empty for `git log --diff-filter=D` against those deletions, producing
  // cryptic test failures. Fail fast at the suite boundary with an
  // actionable message instead.
  const isShallow = spawnSync(
    'git',
    ['rev-parse', '--is-shallow-repository'],
    { cwd: repoRoot, encoding: 'utf-8' },
  ).stdout.trim() === 'true';
  if (isShallow) {
    throw new Error(
      'This test suite walks git history for retired paths and cannot run in a ' +
      'shallow clone. CI: set `fetch-depth: 0` on actions/checkout. Local: run ' +
      '`git fetch --unshallow` (or clone without --depth).',
    );
  }

  describe('hashesForPath', () => {
    it('returns every unique historical content hash for a path with >3 revisions', () => {
      // `.claude/agents/sona/sona-learning-optimizer.md` is a known retired
      // path with 7 unique historical content versions reachable from its
      // deletion commit (manually verified: commits 1b6a1971, 109e3af7,
      // 7778422a, fbc9c1a9, 3f84a165, bb3cd615, 3cb44788). Pre-#1133 the
      // cap would have sliced this to 3. A regression to a smaller cap
      // would fail this assertion.
      const path = '.claude/agents/sona/sona-learning-optimizer.md';
      const deletionLog = spawnSync(
        'git',
        ['log', '--diff-filter=D', '--pretty=format:%H', '-n', '1', '--', path],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      const sinceRef = (deletionLog.stdout || '').trim();
      expect(sinceRef, 'sona-learning-optimizer must have a deletion commit').toBeTruthy();

      const hashes = buildRetired.hashesForPath(path, sinceRef);
      expect(hashes.length).toBeGreaterThanOrEqual(7);
      // Sanity: every hash is well-formed.
      for (const h of hashes) expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
      // Sanity: deduplicated.
      expect(new Set(hashes).size).toBe(hashes.length);
    });

    it('does not record the empty-file blob from the deletion commit itself', () => {
      const path = '.claude/agents/sona/sona-learning-optimizer.md';
      const deletionLog = spawnSync(
        'git',
        ['log', '--diff-filter=D', '--pretty=format:%H', '-n', '1', '--', path],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      const sinceRef = (deletionLog.stdout || '').trim();
      const hashes = buildRetired.hashesForPath(path, sinceRef);
      // sha256 of empty string — what `git show <delete>:<path>` would yield
      // if we didn't catch the error.
      const emptyHash = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      expect(hashes).not.toContain(emptyHash);
    });

    it('returns an empty array for a path with no git history', () => {
      const hashes = buildRetired.hashesForPath(
        '.claude/agents/v3/__definitely-never-existed__.md',
        'HEAD',
      );
      expect(hashes).toEqual([]);
    });
  });

  describe('retired-files.json (post-rebuild invariants)', () => {
    const manifest = loadManifest();

    it('every entry carries at least one well-formed sha256 hash', () => {
      for (const entry of manifest.retired) {
        expect(entry.knownContentHashes.length, `entry ${entry.path} has no hashes`).toBeGreaterThan(0);
        for (const h of entry.knownContentHashes) {
          expect(h, `entry ${entry.path} hash`).toMatch(/^sha256:[0-9a-f]{64}$/);
        }
      }
    });

    it('rebuild produced entries with more than the legacy 3-hash cap for some paths', () => {
      // The whole point of #1133 — pre-fix cap was 3. Without at least one
      // entry exceeding 3 hashes the rebuild was a no-op and the window
      // never widened.
      const beyondCap = manifest.retired.filter((e) => e.knownContentHashes.length > 3);
      expect(beyondCap.length).toBeGreaterThan(0);
    });

    it('all hashes per entry are unique (no dedupe bug)', () => {
      for (const entry of manifest.retired) {
        expect(new Set(entry.knownContentHashes).size, `entry ${entry.path}`).toBe(entry.knownContentHashes.length);
      }
    });
  });

  describe('rebuild determinism', () => {
    it('hashesForPath is deterministic — same path + sinceRef yields identical output', () => {
      // The end-to-end idempotency invariant (rebuild N times → identical
      // manifest) reduces to: hashesForPath is deterministic. The script's
      // rebuild does a set-union of fresh + prior hashes, so deterministic
      // walk + already-saturated prior set = no diff on subsequent runs.
      const path = '.claude/agents/sona/sona-learning-optimizer.md';
      const deletionLog = spawnSync(
        'git',
        ['log', '--diff-filter=D', '--pretty=format:%H', '-n', '1', '--', path],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      const sinceRef = (deletionLog.stdout || '').trim();
      const first = buildRetired.hashesForPath(path, sinceRef);
      const second = buildRetired.hashesForPath(path, sinceRef);
      expect(second).toEqual(first);
    });

    it('every committed knownContentHashes is a superset of what hashesForPath finds today', () => {
      // The committed manifest is the post-rebuild state. Re-walking history
      // for any sample entry MUST yield a subset of the recorded hashes —
      // otherwise rebuild would mutate the manifest on next run (non-idempotent).
      const sample = loadManifest().retired.find((e) => e.path === '.claude/agents/sona/sona-learning-optimizer.md');
      expect(sample).toBeDefined();
      const deletionLog = spawnSync(
        'git',
        ['log', '--diff-filter=D', '--pretty=format:%H', '-n', '1', '--', sample!.path],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      const sinceRef = (deletionLog.stdout || '').trim();
      const live = buildRetired.hashesForPath(sample!.path, sinceRef);
      for (const h of live) {
        expect(sample!.knownContentHashes, `live hash ${h} missing from manifest`).toContain(h);
      }
    });
  });

  // ── Resurrected paths (#1414) ────────────────────────────────────────────
  //
  // `--seed` walks deletion commits, and a path deleted in the alpha era can
  // have been restored since. Recording it anyway produces an entry whose
  // hashes predate the content moflo now installs, so every consumer reports it
  // as a customized retired file forever. Ten shipped core agents were in that
  // state.
  //
  // These read the real repo and never write the manifest — the guard suite
  // reads it concurrently, and a test that rewrites a tracked file to observe
  // the effect would race it.
  describe('resurrected-path skip', () => {
    it('isResurrected is true for a path that was deleted and later restored', () => {
      // Deleted in the 2.0.0-alpha era, shipped again today.
      const path = '.claude/agents/core/coder.md';
      const deletionLog = spawnSync(
        'git',
        ['log', '--diff-filter=D', '--pretty=format:%H', '-n', '1', '--', path],
        { cwd: repoRoot, encoding: 'utf-8' },
      );
      expect((deletionLog.stdout || '').trim(), `${path} was never deleted — pick another fixture`).not.toBe('');
      expect(buildRetired.isResurrected(path)).toBe(true);
    });

    it('isResurrected is false for a path that stayed retired', () => {
      expect(buildRetired.isResurrected('.claude/agents/sona/sona-learning-optimizer.md')).toBe(false);
    });

    it('no path that a seed walk would find is both deleted-in-history and back in the tree', () => {
      // The seed-side statement of the invariant: enumerate exactly what
      // `--seed` enumerates, and assert every resurrected path it encounters is
      // absent from the committed manifest. Pre-fix this listed 10 paths.
      const deleted = new Set<string>();
      for (const commit of buildRetired.findDeletionCommits()) {
        for (const p of commit.deletedPaths) deleted.add(p);
      }
      expect(deleted.size, 'deletion walk found nothing — shallow clone or walk regressed').toBeGreaterThan(0);

      const recorded = new Set(loadManifest().retired.map((e) => e.path));
      const offenders = [...deleted].filter((p) => buildRetired.isResurrected(p) && recorded.has(p)).sort();

      expect(
        offenders,
        `retired-files.json records ${offenders.length} path(s) that were deleted but are back in the tree:\n` +
          `  ${offenders.join('\n  ')}\n` +
          `Run \`flo retire --rebuild-hashes\` to drop them.`,
      ).toEqual([]);
    });
  });
});
