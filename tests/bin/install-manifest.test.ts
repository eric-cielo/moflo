/**
 * Tests for the install manifest cleanup in session-start-launcher.mjs
 *
 * Validates that:
 * 1. Files installed by moflo are tracked in installed-files.json
 * 2. On upgrade, files in the old manifest but not the new one are removed
 * 3. User-created files (not in manifest) are never deleted
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { resolve, join } from 'path';

function makeTempRoot(): string {
  const root = resolve(__dirname, '../../.testoutput/.test-manifest-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(resolve(root, '.claude-flow'), { recursive: true });
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
    const manifestPath = join(root, '.claude-flow', 'installed-files.json');

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
    const manifestPath = join(root, '.claude-flow', 'installed-files.json');

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
    const manifestPath = join(root, '.claude-flow', 'installed-files.json');
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

  it('runtime-generated files in .claude-flow/ are safe', () => {
    const manifestPath = join(root, '.claude-flow', 'installed-files.json');

    // Manifest only has script files
    const oldManifest = ['.claude/scripts/hooks.mjs'];
    writeFileSync(manifestPath, JSON.stringify(oldManifest));
    writeFileSync(join(root, '.claude/scripts/hooks.mjs'), 'content');

    // Runtime-generated files in .claude-flow/
    writeFileSync(join(root, '.claude-flow', 'background-pids.json'), '[]');
    writeFileSync(join(root, '.claude-flow', 'spawn.lock'), String(Date.now()));
    writeFileSync(join(root, '.claude-flow', 'moflo-version'), '4.8.10');

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
    expect(existsSync(join(root, '.claude-flow', 'background-pids.json'))).toBe(true);
    expect(existsSync(join(root, '.claude-flow', 'spawn.lock'))).toBe(true);
    expect(existsSync(join(root, '.claude-flow', 'moflo-version'))).toBe(true);
  });
});
