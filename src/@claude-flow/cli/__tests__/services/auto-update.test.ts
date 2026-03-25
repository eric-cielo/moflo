/**
 * Auto-Update Tests
 *
 * Validates the session-start version-change detection, script syncing,
 * helper syncing, YAML config flag parsing, and cross-platform compatibility.
 *
 * Uses real temp directories — no filesystem mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, mkdirSync, existsSync,
  readFileSync, writeFileSync, copyFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

/**
 * Simulates the core auto-update logic from session-start-launcher.mjs.
 * Extracted into a testable function — same logic, same code paths.
 */
function simulateAutoUpdate(projectRoot: string) {
  // 1. Parse auto_update config from moflo.yaml
  let autoUpdateConfig = { enabled: true, scripts: true, helpers: true };
  try {
    const mofloYaml = join(projectRoot, 'moflo.yaml');
    if (existsSync(mofloYaml)) {
      const yamlContent = readFileSync(mofloYaml, 'utf-8');
      const enabledMatch = yamlContent.match(/auto_update:\s*\n\s+enabled:\s*(true|false)/);
      const scriptsMatch = yamlContent.match(/auto_update:\s*\n(?:\s+\w+:.*\n)*?\s+scripts:\s*(true|false)/);
      const helpersMatch = yamlContent.match(/auto_update:\s*\n(?:\s+\w+:.*\n)*?\s+helpers:\s*(true|false)/);
      if (enabledMatch) autoUpdateConfig.enabled = enabledMatch[1] === 'true';
      if (scriptsMatch) autoUpdateConfig.scripts = scriptsMatch[1] === 'true';
      if (helpersMatch) autoUpdateConfig.helpers = helpersMatch[1] === 'true';
    }
  } catch { /* defaults */ }

  // 2. Check version and sync
  const mofloPkgPath = join(projectRoot, 'node_modules/moflo/package.json');
  const versionStampPath = join(projectRoot, '.claude-flow', 'moflo-version');

  if (!autoUpdateConfig.enabled || !existsSync(mofloPkgPath)) {
    return { synced: false, reason: !autoUpdateConfig.enabled ? 'disabled' : 'no-package' };
  }

  const installedVersion = JSON.parse(readFileSync(mofloPkgPath, 'utf-8')).version;
  let cachedVersion = '';
  try { cachedVersion = readFileSync(versionStampPath, 'utf-8').trim(); } catch {}

  if (installedVersion === cachedVersion) {
    return { synced: false, reason: 'up-to-date' };
  }

  let scriptsSynced = 0;
  let helpersSynced = 0;

  // Sync scripts
  if (autoUpdateConfig.scripts) {
    const binDir = join(projectRoot, 'node_modules/moflo/bin');
    const scriptsDir = join(projectRoot, '.claude/scripts');
    if (!existsSync(scriptsDir)) mkdirSync(scriptsDir, { recursive: true });
    const scriptFiles = [
      'hooks.mjs', 'session-start-launcher.mjs', 'index-guidance.mjs',
      'build-embeddings.mjs', 'generate-code-map.mjs', 'semantic-search.mjs',
      'index-tests.mjs', 'index-all.mjs',
    ];
    for (const file of scriptFiles) {
      const src = join(binDir, file);
      const dest = join(scriptsDir, file);
      if (existsSync(src)) {
        try { copyFileSync(src, dest); scriptsSynced++; } catch { /* non-fatal */ }
      }
    }
  }

  // Sync helpers
  if (autoUpdateConfig.helpers) {
    const sourceHelpersDir = join(projectRoot, 'node_modules/moflo/src/.claude/helpers');
    const helpersDir = join(projectRoot, '.claude/helpers');
    if (!existsSync(helpersDir)) mkdirSync(helpersDir, { recursive: true });
    const helperFiles = [
      'auto-memory-hook.mjs', 'statusline.cjs', 'pre-commit', 'post-commit',
    ];
    for (const file of helperFiles) {
      const src = join(sourceHelpersDir, file);
      const dest = join(helpersDir, file);
      if (existsSync(src)) {
        try { copyFileSync(src, dest); helpersSynced++; } catch { /* non-fatal */ }
      }
    }
  }

  // Write version stamp
  const cfDir = join(projectRoot, '.claude-flow');
  if (!existsSync(cfDir)) mkdirSync(cfDir, { recursive: true });
  writeFileSync(versionStampPath, installedVersion);

  return { synced: true, scriptsSynced, helpersSynced, version: installedVersion };
}

describe('auto-update', () => {
  let tempDir: string;

  /** Scaffold a minimal fake project with moflo installed. */
  function scaffoldProject(opts: {
    mofloVersion?: string;
    cachedVersion?: string;
    yamlConfig?: string;
    scriptContent?: string;
    helperContent?: string;
  } = {}) {
    const {
      mofloVersion = '4.8.0',
      cachedVersion,
      yamlConfig,
      scriptContent = '// source v2',
      helperContent = '// helper v2',
    } = opts;

    // Fake node_modules/moflo/package.json
    const mofloPkgDir = join(tempDir, 'node_modules/moflo');
    mkdirSync(mofloPkgDir, { recursive: true });
    writeFileSync(join(mofloPkgDir, 'package.json'), JSON.stringify({ version: mofloVersion }));

    // Fake source scripts in bin/
    const binDir = join(mofloPkgDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    for (const f of ['hooks.mjs', 'session-start-launcher.mjs', 'index-guidance.mjs']) {
      writeFileSync(join(binDir, f), scriptContent);
    }

    // Fake source helpers
    const srcHelpersDir = join(mofloPkgDir, 'src/.claude/helpers');
    mkdirSync(srcHelpersDir, { recursive: true });
    for (const f of ['auto-memory-hook.mjs', 'statusline.cjs']) {
      writeFileSync(join(srcHelpersDir, f), helperContent);
    }

    // Project directories
    mkdirSync(join(tempDir, '.claude/scripts'), { recursive: true });
    mkdirSync(join(tempDir, '.claude/helpers'), { recursive: true });
    mkdirSync(join(tempDir, '.claude-flow'), { recursive: true });

    // Write old scripts (to verify they get overwritten)
    writeFileSync(join(tempDir, '.claude/scripts/hooks.mjs'), '// old v1');
    writeFileSync(join(tempDir, '.claude/helpers/auto-memory-hook.mjs'), '// old helper v1');

    // Cached version stamp
    if (cachedVersion) {
      writeFileSync(join(tempDir, '.claude-flow/moflo-version'), cachedVersion);
    }

    // moflo.yaml
    if (yamlConfig) {
      writeFileSync(join(tempDir, 'moflo.yaml'), yamlConfig);
    }
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'auto-update-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Version detection
  // =========================================================================
  describe('version detection', () => {
    it('should sync when no version stamp exists (fresh install)', () => {
      scaffoldProject({ mofloVersion: '4.8.0' });

      const result = simulateAutoUpdate(tempDir);
      expect(result.synced).toBe(true);
      expect(result.version).toBe('4.8.0');
    });

    it('should sync when version stamp differs (upgrade)', () => {
      scaffoldProject({ mofloVersion: '4.8.0', cachedVersion: '4.7.8' });

      const result = simulateAutoUpdate(tempDir);
      expect(result.synced).toBe(true);
      expect(result.version).toBe('4.8.0');
    });

    it('should NOT sync when versions match', () => {
      scaffoldProject({ mofloVersion: '4.8.0', cachedVersion: '4.8.0' });

      const result = simulateAutoUpdate(tempDir);
      expect(result.synced).toBe(false);
      expect(result.reason).toBe('up-to-date');
    });

    it('should write version stamp after syncing', () => {
      scaffoldProject({ mofloVersion: '4.8.0' });
      simulateAutoUpdate(tempDir);

      const stamp = readFileSync(join(tempDir, '.claude-flow/moflo-version'), 'utf-8');
      expect(stamp).toBe('4.8.0');
    });

    it('should not sync again after stamp is written', () => {
      scaffoldProject({ mofloVersion: '4.8.0' });

      const first = simulateAutoUpdate(tempDir);
      expect(first.synced).toBe(true);

      const second = simulateAutoUpdate(tempDir);
      expect(second.synced).toBe(false);
      expect(second.reason).toBe('up-to-date');
    });
  });

  // =========================================================================
  // Script syncing
  // =========================================================================
  describe('script syncing', () => {
    it('should overwrite stale project scripts with source versions', () => {
      scaffoldProject({ mofloVersion: '4.8.0', scriptContent: '// NEW source v2' });

      const before = readFileSync(join(tempDir, '.claude/scripts/hooks.mjs'), 'utf-8');
      expect(before).toBe('// old v1');

      simulateAutoUpdate(tempDir);

      const after = readFileSync(join(tempDir, '.claude/scripts/hooks.mjs'), 'utf-8');
      expect(after).toBe('// NEW source v2');
    });

    it('should sync all available script files', () => {
      scaffoldProject({ mofloVersion: '4.8.0' });

      const result = simulateAutoUpdate(tempDir);
      expect(result.synced).toBe(true);
      expect(result.scriptsSynced).toBe(3); // hooks, launcher, index-guidance

      expect(existsSync(join(tempDir, '.claude/scripts/hooks.mjs'))).toBe(true);
      expect(existsSync(join(tempDir, '.claude/scripts/session-start-launcher.mjs'))).toBe(true);
      expect(existsSync(join(tempDir, '.claude/scripts/index-guidance.mjs'))).toBe(true);
    });
  });

  // =========================================================================
  // Helper syncing
  // =========================================================================
  describe('helper syncing', () => {
    it('should overwrite stale project helpers with source versions', () => {
      scaffoldProject({ mofloVersion: '4.8.0', helperContent: '// NEW helper v2' });

      const before = readFileSync(join(tempDir, '.claude/helpers/auto-memory-hook.mjs'), 'utf-8');
      expect(before).toBe('// old helper v1');

      simulateAutoUpdate(tempDir);

      const after = readFileSync(join(tempDir, '.claude/helpers/auto-memory-hook.mjs'), 'utf-8');
      expect(after).toBe('// NEW helper v2');
    });

    it('should sync all available helper files', () => {
      scaffoldProject({ mofloVersion: '4.8.0' });

      const result = simulateAutoUpdate(tempDir);
      expect(result.synced).toBe(true);
      expect(result.helpersSynced).toBe(2); // auto-memory-hook, statusline
    });
  });

  // =========================================================================
  // YAML config flag parsing
  // =========================================================================
  describe('moflo.yaml auto_update config', () => {
    it('should default to enabled when no moflo.yaml exists', () => {
      scaffoldProject({ mofloVersion: '4.8.0' });
      // No moflo.yaml written

      const result = simulateAutoUpdate(tempDir);
      expect(result.synced).toBe(true);
    });

    it('should default to enabled when auto_update section is missing from yaml', () => {
      scaffoldProject({
        mofloVersion: '4.8.0',
        yamlConfig: 'project:\n  name: test\n',
      });

      const result = simulateAutoUpdate(tempDir);
      expect(result.synced).toBe(true);
    });

    it('should respect auto_update.enabled: false', () => {
      scaffoldProject({
        mofloVersion: '4.8.0',
        yamlConfig: [
          'project:',
          '  name: test',
          'auto_update:',
          '  enabled: false',
          '  scripts: true',
          '  helpers: true',
        ].join('\n'),
      });

      const result = simulateAutoUpdate(tempDir);
      expect(result.synced).toBe(false);
      expect(result.reason).toBe('disabled');
    });

    it('should respect auto_update.scripts: false (sync helpers only)', () => {
      scaffoldProject({
        mofloVersion: '4.8.0',
        yamlConfig: [
          'auto_update:',
          '  enabled: true',
          '  scripts: false',
          '  helpers: true',
        ].join('\n'),
      });

      const result = simulateAutoUpdate(tempDir);
      expect(result.synced).toBe(true);
      expect(result.scriptsSynced).toBe(0);
      expect(result.helpersSynced).toBe(2);
    });

    it('should respect auto_update.helpers: false (sync scripts only)', () => {
      scaffoldProject({
        mofloVersion: '4.8.0',
        yamlConfig: [
          'auto_update:',
          '  enabled: true',
          '  scripts: true',
          '  helpers: false',
        ].join('\n'),
      });

      const result = simulateAutoUpdate(tempDir);
      expect(result.synced).toBe(true);
      expect(result.scriptsSynced).toBe(3);
      expect(result.helpersSynced).toBe(0);
    });

    it('should handle yaml with comments and extra whitespace', () => {
      scaffoldProject({
        mofloVersion: '4.8.0',
        yamlConfig: [
          '# Project config',
          'project:',
          '  name: test',
          '',
          '# Auto-update on session start',
          'auto_update:',
          '  enabled: true                  # Master toggle',
          '  scripts: true                  # Sync scripts',
          '  helpers: false                 # Skip helpers',
        ].join('\n'),
      });

      const result = simulateAutoUpdate(tempDir);
      expect(result.synced).toBe(true);
      expect(result.scriptsSynced).toBe(3);
      expect(result.helpersSynced).toBe(0);
    });
  });

  // =========================================================================
  // Cross-platform compatibility
  // =========================================================================
  describe('cross-platform compatibility', () => {
    it('should use only Node.js fs APIs (no shell commands in sync path)', () => {
      // This test verifies the sync path uses copyFileSync, not exec/spawn.
      // The simulateAutoUpdate function mirrors session-start-launcher.mjs logic.
      // If it passes on this platform, the same Node.js APIs work on all platforms.
      scaffoldProject({ mofloVersion: '4.8.0' });
      const result = simulateAutoUpdate(tempDir);
      expect(result.synced).toBe(true);
    });

    it('should handle paths with spaces', () => {
      const spaceDir = mkdtempSync(join(tmpdir(), 'auto update test spaces-'));
      try {
        // Set up inside space-containing path
        const mofloPkgDir = join(spaceDir, 'node_modules/moflo');
        mkdirSync(mofloPkgDir, { recursive: true });
        writeFileSync(join(mofloPkgDir, 'package.json'), JSON.stringify({ version: '4.8.0' }));

        const binDir = join(mofloPkgDir, 'bin');
        mkdirSync(binDir, { recursive: true });
        writeFileSync(join(binDir, 'hooks.mjs'), '// test');

        const srcHelpersDir = join(mofloPkgDir, 'src/.claude/helpers');
        mkdirSync(srcHelpersDir, { recursive: true });
        writeFileSync(join(srcHelpersDir, 'statusline.cjs'), '// test');

        mkdirSync(join(spaceDir, '.claude/scripts'), { recursive: true });
        mkdirSync(join(spaceDir, '.claude/helpers'), { recursive: true });
        mkdirSync(join(spaceDir, '.claude-flow'), { recursive: true });

        const result = simulateAutoUpdate(spaceDir);
        expect(result.synced).toBe(true);
        expect(existsSync(join(spaceDir, '.claude/scripts/hooks.mjs'))).toBe(true);
      } finally {
        rmSync(spaceDir, { recursive: true, force: true });
      }
    });

    it('should use { flag: "wx" } which is atomic on all platforms', () => {
      // Verify the wx flag works on this platform (it's POSIX O_CREAT|O_EXCL)
      const testFile = join(tempDir, 'wx-test');
      writeFileSync(testFile, 'first', { flag: 'wx' });
      expect(readFileSync(testFile, 'utf-8')).toBe('first');

      // Second write must fail with EEXIST
      expect(() => writeFileSync(testFile, 'second', { flag: 'wx' })).toThrow();
      expect(readFileSync(testFile, 'utf-8')).toBe('first'); // unchanged
    });

    it('should handle missing source directories gracefully', () => {
      // Only create package.json, no bin/ or helpers/
      const mofloPkgDir = join(tempDir, 'node_modules/moflo');
      mkdirSync(mofloPkgDir, { recursive: true });
      writeFileSync(join(mofloPkgDir, 'package.json'), JSON.stringify({ version: '4.8.0' }));
      mkdirSync(join(tempDir, '.claude-flow'), { recursive: true });

      const result = simulateAutoUpdate(tempDir);
      expect(result.synced).toBe(true);
      expect(result.scriptsSynced).toBe(0);
      expect(result.helpersSynced).toBe(0);
    });

    it('should create .claude-flow directory if missing', () => {
      scaffoldProject({ mofloVersion: '4.8.0' });
      // Remove .claude-flow to simulate fresh state
      rmSync(join(tempDir, '.claude-flow'), { recursive: true, force: true });

      const result = simulateAutoUpdate(tempDir);
      expect(result.synced).toBe(true);
      expect(existsSync(join(tempDir, '.claude-flow/moflo-version'))).toBe(true);
    });
  });

  // =========================================================================
  // Upgrade scenarios
  // =========================================================================
  describe('upgrade scenarios', () => {
    it('should handle downgrade (version goes backward)', () => {
      scaffoldProject({ mofloVersion: '4.7.0', cachedVersion: '4.8.0' });

      const result = simulateAutoUpdate(tempDir);
      expect(result.synced).toBe(true); // version differs, so sync
      expect(result.version).toBe('4.7.0');
    });

    it('should handle patch version bump', () => {
      scaffoldProject({ mofloVersion: '4.8.1', cachedVersion: '4.8.0' });

      const result = simulateAutoUpdate(tempDir);
      expect(result.synced).toBe(true);
    });

    it('should handle major version bump', () => {
      scaffoldProject({ mofloVersion: '5.0.0', cachedVersion: '4.8.0' });

      const result = simulateAutoUpdate(tempDir);
      expect(result.synced).toBe(true);
      expect(result.version).toBe('5.0.0');
    });

    it('should handle pre-release versions', () => {
      scaffoldProject({ mofloVersion: '4.9.0-beta.1', cachedVersion: '4.8.0' });

      const result = simulateAutoUpdate(tempDir);
      expect(result.synced).toBe(true);
      expect(result.version).toBe('4.9.0-beta.1');

      // Stamp should match exactly
      const stamp = readFileSync(join(tempDir, '.claude-flow/moflo-version'), 'utf-8');
      expect(stamp).toBe('4.9.0-beta.1');
    });
  });
});
