/**
 * Tests for init copy-map iteration (commands, skills, agents).
 *
 * Regression: The old code hardcoded property accesses like
 *   COMMANDS_MAP.analysis, COMMANDS_MAP.automation
 * for keys that didn't exist in the map, causing
 *   "X is not iterable (cannot read property undefined)"
 * The fix iterates Object.entries() so new map keys are automatically covered.
 *
 * These tests verify:
 * 1. executeInit doesn't crash when config keys have no map entry
 * 2. The source code uses Object.entries() iteration (no hardcoded key access)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { executeInit, DEFAULT_INIT_OPTIONS } from '../src/init/index.js';
import type { InitOptions } from '../src/init/types.js';

// ============================================================================
// Runtime: executeInit doesn't crash on missing map keys
// ============================================================================

describe('init copy maps — no crash on missing keys', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-init-maps-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not throw when commands config has keys not in COMMANDS_MAP', async () => {
    const options: InitOptions = {
      ...DEFAULT_INIT_OPTIONS,
      targetDir: tmpDir,
      commands: {
        all: false,
        core: true,
        analysis: true,
        automation: true,
        monitoring: true,
        optimization: true,
        github: false,
        hooks: false,
        sparc: false,
      },
    };

    const result = await executeInit(options);
    expect(result).toBeDefined();
    expect(result.success).toBeDefined();
  });

  it('does not throw when agents config has keys not in AGENTS_MAP', async () => {
    const options: InitOptions = {
      ...DEFAULT_INIT_OPTIONS,
      targetDir: tmpDir,
      agents: {
        all: false,
        core: true,
        consensus: false,
        github: false,
        hiveMind: false,
        sparc: false,
        swarm: false,
        browser: false,
        v3: false,
        optimization: false,
        testing: false,
      },
    };

    const result = await executeInit(options);
    expect(result).toBeDefined();
    expect(result.success).toBeDefined();
  });
});

// ============================================================================
// Static: copy functions use Object.entries(), not hardcoded property access
// ============================================================================

describe('init copy maps — no hardcoded property access (structural regression)', () => {
  const executorPath = path.resolve(__dirname, '..', 'src', 'init', 'executor.ts');
  let source: string;

  beforeEach(() => {
    source = fs.readFileSync(executorPath, 'utf-8');
  });

  it('COMMANDS_MAP is only accessed via Object.entries or Object.values', () => {
    // Should NOT have patterns like COMMANDS_MAP.analysis, COMMANDS_MAP.core, etc.
    // (Object.values(...).flat() in the 'all' branch is fine)
    const hardcodedAccess = source.match(/COMMANDS_MAP\.\w+/g) ?? [];
    // Filter out Object.values(COMMANDS_MAP) and Object.entries(COMMANDS_MAP)
    const badAccesses = hardcodedAccess.filter(
      m => !m.startsWith('COMMANDS_MAP.flat') // shouldn't exist but guard
    );
    expect(badAccesses).toEqual([]);
  });

  it('SKILLS_MAP is only accessed via Object.entries or Object.values', () => {
    const hardcodedAccess = source.match(/SKILLS_MAP\.\w+/g) ?? [];
    expect(hardcodedAccess).toEqual([]);
  });

  it('AGENTS_MAP is only accessed via Object.entries or Object.values', () => {
    const hardcodedAccess = source.match(/AGENTS_MAP\.\w+/g) ?? [];
    expect(hardcodedAccess).toEqual([]);
  });

  it('copy functions use Object.entries() for iteration', () => {
    // Verify the pattern: for (const [key, ...] of Object.entries(COMMANDS_MAP))
    expect(source).toContain('Object.entries(COMMANDS_MAP)');
    expect(source).toContain('Object.entries(SKILLS_MAP)');
    expect(source).toContain('Object.entries(AGENTS_MAP)');
  });
});
