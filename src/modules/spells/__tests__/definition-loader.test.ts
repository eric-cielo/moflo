/**
 * Definition Loader Tests
 *
 * Story #138: Tests for two-tier workflow definition layering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSpellDefinitions, loadWorkflowByName } from '../src/loaders/definition-loader.js';

// ============================================================================
// Helpers
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

const SHIPPED_WORKFLOW = `
name: deploy
description: Shipped deploy workflow
steps:
  - id: build
    type: bash
    config:
      command: npm run build
`;

const USER_OVERRIDE_WORKFLOW = `
name: deploy
description: User-customized deploy workflow
steps:
  - id: build
    type: bash
    config:
      command: npm run build:custom
`;

const USER_NEW_WORKFLOW = `
name: lint-check
description: User-defined lint workflow
steps:
  - id: lint
    type: bash
    config:
      command: npm run lint
`;

const JSON_WORKFLOW = JSON.stringify({
  name: 'json-workflow',
  description: 'JSON format workflow',
  steps: [{ id: 'step1', type: 'bash', config: { command: 'echo hello' } }],
});

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  testDir = join(tmpdir(), `wf-loader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ============================================================================
// Tests
// ============================================================================

describe('DefinitionLoader — shipped definitions', () => {
  it('should load shipped spell definitions', () => {
    const shippedDir = makeDir('shipped');
    writeYaml(shippedDir, 'deploy.yaml', SHIPPED_WORKFLOW);

    const result = loadSpellDefinitions({
      shippedDir,
      skipValidation: true,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.workflows.size).toBe(1);

    const deploy = result.workflows.get('deploy');
    expect(deploy).toBeDefined();
    expect(deploy!.definition.name).toBe('deploy');
    expect(deploy!.tier).toBe('shipped');
    expect(deploy!.sourceFile).toContain('deploy.yaml');
  });
});

describe('DefinitionLoader — user override', () => {
  it('should override shipped spell by name match', () => {
    const shippedDir = makeDir('shipped');
    const userDir = makeDir('user');
    writeYaml(shippedDir, 'deploy.yaml', SHIPPED_WORKFLOW);
    writeYaml(userDir, 'deploy.yaml', USER_OVERRIDE_WORKFLOW);

    const result = loadSpellDefinitions({
      shippedDir,
      userDirs: [userDir],
      skipValidation: true,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.workflows.size).toBe(1);

    const deploy = result.workflows.get('deploy');
    expect(deploy!.tier).toBe('user');
    expect(deploy!.definition.description).toBe('User-customized deploy workflow');
  });

  it('should add user spell with new name additively', () => {
    const shippedDir = makeDir('shipped');
    const userDir = makeDir('user');
    writeYaml(shippedDir, 'deploy.yaml', SHIPPED_WORKFLOW);
    writeYaml(userDir, 'lint-check.yaml', USER_NEW_WORKFLOW);

    const result = loadSpellDefinitions({
      shippedDir,
      userDirs: [userDir],
      skipValidation: true,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.workflows.size).toBe(2);
    expect(result.workflows.has('deploy')).toBe(true);
    expect(result.workflows.has('lint-check')).toBe(true);

    expect(result.workflows.get('deploy')!.tier).toBe('shipped');
    expect(result.workflows.get('lint-check')!.tier).toBe('user');
  });
});

describe('DefinitionLoader — custom paths', () => {
  it('should load from multiple user directories', () => {
    const userDir1 = makeDir('user1');
    const userDir2 = makeDir('user2');
    writeYaml(userDir1, 'deploy.yaml', SHIPPED_WORKFLOW);
    writeYaml(userDir2, 'lint.yaml', USER_NEW_WORKFLOW);

    const result = loadSpellDefinitions({
      userDirs: [userDir1, userDir2],
      skipValidation: true,
    });

    expect(result.workflows.size).toBe(2);
  });

  it('should not error when user path does not exist', () => {
    const result = loadSpellDefinitions({
      userDirs: [join(testDir, 'nonexistent')],
      skipValidation: true,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.workflows.size).toBe(0);
  });

  it('should not error when shipped path does not exist', () => {
    const result = loadSpellDefinitions({
      shippedDir: join(testDir, 'nonexistent'),
      skipValidation: true,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.workflows.size).toBe(0);
  });
});

describe('DefinitionLoader — format support', () => {
  it('should load JSON format spell definitions', () => {
    const dir = makeDir('json');
    writeFileSync(join(dir, 'wf.json'), JSON_WORKFLOW, 'utf-8');

    const result = loadSpellDefinitions({
      userDirs: [dir],
      skipValidation: true,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.workflows.size).toBe(1);
    expect(result.workflows.get('json-workflow')!.definition.name).toBe('json-workflow');
  });

  it('should load .yml extension', () => {
    const dir = makeDir('yml');
    writeYaml(dir, 'deploy.yml', SHIPPED_WORKFLOW);

    const result = loadSpellDefinitions({
      userDirs: [dir],
      skipValidation: true,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.workflows.size).toBe(1);
  });

  it('should ignore non-spell files', () => {
    const dir = makeDir('mixed');
    writeYaml(dir, 'deploy.yaml', SHIPPED_WORKFLOW);
    writeFileSync(join(dir, 'readme.md'), '# README', 'utf-8');
    writeFileSync(join(dir, 'notes.txt'), 'some notes', 'utf-8');

    const result = loadSpellDefinitions({
      userDirs: [dir],
      skipValidation: true,
    });

    expect(result.workflows.size).toBe(1);
  });
});

describe('DefinitionLoader — error handling', () => {
  it('should collect parse errors without failing other files', () => {
    const dir = makeDir('errors');
    writeYaml(dir, 'good.yaml', SHIPPED_WORKFLOW);
    writeFileSync(join(dir, 'bad.yaml'), '{{invalid yaml', 'utf-8');

    const result = loadSpellDefinitions({
      userDirs: [dir],
      skipValidation: true,
    });

    expect(result.workflows.size).toBe(1);
    expect(result.workflows.has('deploy')).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toContain('bad.yaml');
  });
});

describe('DefinitionLoader — loadWorkflowByName', () => {
  it('should load a specific spell by name', () => {
    const shippedDir = makeDir('shipped');
    writeYaml(shippedDir, 'deploy.yaml', SHIPPED_WORKFLOW);

    const result = loadWorkflowByName('deploy', {
      shippedDir,
      skipValidation: true,
    });

    expect(result).toBeDefined();
    expect(result!.definition.name).toBe('deploy');
  });

  it('should return undefined for unknown spell name', () => {
    const result = loadWorkflowByName('nonexistent', {
      shippedDir: join(testDir, 'empty'),
      skipValidation: true,
    });

    expect(result).toBeUndefined();
  });
});
