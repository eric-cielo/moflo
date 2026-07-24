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
import { executeInit, DEFAULT_INIT_OPTIONS } from '../init/index.js';
import { SKILLS_MAP, AGENTS_MAP } from '../init/executor.js';
import type { InitOptions } from '../init/types.js';

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
  const executorPath = path.resolve(__dirname, '..', 'init', 'executor.ts');
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

  it('copy functions iterate their map generically, never category by category', () => {
    // The invariant is "adding a category requires no edit to the copy
    // function" — the #690/#694 orphan class. `Object.entries(...)` is one way
    // to satisfy it, not the invariant itself.
    expect(source).toContain('Object.entries(COMMANDS_MAP)');
    expect(source).toContain('Object.entries(AGENTS_MAP)');

    // copySkills iterates SKILL_CATEGORIES — the declared single source of
    // truth — and indexes SKILLS_MAP dynamically (#1308). That is strictly
    // stronger than Object.entries here: SKILLS_MAP is typed
    // `Record<SkillCategory, string[]>`, so adding a category to
    // SKILL_CATEGORIES makes a missing SKILLS_MAP key a COMPILE error, and
    // vice versa. Object.entries could not catch that — and its inverse, a
    // SKILLS_MAP key with no matching config key, is exactly the drift that
    // silently disabled the `memory` and `spells` categories.
    const iteratesGenerically =
      source.includes('Object.entries(SKILLS_MAP)') ||
      (source.includes('of SKILL_CATEGORIES') && source.includes('SKILLS_MAP[category]'));
    expect(
      iteratesGenerically,
      'copySkills must iterate SKILLS_MAP generically (Object.entries, or SKILL_CATEGORIES + dynamic index)',
    ).toBe(true);
  });

  it('SKILLS_MAP is typed by the category union so it cannot drift from the config', () => {
    // Guards the #1308 root cause directly: a `Record<string, string[]>`
    // annotation is what allowed SKILLS_MAP to hold keys the config never
    // declared, with an `as keyof typeof` cast hiding the mismatch.
    expect(source).toContain('Record<SkillCategory, string[]>');
    expect(source).not.toContain('skillsConfig[key as keyof typeof skillsConfig]');
  });
});

describe('SKILLS_MAP — every entry resolves to a real source skill dir', () => {
  const skillsDir = path.resolve(__dirname, '..', '..', '..', '.claude', 'skills');

  it('every SKILLS_MAP value names a directory under .claude/skills/', () => {
    const missing: string[] = [];
    for (const [category, skills] of Object.entries(SKILLS_MAP)) {
      for (const skill of skills) {
        if (!fs.existsSync(path.join(skillsDir, skill))) {
          missing.push(`${category}.${skill}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

// ============================================================================
// AGENTS_MAP integrity (mirrors SKILLS_MAP check — fixes orphans like #690/#694)
// ============================================================================

describe('AGENTS_MAP — every entry resolves to a real source agent dir', () => {
  const agentsDir = path.resolve(__dirname, '..', '..', '..', '.claude', 'agents');

  it('every AGENTS_MAP value names a directory under .claude/agents/', () => {
    const missing: string[] = [];
    for (const [category, agents] of Object.entries(AGENTS_MAP)) {
      for (const agent of agents) {
        if (!fs.existsSync(path.join(agentsDir, agent))) {
          missing.push(`${category}.${agent}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

// ============================================================================
// flow-nexus drift guard (#694)
//
// Default-shipped agents/skills must not reference `mcp__flow-nexus__*` tools.
// Flow-nexus is gated behind `mcp.flowNexus = true` opt-in — references in the
// default ship path silently fail for any consumer who hasn't enabled it.
// ============================================================================

describe.each(['agents', 'skills'])(
  'flow-nexus drift guard — no mcp__flow-nexus__ refs under .claude/%s/',
  (subdir) => {
    const claudeDir = path.resolve(__dirname, '..', '..', '..', '.claude');

    it('contains zero offenders', () => {
      const root = path.join(claudeDir, subdir);
      if (!fs.existsSync(root)) return;
      const offenders = fs
        .readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => path.join(e.parentPath ?? (e as { path?: string }).path ?? root, e.name))
        .filter((file) => /mcp__flow-nexus__\w+/.test(fs.readFileSync(file, 'utf-8')))
        .map((file) => path.relative(claudeDir, file));
      expect(offenders).toEqual([]);
    });
  },
);

// The former "shipped script lists agree across all sync sites" parity guard is
// retired in #1191 — the lists are single-sourced in bin/lib/shipped-scripts.json,
// so there's nothing left to drift. The manifest contract is asserted in
// shipped-scripts-manifest.test.ts.
