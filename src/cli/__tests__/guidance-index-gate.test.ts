/**
 * Regression tests for #1323 — the `guidance-index` step gate fingerprinted a
 * hardcoded `.claude/guidance` while the guidance indexer walked every
 * directory under `guidance.directories`. Any configured directory beyond the
 * default was indexed but never gated, so edits there never invalidated the
 * fingerprint and the guidance namespace served pre-edit content indefinitely.
 *
 * The failure is invisible from the outside: embeddings regenerate from the
 * same stale rows, so text and vectors stay consistently wrong together and
 * nothing downstream detects the drift. That makes an explicit gate test the
 * only thing standing between a config change and silent staleness.
 *
 * Cross-platform (Rule #1): temp roots go through `realpathSync` because macOS
 * `os.tmpdir()` is a symlink (`/var` → `/private/var`); mtimes are stamped
 * explicitly with `utimesSync` rather than relying on filesystem timestamp
 * granularity, which differs across ext4/APFS/NTFS.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { computeStepFingerprint } from '../../../bin/lib/index-fingerprint.mjs';
import {
  readGuidanceConfig,
  resolveGuidanceDirs,
  DEFAULT_GUIDANCE_DIRS,
  _resetGuidanceConfigCache,
} from '../../../bin/lib/guidance-config.mjs';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

let root: string;

/** Write a file and stamp it at a fixed, comfortably-future mtime. */
function writeAt(rel: string, contents: string, epochSeconds: number): void {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
  utimesSync(full, epochSeconds, epochSeconds);
}

function fingerprint(): Record<string, unknown> {
  _resetGuidanceConfigCache();
  return computeStepFingerprint('guidance-index', root) as Record<string, unknown>;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'moflo-1323-')));
  _resetGuidanceConfigCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  _resetGuidanceConfigCache();
});

describe('#1323 guidance-index gate honours configured directories', () => {
  const CONFIG = [
    'guidance:',
    '  directories:',
    '    - .claude/guidance',
    '    - docs',
    '  namespace: guidance',
    '',
  ].join('\n');

  it('an edit in a NON-default configured directory invalidates the gate', () => {
    writeFileSync(path.join(root, 'moflo.yaml'), CONFIG);
    writeAt('.claude/guidance/a.md', '# a', 1_700_000_000);
    writeAt('docs/b.md', '# b', 1_700_000_000);

    const before = fingerprint();
    writeAt('docs/b.md', '# b edited', 1_700_009_999); // only docs/ moves
    const after = fingerprint();

    expect(after).not.toEqual(before);
  });

  it('an edit in .claude/guidance still invalidates the gate', () => {
    writeFileSync(path.join(root, 'moflo.yaml'), CONFIG);
    writeAt('.claude/guidance/a.md', '# a', 1_700_000_000);
    writeAt('docs/b.md', '# b', 1_700_000_000);

    const before = fingerprint();
    writeAt('.claude/guidance/a.md', '# a edited', 1_700_009_999);

    expect(fingerprint()).not.toEqual(before);
  });

  it('a project with only the default directory behaves as before', () => {
    // No moflo.yaml at all — defaults apply, and the gate still tracks edits.
    writeAt('.claude/guidance/a.md', '# a', 1_700_000_000);
    const before = fingerprint();
    writeAt('.claude/guidance/a.md', '# a edited', 1_700_009_999);
    expect(fingerprint()).not.toEqual(before);
  });

  it('an unrelated directory does NOT invalidate the gate (no over-firing)', () => {
    writeFileSync(path.join(root, 'moflo.yaml'), CONFIG);
    writeAt('.claude/guidance/a.md', '# a', 1_700_000_000);
    writeAt('docs/b.md', '# b', 1_700_000_000);

    const before = fingerprint();
    writeAt('src/unrelated.ts', 'export const x = 1;', 1_700_009_999);

    expect(fingerprint()).toEqual(before);
  });
});

describe('#1323 config resolution is total (never throws)', () => {
  it('falls back to defaults when guidance.directories is unset', () => {
    writeFileSync(path.join(root, 'moflo.yaml'), 'project:\n  name: x\n');
    expect(resolveGuidanceDirs(root)).toEqual(DEFAULT_GUIDANCE_DIRS);
  });

  it('falls back when the config is malformed rather than throwing', () => {
    writeFileSync(path.join(root, 'moflo.yaml'), 'guidance:\n  directories:\n@@ not yaml @@\n');
    expect(() => resolveGuidanceDirs(root)).not.toThrow();
    expect(resolveGuidanceDirs(root)).toEqual(DEFAULT_GUIDANCE_DIRS);
  });

  it('falls back when there is no config file at all', () => {
    expect(resolveGuidanceDirs(root)).toEqual(DEFAULT_GUIDANCE_DIRS);
  });

  it('strips inline comments and quotes, and drops empty entries', () => {
    writeFileSync(
      path.join(root, 'moflo.yaml'),
      'guidance:\n  directories:\n    - ".claude/guidance"   # primary\n    - docs\n',
    );
    expect(resolveGuidanceDirs(root)).toEqual(['.claude/guidance', 'docs']);
  });

  it('reads moflo.config.json when moflo.yaml is absent', () => {
    writeFileSync(
      path.join(root, 'moflo.config.json'),
      JSON.stringify({ guidance: { directories: ['a', 'b'] }, sdd: { specs_dir: 'specs' } }),
    );
    expect(resolveGuidanceDirs(root)).toEqual(['a', 'b']);
    expect(readGuidanceConfig(root).specsDir).toBe('specs');
  });
});

describe('#1323 the gate and the indexer share one resolver', () => {
  // The defect was two components disagreeing about one config key. A second
  // independent parse anywhere re-creates it, so assert the wiring directly.
  it('index-guidance.mjs and index-fingerprint.mjs both import guidance-config', () => {
    for (const file of ['bin/index-guidance.mjs', 'bin/lib/index-fingerprint.mjs']) {
      const src = readFileSync(path.join(repoRoot, file), 'utf-8');
      expect(src, `${file} must use the shared resolver`).toMatch(/from '\.\/(lib\/)?guidance-config\.mjs'/);
      // And must NOT re-parse the guidance block itself — a second parse is
      // exactly how the gate and the indexer drifted apart.
      expect(src, `${file} re-parses guidance.directories`).not.toMatch(/directories:\\s\*\\n/);
    }
  });
});

describe('#1323 index-all.mjs argument handling', () => {
  const script = path.join(repoRoot, 'bin', 'index-all.mjs');

  const run = (args: string[]) => {
    try {
      const stdout = execFileSync(process.execPath, [script, ...args], {
        encoding: 'utf-8',
        cwd: root,
        windowsHide: true,
      });
      return { code: 0, out: stdout };
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: (err.stdout ?? '') + (err.stderr ?? '') };
    }
  };

  it('--help exits 0 and documents --force', () => {
    const { code, out } = run(['--help']);
    expect(code).toBe(0);
    expect(out).toMatch(/--force/);
    expect(out).toMatch(/FLO_FORCE_INDEX/);
  });

  it('an unknown argument exits non-zero instead of silently no-opping', () => {
    // The original defect: `--force` was accepted and ignored, so a no-op was
    // indistinguishable from a successful forced reindex.
    const { code, out } = run(['--bogus']);
    expect(code).not.toBe(0);
    expect(out).toMatch(/unknown argument/i);
  });

  it('a typo of --force is rejected rather than treated as a successful run', () => {
    const { code } = run(['--forcee']);
    expect(code).not.toBe(0);
  });
});
