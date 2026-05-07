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
