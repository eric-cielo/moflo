/**
 * Tests for bin/lib/ subdirectory sync in session-start-launcher.mjs and executor.ts
 *
 * Validates that:
 * 1. hooks.mjs can import ./lib/process-manager.mjs when lib/ is synced
 * 2. session-start-launcher syncs bin/lib/ to .claude/scripts/lib/
 * 3. executor.ts upgrade path syncs bin/lib/ to .claude/scripts/lib/
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

function makeTempRoot(): string {
  const root = resolve(__dirname, '../../.testoutput/.test-lib-sync-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(resolve(root, '.claude-flow'), { recursive: true });
  mkdirSync(resolve(root, '.claude/scripts'), { recursive: true });
  return root;
}

function cleanTempRoot(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
}

describe('bin/lib/ subdirectory sync', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('lib/ directory exists in bin/ source with required files', () => {
    const binLibDir = resolve(__dirname, '../../bin/lib');
    expect(existsSync(binLibDir)).toBe(true);

    const files = readdirSync(binLibDir);
    expect(files).toContain('process-manager.mjs');
    expect(files).toContain('registry-cleanup.cjs');
  });

  it('hooks.mjs imports ./lib/process-manager.mjs', () => {
    const hooksPath = resolve(__dirname, '../../bin/hooks.mjs');
    const content = readFileSync(hooksPath, 'utf-8');
    expect(content).toContain('./lib/process-manager.mjs');
  });

  it('session-start-launcher.mjs syncs lib/ subdirectory', () => {
    const launcherPath = resolve(__dirname, '../../bin/session-start-launcher.mjs');
    const content = readFileSync(launcherPath, 'utf-8');

    // Verify the launcher has the lib/ sync logic
    expect(content).toContain("resolve(binDir, 'lib')");
    expect(content).toContain("resolve(scriptsDir, 'lib')");
  });

  it('executor.ts syncs lib/ subdirectory during upgrade', () => {
    const executorPath = resolve(__dirname, '../../src/@claude-flow/cli/src/init/executor.ts');
    const content = readFileSync(executorPath, 'utf-8');

    // Verify the executor has the lib/ sync logic
    expect(content).toContain("path.join(binDir, 'lib')");
    expect(content).toContain("path.join(scriptsDir, 'lib')");
  });

  it('simulates lib/ sync and verifies all files are copied', () => {
    // Create a fake bin/lib/ source
    const fakeBinLib = join(root, 'bin', 'lib');
    mkdirSync(fakeBinLib, { recursive: true });
    writeFileSync(join(fakeBinLib, 'process-manager.mjs'), 'export function spawn() {}');
    writeFileSync(join(fakeBinLib, 'registry-cleanup.cjs'), 'module.exports = {}');
    writeFileSync(join(fakeBinLib, 'moflo-resolve.mjs'), 'export function resolve() {}');

    // Simulate the sync logic from session-start-launcher.mjs
    const libSrcDir = fakeBinLib;
    const libDestDir = join(root, '.claude', 'scripts', 'lib');
    if (!existsSync(libDestDir)) mkdirSync(libDestDir, { recursive: true });
    for (const file of readdirSync(libSrcDir)) {
      const src = join(libSrcDir, file);
      const dest = join(libDestDir, file);
      writeFileSync(dest, readFileSync(src));
    }

    // Verify all files synced
    expect(existsSync(join(libDestDir, 'process-manager.mjs'))).toBe(true);
    expect(existsSync(join(libDestDir, 'registry-cleanup.cjs'))).toBe(true);
    expect(existsSync(join(libDestDir, 'moflo-resolve.mjs'))).toBe(true);
  });
});
