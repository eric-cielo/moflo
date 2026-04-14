/**
 * Runner Bridge & Factory Tests
 *
 * Story #139: Tests for MCP tool integration bridge.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bridgeRunSpell,
  bridgeCancelSpell,
  bridgeIsRunning,
  bridgeActiveSpells,
} from '../src/factory/runner-bridge.js';
import { createRunner, runSpellFromContent } from '../src/factory/runner-factory.js';
import { loadSandboxConfigFromProject } from '../src/core/platform-sandbox.js';

// ============================================================================
// Runner Factory
// ============================================================================

describe('createRunner', () => {
  it('should create a runner with built-in commands registered', async () => {
    const runner = createRunner();
    const definition = {
      name: 'test',
      steps: [{ id: 's1', type: 'bash', config: { command: 'echo hello' } }],
    };

    // Should not throw for known step type 'bash'
    const result = await runner.run(definition, {}, { dryRun: true });
    expect(result.spellId).toBeDefined();
  });
});

describe('runSpellFromContent', () => {
  it('should parse and run a YAML spell', async () => {
    const yaml = `
name: test-spell
steps:
  - id: step1
    type: wait
    config:
      duration: 0
`;
    const result = await runSpellFromContent(yaml, 'test.yaml');

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].stepId).toBe('step1');
  });

  it('should return structured error for invalid YAML', async () => {
    const result = await runSpellFromContent('{{invalid', 'bad.yaml');

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('DEFINITION_VALIDATION_FAILED');
    expect(result.errors[0].message).toContain('Parse error');
  });

  it('should return structured error for invalid definition', async () => {
    const yaml = `
name: ""
steps: []
`;
    const result = await runSpellFromContent(yaml, 'invalid.yaml');

    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('DEFINITION_VALIDATION_FAILED');
  });

  it('should support dry-run mode', async () => {
    const yaml = `
name: dry-test
steps:
  - id: s1
    type: wait
    config:
      duration: 0
`;
    const result = await runSpellFromContent(yaml, 'test.yaml', { dryRun: true });

    expect(result.success).toBe(true);
    // Dry run doesn't produce step results
    expect(result.steps).toHaveLength(0);
  });
});

// ============================================================================
// Runner Bridge
// ============================================================================

describe('bridgeRunSpell', () => {
  it('should run a spell from content and track it', async () => {
    const yaml = `
name: bridge-test
steps:
  - id: s1
    type: wait
    config:
      duration: 0
`;
    const result = await bridgeRunSpell(yaml, 'test.yaml', {});

    expect(result.success).toBe(true);
    expect(result.spellId).toMatch(/^sp-\d+$/);
    // After completion, should no longer be tracked
    expect(bridgeIsRunning(result.spellId)).toBe(false);
  });
});

describe('bridgeCancelSpell', () => {
  it('should return false for unknown spell ID', () => {
    expect(bridgeCancelSpell('nonexistent')).toBe(false);
  });
});

describe('bridgeActiveSpells', () => {
  it('should return empty array when no spells running', () => {
    expect(bridgeActiveSpells()).toEqual([]);
  });
});

// ============================================================================
// #160 — Credentials wired through bridge
// ============================================================================

// ============================================================================
// Sandbox config auto-loaded from moflo.yaml at projectRoot
// ============================================================================

describe('loadSandboxConfigFromProject', () => {
  it('parses sandbox block from moflo.yaml', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'moflo-sb-load-'));
    try {
      writeFileSync(join(tmp, 'moflo.yaml'), 'sandbox:\n  enabled: true\n  tier: denylist-only\n', 'utf-8');
      const cfg = await loadSandboxConfigFromProject(tmp);
      expect(cfg.enabled).toBe(true);
      expect(cfg.tier).toBe('denylist-only');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns defaults when moflo.yaml is missing', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'moflo-sb-missing-'));
    try {
      const cfg = await loadSandboxConfigFromProject(tmp);
      expect(cfg.enabled).toBe(false);
      expect(cfg.tier).toBe('auto');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns defaults when moflo.yaml has no sandbox block', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'moflo-sb-empty-'));
    try {
      writeFileSync(join(tmp, 'moflo.yaml'), 'project:\n  name: x\n', 'utf-8');
      const cfg = await loadSandboxConfigFromProject(tmp);
      expect(cfg.enabled).toBe(false);
      expect(cfg.tier).toBe('auto');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('bridgeRunSpell — sandboxConfig threading', () => {
  it('explicit sandboxConfig wins over moflo.yaml', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'moflo-bridge-sb-'));
    try {
      // moflo.yaml says tier: full (would throw on Windows where bwrap is absent)
      writeFileSync(join(tmp, 'moflo.yaml'), 'sandbox:\n  enabled: true\n  tier: full\n', 'utf-8');

      const yaml = [
        'name: sb-explicit',
        'steps:',
        '  - id: s1',
        '    type: wait',
        '    config:',
        '      duration: 0',
      ].join('\n');

      const result = await bridgeRunSpell(yaml, undefined, {}, {
        projectRoot: tmp,
        sandboxConfig: { enabled: true, tier: 'denylist-only' },
      });
      expect(result.success).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('#160 — bridgeRunSpell credentials parameter', () => {
  it('bridgeRunSpell accepts and passes through credentials option', async () => {
    const credentials = {
      async get(name: string) { return name === 'TOKEN' ? 'secret-val' : undefined; },
      async has(name: string) { return name === 'TOKEN'; },
    };

    const yaml = [
      'name: cred-test',
      'steps:',
      '  - id: s1',
      '    type: bash',
      '    config:',
      '      command: echo ok',
    ].join('\n');

    const result = await bridgeRunSpell(yaml, undefined, {}, { credentials });
    expect(result.spellId).toBeDefined();
    expect(result.success).toBe(true);
  });
});
