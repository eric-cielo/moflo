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
import { findRepoRoot } from './_helpers/repo-walk.js';

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

  it('copy functions use Object.entries() for iteration', () => {
    // Verify the pattern: for (const [key, ...] of Object.entries(COMMANDS_MAP))
    expect(source).toContain('Object.entries(COMMANDS_MAP)');
    expect(source).toContain('Object.entries(SKILLS_MAP)');
    expect(source).toContain('Object.entries(AGENTS_MAP)');
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

// SCRIPT_MAP divergence guard — the shipped-script list lives in 3 production
// sites that must agree (#777, #84, feedback_scriptfiles_sync.md).
describe('shipped script lists agree across all sync sites', () => {
  const repoRoot = findRepoRoot(import.meta.url);

  function extractScripts(source: string, varName: string): string[] {
    const re = new RegExp(`const\\s+${varName}[^=]*=\\s*[\\[{]([\\s\\S]*?)[\\]}];`, 'm');
    const block = source.match(re)?.[1] ?? '';
    return [...block.matchAll(/['"]([\w.-]+\.mjs)['"]/g)].map(m => m[1]).sort();
  }

  it('moflo-init.ts SCRIPT_MAP, executor.ts UPGRADE_SCRIPT_MAP, and session-start-launcher.mjs scriptFiles all contain the same files', () => {
    const initSrc = fs.readFileSync(path.join(repoRoot, 'src/cli/init/moflo-init.ts'), 'utf-8');
    const executorSrc = fs.readFileSync(path.join(repoRoot, 'src/cli/init/executor.ts'), 'utf-8');
    const launcherSrc = fs.readFileSync(path.join(repoRoot, 'bin/session-start-launcher.mjs'), 'utf-8');

    const init = extractScripts(initSrc, 'SCRIPT_MAP');
    const upgrade = extractScripts(executorSrc, 'UPGRADE_SCRIPT_MAP');
    const launcher = extractScripts(launcherSrc, 'scriptFiles');

    // Guard against a regex break that returns [] from all 3 — would silently
    // pass the parity check and let real drift through.
    expect(init.length).toBeGreaterThan(0);
    expect(init).toEqual(upgrade);
    expect(init).toEqual(launcher);
  });
});
