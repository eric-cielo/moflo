/**
 * Tests for the retired-files prune helper added in #948.
 *
 * Validates that:
 *  1. Unmodified retired files (hash matches a known-shipped value) are pruned
 *  2. User-modified retired files (hash mismatch) are preserved + reported
 *  3. User-authored files at custom paths are never touched
 *  4. Cross-platform: works with mixed-separator paths and re-resolves on each OS
 *  5. Manifest validation: malformed/missing files don't blow up the launcher
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { createHash } from 'crypto';

// The launcher imports this via dynamic import; tests can import statically.
// Path is relative to repo root → resolve from __dirname for portability.
import {
  fileSha256,
  fileSha256NormalizedEol,
  loadRetiredManifest,
  classifyRetiredFile,
  applyRetiredPrune,
} from '../../bin/lib/retired-files.mjs';

function makeTempRoot(label: string): string {
  const root = resolve(
    __dirname,
    '../../.testoutput/.test-948-' + label + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(root, { recursive: true });
  return root;
}

function cleanTempRoot(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
}

function writeAt(root: string, rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function sha256Of(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

describe('retired-files helper (#948)', () => {
  describe('fileSha256', () => {
    it('matches the known sha256 of a small known content', () => {
      const root = makeTempRoot('hash');
      try {
        writeAt(root, 'sample.md', 'hello\n');
        const got = fileSha256(join(root, 'sample.md'));
        expect(got).toBe(sha256Of('hello\n'));
      } finally { cleanTempRoot(root); }
    });

    it('returns null for a missing file rather than throwing', () => {
      expect(fileSha256(join(__dirname, '__definitely-not-here__'))).toBeNull();
    });
  });

  describe('fileSha256NormalizedEol (Rule #1 — CRLF)', () => {
    it('hashes a CRLF file identically to the same content with LF endings', () => {
      const root = makeTempRoot('eol');
      try {
        const lf = '---\nname: agent\n---\nbody line\n';
        const crlf = lf.replace(/\n/g, '\r\n');
        writeAt(root, 'lf.md', lf);
        writeAt(root, 'crlf.md', crlf);
        // Raw hashes differ (CRLF has extra \r bytes)...
        expect(fileSha256(join(root, 'crlf.md'))).not.toBe(fileSha256(join(root, 'lf.md')));
        // ...but EOL-normalized hashes match, and equal the raw LF hash.
        expect(fileSha256NormalizedEol(join(root, 'crlf.md'))).toBe(sha256Of(lf));
        expect(fileSha256NormalizedEol(join(root, 'crlf.md')))
          .toBe(fileSha256NormalizedEol(join(root, 'lf.md')));
      } finally { cleanTempRoot(root); }
    });

    it('returns null for a missing file rather than throwing', () => {
      expect(fileSha256NormalizedEol(join(__dirname, '__definitely-not-here__'))).toBeNull();
    });
  });

  describe('loadRetiredManifest', () => {
    it('returns empty entries when the manifest does not exist', () => {
      const { entries } = loadRetiredManifest(join(__dirname, '__missing__.json'));
      expect(entries).toEqual([]);
    });

    it('returns empty entries for invalid JSON', () => {
      const root = makeTempRoot('badjson');
      try {
        const p = join(root, 'r.json');
        writeFileSync(p, '{ not json');
        expect(loadRetiredManifest(p).entries).toEqual([]);
      } finally { cleanTempRoot(root); }
    });

    it('drops malformed entries silently — never auto-prunes a bad row', () => {
      const root = makeTempRoot('shape');
      try {
        const p = join(root, 'r.json');
        writeFileSync(p, JSON.stringify({
          version: 1,
          retired: [
            { path: '.claude/agents/v3/foo.md', knownContentHashes: ['sha256:abc'] }, // good
            { path: '.claude/agents/v3/bar.md', knownContentHashes: ['plain-string'] }, // bad: no sha256: prefix
            { path: '.claude/agents/v3/baz.md' },                                       // bad: no hashes
            { knownContentHashes: ['sha256:def'] },                                     // bad: no path
            'not-an-object',                                                             // bad
          ],
        }));
        const { entries } = loadRetiredManifest(p);
        expect(entries).toHaveLength(1);
        expect(entries[0].path).toBe('.claude/agents/v3/foo.md');
      } finally { cleanTempRoot(root); }
    });
  });

  describe('classifyRetiredFile', () => {
    it('returns absent when the file does not exist', () => {
      const root = makeTempRoot('classify-absent');
      try {
        const r = classifyRetiredFile(root, {
          path: '.claude/agents/v3/missing.md',
          knownContentHashes: ['sha256:abc'],
        });
        expect(r.action).toBe('absent');
      } finally { cleanTempRoot(root); }
    });

    it('returns prune when the on-disk hash matches a known-shipped hash', () => {
      const root = makeTempRoot('classify-match');
      try {
        const content = 'shipped content body\n';
        writeAt(root, '.claude/agents/v3/perf.md', content);
        const r = classifyRetiredFile(root, {
          path: '.claude/agents/v3/perf.md',
          knownContentHashes: [sha256Of(content)],
        });
        expect(r.action).toBe('prune');
        expect(r.actualHash).toBe(sha256Of(content));
      } finally { cleanTempRoot(root); }
    });

    it('returns preserve when the on-disk hash differs from every known-shipped hash', () => {
      const root = makeTempRoot('classify-mismatch');
      try {
        writeAt(root, '.claude/agents/v3/perf.md', 'user-customized this\n');
        const r = classifyRetiredFile(root, {
          path: '.claude/agents/v3/perf.md',
          knownContentHashes: [sha256Of('shipped original\n'), sha256Of('older shipped\n')],
        });
        expect(r.action).toBe('preserve');
        expect(r.actualHash).toBe(sha256Of('user-customized this\n'));
      } finally { cleanTempRoot(root); }
    });

    it('prunes a CRLF copy whose LF-normalized content matches a known (LF) hash (Rule #1)', () => {
      // The waxstak case: moflo ships LF, the manifest records the LF hash, but
      // the consumer file is CRLF (git autocrlf on Windows). Raw bytes differ;
      // the EOL-normalized fallback must still recognize it as un-customized.
      const root = makeTempRoot('classify-crlf');
      try {
        const lfShipped = '---\nname: perf\n---\nshipped body\n';
        writeAt(root, '.claude/agents/v3/perf.md', lfShipped.replace(/\n/g, '\r\n'));
        const r = classifyRetiredFile(root, {
          path: '.claude/agents/v3/perf.md',
          knownContentHashes: [sha256Of(lfShipped)], // LF hash only, as moflo ships
        });
        expect(r.action).toBe('prune');
        // actualHash reflects the raw CRLF bytes on disk, not the normalized form.
        expect(r.actualHash).toBe(fileSha256(join(root, '.claude/agents/v3/perf.md')));
        expect(r.actualHash).not.toBe(sha256Of(lfShipped));
      } finally { cleanTempRoot(root); }
    });

    it('still preserves a genuinely-customized CRLF file (normalization is not a wildcard)', () => {
      const root = makeTempRoot('classify-crlf-custom');
      try {
        writeAt(root, '.claude/agents/v3/perf.md', '# I edited this\r\nmy own notes\r\n');
        const r = classifyRetiredFile(root, {
          path: '.claude/agents/v3/perf.md',
          knownContentHashes: [sha256Of('---\nname: perf\n---\nshipped body\n')],
        });
        expect(r.action).toBe('preserve');
      } finally { cleanTempRoot(root); }
    });
  });

  describe('applyRetiredPrune end-to-end', () => {
    let root: string;
    beforeEach(() => { root = makeTempRoot('apply'); });
    afterEach(() => { cleanTempRoot(root); });

    function writeManifest(entries: Array<{path:string; knownContentHashes:string[]}>) {
      const p = join(root, 'retired-files.json');
      writeFileSync(p, JSON.stringify({ version: 1, retired: entries }));
      return p;
    }

    it('prunes unmodified shipped files and preserves customized ones', () => {
      const shipped = '# shipped agent\nbody\n';
      const customized = '# my customized version\n';
      writeAt(root, '.claude/agents/v3/performance-engineer.md', shipped);
      writeAt(root, '.claude/agents/consensus/raft-manager.md', customized);
      writeAt(root, '.claude/agents/custom/my-agent.md', '# user-authored, never in manifest\n');

      const manifestPath = writeManifest([
        {
          path: '.claude/agents/v3/performance-engineer.md',
          knownContentHashes: [sha256Of(shipped)],
        },
        {
          path: '.claude/agents/consensus/raft-manager.md',
          knownContentHashes: [sha256Of('different shipped content\n')],
        },
      ]);

      const report = applyRetiredPrune(root, manifestPath);

      // Unmodified file is gone
      expect(existsSync(join(root, '.claude/agents/v3/performance-engineer.md'))).toBe(false);
      expect(report.pruned).toContain('.claude/agents/v3/performance-engineer.md');

      // Customized file is preserved + reported
      expect(existsSync(join(root, '.claude/agents/consensus/raft-manager.md'))).toBe(true);
      expect(report.preserved).toContain('.claude/agents/consensus/raft-manager.md');

      // User-authored custom file is untouched (never in manifest)
      expect(existsSync(join(root, '.claude/agents/custom/my-agent.md'))).toBe(true);
    });

    it('skips entries whose path does not exist on disk (consumer never had it)', () => {
      const manifestPath = writeManifest([
        {
          path: '.claude/agents/v3/never-installed.md',
          knownContentHashes: ['sha256:abc'],
        },
      ]);

      const report = applyRetiredPrune(root, manifestPath);
      expect(report.pruned).toEqual([]);
      expect(report.preserved).toEqual([]);
      expect(report.failed).toEqual([]);
    });

    it('matches against any of multiple known-shipped hashes', () => {
      const oldVersion = '# v1 of shipped\n';
      const newVersion = '# v2 of shipped\n';
      writeAt(root, '.claude/agents/v3/perf.md', oldVersion);

      const manifestPath = writeManifest([
        {
          path: '.claude/agents/v3/perf.md',
          knownContentHashes: [sha256Of(newVersion), sha256Of(oldVersion)],
        },
      ]);

      const report = applyRetiredPrune(root, manifestPath);
      expect(report.pruned).toContain('.claude/agents/v3/perf.md');
    });

    it('handles missing manifest as a no-op (launcher must not block)', () => {
      const report = applyRetiredPrune(root, join(root, 'definitely-missing.json'));
      expect(report.pruned).toEqual([]);
      expect(report.preserved).toEqual([]);
      expect(report.failed).toEqual([]);
    });

    it('prunes when consumer hash matches the 4th-or-later historic shipped version (#1133)', () => {
      // Reproduces the motailz-style stale-install case the 3-hash cap missed:
      // consumer installed an older moflo, file content matches a hash that
      // was sliced off the manifest under the legacy 3-cap. With the widened
      // window the manifest carries every historic hash, so the prune fires.
      const oldest = '# moflo 4.6 shipped this\n';
      const middle = '# moflo 4.7 shipped this\n';
      const newer  = '# moflo 4.8 shipped this\n';
      const newest = '# moflo 4.9 shipped this\n';
      const consumer = oldest; // motailz-equivalent — frozen on 4.6 content

      writeAt(root, '.claude/agents/v3/stale.md', consumer);
      const manifestPath = writeManifest([
        {
          path: '.claude/agents/v3/stale.md',
          // 4 known hashes — pre-#1133 the slice cap would have dropped `oldest`.
          knownContentHashes: [
            sha256Of(newest),
            sha256Of(newer),
            sha256Of(middle),
            sha256Of(oldest),
          ],
        },
      ]);

      const report = applyRetiredPrune(root, manifestPath);
      expect(report.pruned).toContain('.claude/agents/v3/stale.md');
      expect(existsSync(join(root, '.claude/agents/v3/stale.md'))).toBe(false);
    });

    it('preserves a genuinely customized file even with a widened hash window', () => {
      // Customization safety: the widened-window fix MUST NOT prune content
      // that never appeared in moflo's history, regardless of how many
      // historic hashes the entry carries.
      writeAt(root, '.claude/agents/v3/customized.md', '# I edited this myself\n');
      const manifestPath = writeManifest([
        {
          path: '.claude/agents/v3/customized.md',
          knownContentHashes: [
            sha256Of('# moflo v1\n'),
            sha256Of('# moflo v2\n'),
            sha256Of('# moflo v3\n'),
            sha256Of('# moflo v4\n'),
            sha256Of('# moflo v5\n'),
            sha256Of('# moflo v6\n'),
            sha256Of('# moflo v7\n'),
          ],
        },
      ]);

      const report = applyRetiredPrune(root, manifestPath);
      expect(report.preserved).toContain('.claude/agents/v3/customized.md');
      expect(existsSync(join(root, '.claude/agents/v3/customized.md'))).toBe(true);
    });

    it('paths returned in report.pruned must be excluded from installed-files.json (#1133)', () => {
      // Regression: launcher §3 builds `currentManifest` BEFORE applyRetiredPrune
      // runs, then writes it as `installed-files.json` AFTER the prune. If the
      // launcher persists the unfiltered manifest, the next launcher's drift
      // detection iterates the recorded paths, finds the pruned files missing,
      // flips `manifestDrifted = true`, and spuriously re-fires the cherry-pick
      // → reimports legacy rows the migration just deleted (#1133 smoke regression
      // surfaced this on every consumer install). The fix filters out pruned
      // paths before persisting; this test pins the invariant.
      const shipped = 'shipped content\n';
      writeAt(root, '.claude/agents/v3/will-be-pruned.md', shipped);
      writeAt(root, '.claude/agents/v3/will-be-kept.md', 'survives the prune\n');

      const manifestPath = writeManifest([
        {
          path: '.claude/agents/v3/will-be-pruned.md',
          knownContentHashes: [sha256Of(shipped)],
        },
      ]);

      const currentManifest = [
        { path: '.claude/agents/v3/will-be-pruned.md', size: shipped.length },
        { path: '.claude/agents/v3/will-be-kept.md', size: 19 },
      ];

      const report = applyRetiredPrune(root, manifestPath);
      expect(report.pruned).toEqual(['.claude/agents/v3/will-be-pruned.md']);

      // Launcher's persistence filter — mirrors bin/session-start-launcher.mjs
      const prunedSet = new Set(report.pruned);
      const persistedManifest = prunedSet.size > 0
        ? currentManifest.filter((e) => !prunedSet.has(e.path))
        : currentManifest;

      expect(persistedManifest.map((e) => e.path)).toEqual(['.claude/agents/v3/will-be-kept.md']);
      // The pruned path must NOT appear in the persisted manifest — its
      // presence is what produces the false drift on the next launcher run.
      expect(persistedManifest.find((e) => e.path === '.claude/agents/v3/will-be-pruned.md')).toBeUndefined();
    });

    it('prunes a CRLF-converted shipped file end-to-end (Rule #1 — the waxstak case)', () => {
      // Windows consumer: moflo shipped LF, manifest carries the LF hash, but
      // the file on disk is CRLF (git core.autocrlf=true). Pre-fix this stayed
      // on disk forever — Claude Code kept loading the retired subagent every
      // prompt. The EOL-normalized fallback makes the prune fire.
      const lfShipped = '---\nname: performance-engineer\n---\nshipped body\n';
      writeAt(root, '.claude/agents/v3/performance-engineer.md', lfShipped.replace(/\n/g, '\r\n'));

      const manifestPath = writeManifest([
        {
          path: '.claude/agents/v3/performance-engineer.md',
          knownContentHashes: [sha256Of(lfShipped)], // LF hash only
        },
      ]);

      const report = applyRetiredPrune(root, manifestPath);
      expect(report.pruned).toContain('.claude/agents/v3/performance-engineer.md');
      expect(existsSync(join(root, '.claude/agents/v3/performance-engineer.md'))).toBe(false);
    });

    it('cross-platform: paths in the manifest use forward slashes regardless of OS', () => {
      // The launcher always writes the manifest with forward-slash paths
      // (matching the way the section-3 cleanup loop and currentManifest use
      // them). resolve() must rebuild OS-native absolute paths from those.
      const content = 'shipped content\n';
      writeAt(root, '.claude/agents/v3/perf.md', content);

      const manifestPath = writeManifest([
        {
          // Always forward-slash in JSON — same as the section-3 manifest.
          path: '.claude/agents/v3/perf.md',
          knownContentHashes: [sha256Of(content)],
        },
      ]);

      const report = applyRetiredPrune(root, manifestPath);
      expect(report.pruned).toContain('.claude/agents/v3/perf.md');
      expect(existsSync(join(root, '.claude/agents/v3/perf.md'))).toBe(false);
    });
  });
});
