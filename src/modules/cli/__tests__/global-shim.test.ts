/**
 * Tests for the global `flo` CLI shim installer.
 *
 * The shim is installed into npm's global bin directory so bare `flo`
 * resolves to the local project's node_modules/.bin/flo without npx.
 *
 * Tests verify:
 * 1. Shim files are created with correct content
 * 2. Idempotency — re-running doesn't overwrite existing shims
 * 3. Non-moflo flo binaries are detected and replaced
 * 4. Graceful failure when global bin dir doesn't exist
 * 5. isGlobalShimInstalled detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Import the shared shim installer
const shimModulePath = path.resolve(process.cwd(), 'bin/lib/install-global-shim.mjs');
const shimUrl = `file://${shimModulePath.replace(/\\/g, '/')}`;

describe('install-global-shim', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-shim-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create shim files in the global bin directory', async () => {
    const { installGlobalShim } = await import(shimUrl);

    const result = installGlobalShim({ globalBin: tmpDir });

    expect(result.installed).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.path).toBe(tmpDir);

    // Verify Unix shim exists and has correct content
    const shFile = path.join(tmpDir, 'flo');
    expect(fs.existsSync(shFile)).toBe(true);
    const shContent = fs.readFileSync(shFile, 'utf-8');
    expect(shContent).toContain('#!/bin/sh');
    expect(shContent).toContain('MoFlo CLI shim');
    expect(shContent).toContain('node_modules/.bin/flo');

    if (process.platform === 'win32') {
      // Verify Windows cmd shim
      const cmdFile = path.join(tmpDir, 'flo.cmd');
      expect(fs.existsSync(cmdFile)).toBe(true);
      const cmdContent = fs.readFileSync(cmdFile, 'utf-8');
      expect(cmdContent).toContain('MoFlo CLI shim');
      expect(cmdContent).toContain('node_modules\\.bin\\flo.cmd');

      // Verify PowerShell shim
      const ps1File = path.join(tmpDir, 'flo.ps1');
      expect(fs.existsSync(ps1File)).toBe(true);
      const ps1Content = fs.readFileSync(ps1File, 'utf-8');
      expect(ps1Content).toContain('MoFlo CLI shim');
    }
  });

  it('should be idempotent — skip if shim already installed', async () => {
    const { installGlobalShim } = await import(shimUrl);

    // First install
    const first = installGlobalShim({ globalBin: tmpDir });
    expect(first.installed).toBe(true);

    // Second install — should not overwrite
    const second = installGlobalShim({ globalBin: tmpDir });
    expect(second.installed).toBe(false);
  });

  it('should replace a non-moflo flo binary', async () => {
    const { installGlobalShim } = await import(shimUrl);

    // Create a pre-existing flo that is NOT our shim
    const existingFlo = path.join(tmpDir, 'flo');
    fs.writeFileSync(existingFlo, '#!/bin/sh\necho "I am a different flo"\n');

    const result = installGlobalShim({ globalBin: tmpDir });

    // Should overwrite since it's not our shim
    expect(result.installed).toBe(true);

    // Verify it's now our shim
    const content = fs.readFileSync(existingFlo, 'utf-8');
    expect(content).toContain('MoFlo CLI shim');
  });

  it('should handle missing global bin directory gracefully', async () => {
    const { installGlobalShim } = await import(shimUrl);

    const fakePath = path.join(tmpDir, 'nonexistent', 'deep', 'path');
    const result = installGlobalShim({ globalBin: fakePath });

    expect(result.installed).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toContain('not found');
  });

  it('should detect installed shim via isGlobalShimInstalled', async () => {
    const { installGlobalShim, isGlobalShimInstalled } = await import(shimUrl);

    // Not installed yet
    expect(isGlobalShimInstalled(tmpDir)).toBe(false);

    // Install
    installGlobalShim({ globalBin: tmpDir });

    // Now installed
    expect(isGlobalShimInstalled(tmpDir)).toBe(true);
  });

  it('Unix shim should walk up directories to find node_modules/.bin/flo', async () => {
    const { installGlobalShim } = await import(shimUrl);

    installGlobalShim({ globalBin: tmpDir });

    const shFile = path.join(tmpDir, 'flo');
    const content = fs.readFileSync(shFile, 'utf-8');

    // Verify the directory-walking logic is present
    expect(content).toContain('while [ "$dir" != "/" ]');
    expect(content).toContain('node_modules/.bin/flo');
    expect(content).toContain('dir=$(dirname "$dir")');
    expect(content).toContain('no moflo installation found');
  });

  if (process.platform === 'win32') {
    it('Windows cmd shim should walk up directories to find flo.cmd', async () => {
      const { installGlobalShim } = await import(shimUrl);

      installGlobalShim({ globalBin: tmpDir });

      const cmdFile = path.join(tmpDir, 'flo.cmd');
      const content = fs.readFileSync(cmdFile, 'utf-8');

      // Verify the directory-walking logic is present
      expect(content).toContain(':loop');
      expect(content).toContain('node_modules\\.bin\\flo.cmd');
      expect(content).toContain('no moflo installation found');
    });

    it('PowerShell shim should walk up directories to find flo.ps1', async () => {
      const { installGlobalShim } = await import(shimUrl);

      installGlobalShim({ globalBin: tmpDir });

      const ps1File = path.join(tmpDir, 'flo.ps1');
      const content = fs.readFileSync(ps1File, 'utf-8');

      // Verify the directory-walking logic is present
      expect(content).toContain('while');
      expect(content).toContain('node_modules/.bin/flo.ps1');
      expect(content).toContain('no moflo installation found');
    });
  }
});
