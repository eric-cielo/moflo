/**
 * Workflow Registry Tests
 *
 * Story #105: Abbreviation lookup, collision detection, list/info.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Grimoire } from '../src/registry/workflow-registry.js';

// ============================================================================
// Fixtures
// ============================================================================

let testDir: string;

function makeDir(...segments: string[]): string {
  const dir = join(testDir, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeYaml(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, 'utf-8');
}

const SECURITY_AUDIT = `
name: security-audit
abbreviation: sa
description: "Run a security audit"
version: "1.0"
arguments:
  target:
    type: string
    required: true
  severity:
    type: string
    default: "high"
steps:
  - id: scan
    type: agent
    config:
      prompt: "Scan {args.target}"
`;

const DOC_GENERATION = `
name: doc-generation
abbreviation: dg
description: "Generate documentation"
steps:
  - id: analyze
    type: bash
    config:
      command: echo analyze
  - id: write
    type: bash
    config:
      command: echo write
`;

const LINT_CHECK = `
name: lint-check
description: "Run lint checks (no abbreviation)"
steps:
  - id: lint
    type: bash
    config:
      command: npm run lint
`;

const COLLISION_1 = `
name: workflow-a
abbreviation: dup
description: "Workflow A"
steps:
  - id: a
    type: bash
    config:
      command: echo a
`;

const COLLISION_2 = `
name: workflow-b
abbreviation: dup
description: "Workflow B"
steps:
  - id: b
    type: bash
    config:
      command: echo b
`;

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  testDir = join(tmpdir(), `wf-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ============================================================================
// Discovery + Registration
// ============================================================================

describe('Grimoire — discovery', () => {
  it('should discover and register workflows from directories', () => {
    const dir = makeDir('workflows');
    writeYaml(dir, 'security-audit.yaml', SECURITY_AUDIT);
    writeYaml(dir, 'doc-generation.yaml', DOC_GENERATION);

    const registry = new Grimoire({ userDirs: [dir], skipValidation: true });
    const result = registry.load();

    expect(result.workflows.size).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(result.collisions).toHaveLength(0);
  });

  it('should build abbreviation map from workflow frontmatter', () => {
    const dir = makeDir('workflows');
    writeYaml(dir, 'security-audit.yaml', SECURITY_AUDIT);
    writeYaml(dir, 'doc-generation.yaml', DOC_GENERATION);

    const registry = new Grimoire({ userDirs: [dir], skipValidation: true });
    const result = registry.load();

    expect(result.abbreviations.size).toBe(2);
    expect(result.abbreviations.get('sa')).toBe('security-audit');
    expect(result.abbreviations.get('dg')).toBe('doc-generation');
  });

  it('should handle workflows without abbreviation', () => {
    const dir = makeDir('workflows');
    writeYaml(dir, 'lint-check.yaml', LINT_CHECK);

    const registry = new Grimoire({ userDirs: [dir], skipValidation: true });
    const result = registry.load();

    expect(result.workflows.size).toBe(1);
    expect(result.abbreviations.size).toBe(0);
  });
});

// ============================================================================
// Abbreviation lookup
// ============================================================================

describe('Grimoire — resolve', () => {
  it('should resolve by full name', () => {
    const dir = makeDir('workflows');
    writeYaml(dir, 'security-audit.yaml', SECURITY_AUDIT);

    const registry = new Grimoire({ userDirs: [dir], skipValidation: true });
    registry.load();

    const result = registry.resolve('security-audit');
    expect(result).toBeDefined();
    expect(result!.definition.name).toBe('security-audit');
  });

  it('should resolve by abbreviation', () => {
    const dir = makeDir('workflows');
    writeYaml(dir, 'security-audit.yaml', SECURITY_AUDIT);

    const registry = new Grimoire({ userDirs: [dir], skipValidation: true });
    registry.load();

    const result = registry.resolve('sa');
    expect(result).toBeDefined();
    expect(result!.definition.name).toBe('security-audit');
  });

  it('should return undefined for unknown query', () => {
    const dir = makeDir('workflows');
    writeYaml(dir, 'security-audit.yaml', SECURITY_AUDIT);

    const registry = new Grimoire({ userDirs: [dir], skipValidation: true });
    registry.load();

    expect(registry.resolve('nonexistent')).toBeUndefined();
  });

  it('should auto-load on first resolve if not loaded', () => {
    const dir = makeDir('workflows');
    writeYaml(dir, 'security-audit.yaml', SECURITY_AUDIT);

    const registry = new Grimoire({ userDirs: [dir], skipValidation: true });
    // No explicit load() call
    const result = registry.resolve('sa');
    expect(result).toBeDefined();
    expect(result!.definition.name).toBe('security-audit');
  });
});

// ============================================================================
// Collision detection
// ============================================================================

describe('Grimoire — collision detection', () => {
  it('should detect duplicate abbreviations', () => {
    const dir = makeDir('workflows');
    writeYaml(dir, 'workflow-a.yaml', COLLISION_1);
    writeYaml(dir, 'workflow-b.yaml', COLLISION_2);

    const registry = new Grimoire({ userDirs: [dir], skipValidation: true });
    const result = registry.load();

    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0].abbreviation).toBe('dup');
    expect(result.collisions[0].workflows).toContain('workflow-a');
    expect(result.collisions[0].workflows).toContain('workflow-b');
  });

  it('should not include colliding abbreviations in abbreviation map', () => {
    const dir = makeDir('workflows');
    writeYaml(dir, 'workflow-a.yaml', COLLISION_1);
    writeYaml(dir, 'workflow-b.yaml', COLLISION_2);

    const registry = new Grimoire({ userDirs: [dir], skipValidation: true });
    const result = registry.load();

    expect(result.abbreviations.has('dup')).toBe(false);
  });

  it('should still allow full name resolution for colliding workflows', () => {
    const dir = makeDir('workflows');
    writeYaml(dir, 'workflow-a.yaml', COLLISION_1);
    writeYaml(dir, 'workflow-b.yaml', COLLISION_2);

    const registry = new Grimoire({ userDirs: [dir], skipValidation: true });
    registry.load();

    expect(registry.resolve('workflow-a')).toBeDefined();
    expect(registry.resolve('workflow-b')).toBeDefined();
    expect(registry.resolve('dup')).toBeUndefined();
  });
});

// ============================================================================
// List
// ============================================================================

describe('Grimoire — list', () => {
  it('should list all workflows sorted by name', () => {
    const dir = makeDir('workflows');
    writeYaml(dir, 'security-audit.yaml', SECURITY_AUDIT);
    writeYaml(dir, 'doc-generation.yaml', DOC_GENERATION);
    writeYaml(dir, 'lint-check.yaml', LINT_CHECK);

    const registry = new Grimoire({ userDirs: [dir], skipValidation: true });
    registry.load();

    const list = registry.list();
    expect(list).toHaveLength(3);
    expect(list[0].name).toBe('doc-generation');
    expect(list[0].abbreviation).toBe('dg');
    expect(list[1].name).toBe('lint-check');
    expect(list[1].abbreviation).toBeUndefined();
    expect(list[2].name).toBe('security-audit');
    expect(list[2].abbreviation).toBe('sa');
  });

  it('should show tier for each workflow', () => {
    const shippedDir = makeDir('shipped');
    const userDir = makeDir('user');
    writeYaml(shippedDir, 'sa.yaml', SECURITY_AUDIT);
    writeYaml(userDir, 'dg.yaml', DOC_GENERATION);

    const registry = new Grimoire({ shippedDir, userDirs: [userDir], skipValidation: true });
    registry.load();

    const list = registry.list();
    const sa = list.find(e => e.name === 'security-audit');
    const dg = list.find(e => e.name === 'doc-generation');
    expect(sa!.tier).toBe('shipped');
    expect(dg!.tier).toBe('user');
  });
});

// ============================================================================
// Info
// ============================================================================

describe('Grimoire — info', () => {
  it('should return detailed info by name', () => {
    const dir = makeDir('workflows');
    writeYaml(dir, 'security-audit.yaml', SECURITY_AUDIT);

    const registry = new Grimoire({ userDirs: [dir], skipValidation: true });
    registry.load();

    const info = registry.info('security-audit');
    expect(info).toBeDefined();
    expect(info!.name).toBe('security-audit');
    expect(info!.abbreviation).toBe('sa');
    expect(info!.description).toBe('Run a security audit');
    expect(info!.version).toBe('1.0');
    expect(info!.stepCount).toBe(1);
    expect(info!.stepTypes).toEqual(['agent']);
    expect(info!.arguments).toHaveProperty('target');
    expect(info!.arguments).toHaveProperty('severity');
  });

  it('should return detailed info by abbreviation', () => {
    const dir = makeDir('workflows');
    writeYaml(dir, 'security-audit.yaml', SECURITY_AUDIT);

    const registry = new Grimoire({ userDirs: [dir], skipValidation: true });
    registry.load();

    const info = registry.info('sa');
    expect(info).toBeDefined();
    expect(info!.name).toBe('security-audit');
  });

  it('should return undefined for unknown query', () => {
    const dir = makeDir('workflows');

    const registry = new Grimoire({ userDirs: [dir], skipValidation: true });
    registry.load();

    expect(registry.info('unknown')).toBeUndefined();
  });

  it('should count nested steps', () => {
    const dir = makeDir('workflows');
    writeYaml(dir, 'nested.yaml', `
name: nested-workflow
steps:
  - id: loop1
    type: loop
    config: {}
    steps:
      - id: inner1
        type: bash
        config:
          command: echo 1
      - id: inner2
        type: bash
        config:
          command: echo 2
  - id: final
    type: bash
    config:
      command: echo done
`);

    const registry = new Grimoire({ userDirs: [dir], skipValidation: true });
    registry.load();

    const info = registry.info('nested-workflow');
    expect(info!.stepCount).toBe(4); // loop1, inner1, inner2, final
    expect(info!.stepTypes).toEqual(['bash', 'loop']);
  });
});

// ============================================================================
// Cache invalidation
// ============================================================================

describe('Grimoire — cache', () => {
  it('should cache results after first load', () => {
    const dir = makeDir('workflows');
    writeYaml(dir, 'sa.yaml', SECURITY_AUDIT);

    const registry = new Grimoire({ userDirs: [dir], skipValidation: true });
    registry.load();

    // Add a new file after loading
    writeYaml(dir, 'dg.yaml', DOC_GENERATION);

    // Should still show only 1 (cached)
    expect(registry.list()).toHaveLength(1);
  });

  it('should reload after invalidate()', () => {
    const dir = makeDir('workflows');
    writeYaml(dir, 'sa.yaml', SECURITY_AUDIT);

    const registry = new Grimoire({ userDirs: [dir], skipValidation: true });
    registry.load();

    writeYaml(dir, 'dg.yaml', DOC_GENERATION);
    registry.invalidate();

    expect(registry.list()).toHaveLength(2);
  });
});

// ============================================================================
// Extra directories (convenience alias)
// ============================================================================

describe('Grimoire — extraDirs', () => {
  it('should scan extraDirs in addition to userDirs', () => {
    const userDir = makeDir('user');
    const extraDir = makeDir('extra');
    writeYaml(userDir, 'sa.yaml', SECURITY_AUDIT);
    writeYaml(extraDir, 'dg.yaml', DOC_GENERATION);

    const registry = new Grimoire({
      userDirs: [userDir],
      extraDirs: [extraDir],
      skipValidation: true,
    });
    const result = registry.load();

    expect(result.workflows.size).toBe(2);
  });
});

// ============================================================================
// /flo regression: existing behavior unchanged
// ============================================================================

describe('Grimoire — does not affect existing /flo behavior', () => {
  it('should work with empty directories', () => {
    const registry = new Grimoire({
      shippedDir: join(testDir, 'nonexistent'),
      userDirs: [join(testDir, 'also-nonexistent')],
      skipValidation: true,
    });

    const result = registry.load();
    expect(result.workflows.size).toBe(0);
    expect(result.abbreviations.size).toBe(0);
    expect(result.collisions).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});
