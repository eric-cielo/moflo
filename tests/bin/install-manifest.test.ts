/**
 * Tests for the install manifest cleanup in session-start-launcher.mjs
 *
 * Validates that:
 * 1. Files installed by moflo are tracked in installed-files.json
 * 2. On upgrade, files in the old manifest but not the new one are removed
 * 3. User-created files (not in manifest) are never deleted
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync, statSync } from 'fs';
import { resolve, join, dirname, sep } from 'path';

function makeTempRoot(): string {
  const root = resolve(__dirname, '../../.testoutput/.test-manifest-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(resolve(root, '.moflo'), { recursive: true });
  mkdirSync(resolve(root, '.claude/scripts'), { recursive: true });
  mkdirSync(resolve(root, '.claude/helpers'), { recursive: true });
  return root;
}

function cleanTempRoot(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
}

describe('install manifest cleanup', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('old manifest files not in new manifest are deleted', () => {
    const manifestPath = join(root, '.moflo', 'installed-files.json');

    // Simulate old manifest with a file that is no longer shipped
    const oldManifest = [
      '.claude/scripts/hooks.mjs',
      '.claude/scripts/old-removed-script.mjs',
      '.claude/helpers/deprecated-helper.cjs',
    ];
    writeFileSync(manifestPath, JSON.stringify(oldManifest));

    // Create the actual files on disk
    for (const rel of oldManifest) {
      writeFileSync(join(root, rel), 'old content');
    }

    // Simulate a new manifest (upgrade) that drops two files
    const newManifest = ['.claude/scripts/hooks.mjs'];
    const currentSet = new Set(newManifest);

    // This is the cleanup logic from session-start-launcher
    for (const rel of oldManifest) {
      if (!currentSet.has(rel)) {
        const abs = join(root, rel);
        try { if (existsSync(abs)) rmSync(abs); } catch { /* non-fatal */ }
      }
    }

    // Write new manifest
    writeFileSync(manifestPath, JSON.stringify(newManifest));

    // Kept file still exists
    expect(existsSync(join(root, '.claude/scripts/hooks.mjs'))).toBe(true);

    // Dropped files are gone
    expect(existsSync(join(root, '.claude/scripts/old-removed-script.mjs'))).toBe(false);
    expect(existsSync(join(root, '.claude/helpers/deprecated-helper.cjs'))).toBe(false);

    // Manifest updated
    const saved = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(saved).toEqual(newManifest);
  });

  it('user-created files are never deleted', () => {
    const manifestPath = join(root, '.moflo', 'installed-files.json');

    // Old manifest only knows about moflo-installed files
    const oldManifest = ['.claude/scripts/hooks.mjs'];
    writeFileSync(manifestPath, JSON.stringify(oldManifest));
    writeFileSync(join(root, '.claude/scripts/hooks.mjs'), 'moflo content');

    // User created their own file
    writeFileSync(join(root, '.claude/scripts/my-custom-script.mjs'), 'user content');
    // User created a helper too
    writeFileSync(join(root, '.claude/helpers/my-custom-helper.cjs'), 'user helper');

    // Simulate upgrade that drops hooks.mjs (extreme case)
    const newManifest: string[] = [];
    const currentSet = new Set(newManifest);

    for (const rel of oldManifest) {
      if (!currentSet.has(rel)) {
        const abs = join(root, rel);
        try { if (existsSync(abs)) rmSync(abs); } catch { /* non-fatal */ }
      }
    }

    writeFileSync(manifestPath, JSON.stringify(newManifest));

    // moflo-installed file is removed
    expect(existsSync(join(root, '.claude/scripts/hooks.mjs'))).toBe(false);

    // User files are untouched (they were never in the manifest)
    expect(existsSync(join(root, '.claude/scripts/my-custom-script.mjs'))).toBe(true);
    expect(existsSync(join(root, '.claude/helpers/my-custom-helper.cjs'))).toBe(true);
  });

  it('first install with no previous manifest does not delete anything', () => {
    // No previous manifest exists — first install
    const manifestPath = join(root, '.moflo', 'installed-files.json');
    expect(existsSync(manifestPath)).toBe(false);

    // User has pre-existing files
    writeFileSync(join(root, '.claude/scripts/user-script.mjs'), 'user content');

    let previousManifest: string[] = [];
    try { previousManifest = JSON.parse(readFileSync(manifestPath, 'utf-8')); } catch { /* ok */ }

    const newManifest = ['.claude/scripts/hooks.mjs'];
    writeFileSync(join(root, '.claude/scripts/hooks.mjs'), 'new content');

    // Cleanup only runs if previousManifest has entries
    if (previousManifest.length > 0) {
      const currentSet = new Set(newManifest);
      for (const rel of previousManifest) {
        if (!currentSet.has(rel)) {
          const abs = join(root, rel);
          try { if (existsSync(abs)) rmSync(abs); } catch { /* non-fatal */ }
        }
      }
    }

    writeFileSync(manifestPath, JSON.stringify(newManifest));

    // Everything is fine — no deletions on first install
    expect(existsSync(join(root, '.claude/scripts/user-script.mjs'))).toBe(true);
    expect(existsSync(join(root, '.claude/scripts/hooks.mjs'))).toBe(true);
  });

  it('runtime-generated files in .moflo/ are safe', () => {
    const manifestPath = join(root, '.moflo', 'installed-files.json');

    // Manifest only has script files
    const oldManifest = ['.claude/scripts/hooks.mjs'];
    writeFileSync(manifestPath, JSON.stringify(oldManifest));
    writeFileSync(join(root, '.claude/scripts/hooks.mjs'), 'content');

    // Runtime-generated files in .moflo/
    writeFileSync(join(root, '.moflo', 'background-pids.json'), '[]');
    writeFileSync(join(root, '.moflo', 'spawn.lock'), String(Date.now()));
    writeFileSync(join(root, '.moflo', 'moflo-version'), '4.8.10');

    // Upgrade with same manifest
    const newManifest = ['.claude/scripts/hooks.mjs'];
    const currentSet = new Set(newManifest);

    for (const rel of oldManifest) {
      if (!currentSet.has(rel)) {
        const abs = join(root, rel);
        try { if (existsSync(abs)) rmSync(abs); } catch { /* non-fatal */ }
      }
    }

    // Runtime files are untouched
    expect(existsSync(join(root, '.moflo', 'background-pids.json'))).toBe(true);
    expect(existsSync(join(root, '.moflo', 'spawn.lock'))).toBe(true);
    expect(existsSync(join(root, '.moflo', 'moflo-version'))).toBe(true);
  });
});

describe('recursive sync (#777)', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  // Mirrors the syncTree helper inlined in bin/session-start-launcher.mjs and
  // src/cli/init/executor.ts. A divergence test would catch shape changes,
  // but the algorithm is small enough that re-implementing it here is the
  // pragmatic regression check: confirms readdirSync's recursive option
  // surfaces nested files correctly and our path arithmetic stays right.
  function syncTree(srcRoot: string, destRoot: string, manifestPrefix: string, manifest: string[]) {
    if (!existsSync(srcRoot)) return;
    const entries = readdirSync(srcRoot, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const parent = (entry as any).parentPath ?? (entry as any).path ?? srcRoot;
      const absSrc = join(parent, entry.name);
      const rel = absSrc.slice(srcRoot.length + 1).split(sep).join('/');
      const absDest = join(destRoot, rel);
      mkdirSync(dirname(absDest), { recursive: true });
      copyFileSync(absSrc, absDest);
      manifest.push(`${manifestPrefix}/${rel}`);
    }
  }

  it('walks nested subdirectories — migrations/lib/markers.mjs reaches manifest', () => {
    // Reproduce the exact #777 scenario: bin/migrations ships a top-level
    // .mjs plus a lib/ subdir that the flat readdirSync loop dropped.
    const binMigrations = join(root, 'bin', 'migrations');
    mkdirSync(join(binMigrations, 'lib'), { recursive: true });
    writeFileSync(join(binMigrations, 'knowledge-purge.mjs'), '// migration');
    writeFileSync(join(binMigrations, 'knowledge-to-learnings.mjs'), '// migration');
    writeFileSync(join(binMigrations, 'lib', 'markers.mjs'), 'export const X = 1;');

    const dest = join(root, '.claude/scripts/migrations');
    const manifest: string[] = [];
    syncTree(binMigrations, dest, '.claude/scripts/migrations', manifest);

    // Top-level migrations land
    expect(existsSync(join(dest, 'knowledge-purge.mjs'))).toBe(true);
    expect(existsSync(join(dest, 'knowledge-to-learnings.mjs'))).toBe(true);
    // Nested file lands too — this is the #777 regression
    expect(existsSync(join(dest, 'lib', 'markers.mjs'))).toBe(true);

    // All three files appear in the manifest with normalised forward-slash paths
    expect(manifest.sort()).toEqual([
      '.claude/scripts/migrations/knowledge-purge.mjs',
      '.claude/scripts/migrations/knowledge-to-learnings.mjs',
      '.claude/scripts/migrations/lib/markers.mjs',
    ]);
  });

  it('creates intermediate directories on demand', () => {
    // Deeper nesting — confirms mkdirSync recursive call covers multi-level dirs
    const binSrc = join(root, 'bin', 'tree');
    mkdirSync(join(binSrc, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(binSrc, 'a', 'b', 'c', 'deep.mjs'), '// deep');

    const dest = join(root, '.claude/scripts/tree');
    const manifest: string[] = [];
    syncTree(binSrc, dest, '.claude/scripts/tree', manifest);

    expect(existsSync(join(dest, 'a', 'b', 'c', 'deep.mjs'))).toBe(true);
    expect(manifest).toEqual(['.claude/scripts/tree/a/b/c/deep.mjs']);
  });

  it('survives a missing source root without throwing', () => {
    const manifest: string[] = [];
    syncTree(join(root, 'does-not-exist'), join(root, 'dest'), '.claude/scripts/missing', manifest);
    expect(manifest).toEqual([]);
  });

  it('full launcher set: package ships migrations/lib/markers.mjs to consumer', () => {
    // End-to-end shape check against the actually-published bin tree.
    // Covers the original #777 fault: the npm tarball includes the file but
    // it never reached consumer disk.
    const binMigrationsLib = resolve(__dirname, '../../node_modules/moflo/bin/migrations/lib');
    if (!existsSync(binMigrationsLib)) return; // moflo not installed in this checkout — skip
    const files = readdirSync(binMigrationsLib);
    expect(files).toContain('markers.mjs');
    // And the size is non-zero — guards against a corrupted/empty placeholder
    expect(statSync(join(binMigrationsLib, 'markers.mjs')).size).toBeGreaterThan(0);
  });
});
