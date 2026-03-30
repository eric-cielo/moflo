/**
 * Directory Step Loader Tests
 *
 * Story #214: Directory scanning for JS/TS user step commands
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadStepsFromDirectories,
  isStepCommand,
} from '../src/loaders/directory-step-loader.js';
import { StepCommandRegistry } from '../src/core/step-command-registry.js';
import { builtinCommands } from '../src/commands/index.js';

// ============================================================================
// Fixtures
// ============================================================================

const VALID_STEP_JS = `
const myStep = {
  type: 'custom-step',
  description: 'A custom step for testing',
  configSchema: { type: 'object', properties: { msg: { type: 'string' } } },
  validate() { return { valid: true, errors: [] }; },
  async execute(config) { return { success: true, data: { msg: config.msg || 'hello' } }; },
  describeOutputs() { return [{ name: 'msg', type: 'string' }]; },
};
module.exports = myStep;
`;

const VALID_STEP_NAMED_EXPORT = `
const stepCommand = {
  type: 'named-step',
  description: 'Named export step',
  configSchema: { type: 'object' },
  validate() { return { valid: true, errors: [] }; },
  async execute() { return { success: true, data: {} }; },
  describeOutputs() { return []; },
};
module.exports = { stepCommand };
`;

const INVALID_STEP_JS = `
module.exports = { notAStep: true };
`;

const SYNTAX_ERROR_JS = `
module.exports = { {{invalid
`;

// ============================================================================
// Helpers
// ============================================================================

let testDir: string;
let cleanupDirs: string[] = [];

function createTempDir(suffix: string): string {
  const dir = join(tmpdir(), `moflo-step-test-${suffix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  cleanupDirs.push(dir);
  return dir;
}

// ============================================================================
// Tests
// ============================================================================

describe('DirectoryStepLoader', () => {
  beforeEach(() => {
    testDir = createTempDir('main');
    cleanupDirs = [testDir];
  });

  afterEach(() => {
    for (const dir of cleanupDirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  describe('loadStepsFromDirectories', () => {
    it('should discover valid JS step command files', () => {
      writeFileSync(join(testDir, 'custom-step.js'), VALID_STEP_JS);

      const result = loadStepsFromDirectories({ dirs: [testDir] });

      expect(result.steps.size).toBe(1);
      expect(result.steps.has('custom-step')).toBe(true);
      expect(result.steps.get('custom-step')!.command.type).toBe('custom-step');
      expect(result.steps.get('custom-step')!.sourceFile).toContain('custom-step.js');
      expect(result.warnings).toHaveLength(0);
    });

    it('should discover named export (stepCommand)', () => {
      writeFileSync(join(testDir, 'named.js'), VALID_STEP_NAMED_EXPORT);

      const result = loadStepsFromDirectories({ dirs: [testDir] });

      expect(result.steps.size).toBe(1);
      expect(result.steps.has('named-step')).toBe(true);
    });

    it('should skip invalid files with warnings', () => {
      writeFileSync(join(testDir, 'invalid.js'), INVALID_STEP_JS);

      const result = loadStepsFromDirectories({ dirs: [testDir] });

      expect(result.steps.size).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].message).toContain('No valid StepCommand export');
    });

    it('should handle syntax errors with warnings', () => {
      writeFileSync(join(testDir, 'broken.js'), SYNTAX_ERROR_JS);

      const result = loadStepsFromDirectories({ dirs: [testDir] });

      expect(result.steps.size).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].file).toContain('broken.js');
    });

    it('should handle non-existent directories gracefully', () => {
      const result = loadStepsFromDirectories({
        dirs: ['/nonexistent/path/that/does/not/exist'],
      });

      expect(result.steps.size).toBe(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('should handle empty directories', () => {
      const result = loadStepsFromDirectories({ dirs: [testDir] });

      expect(result.steps.size).toBe(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('should skip non-JS/TS files', () => {
      writeFileSync(join(testDir, 'readme.md'), '# Not a step');
      writeFileSync(join(testDir, 'data.json'), '{}');
      writeFileSync(join(testDir, 'custom-step.js'), VALID_STEP_JS);

      const result = loadStepsFromDirectories({ dirs: [testDir] });

      expect(result.steps.size).toBe(1);
      expect(result.steps.has('custom-step')).toBe(true);
    });

    it('should override earlier directories with later ones', () => {
      const dir1 = createTempDir('dir1');
      const dir2 = createTempDir('dir2');

      // Same type name, different descriptions
      const step1 = VALID_STEP_JS.replace('A custom step for testing', 'From dir1');
      const step2 = VALID_STEP_JS.replace('A custom step for testing', 'From dir2');

      writeFileSync(join(dir1, 'step.js'), step1);
      writeFileSync(join(dir2, 'step.js'), step2);

      const result = loadStepsFromDirectories({ dirs: [dir1, dir2] });

      expect(result.steps.size).toBe(1);
      const step = result.steps.get('custom-step')!;
      expect(step.command.description).toBe('From dir2');
      expect(step.sourceFile).toContain(dir2);
    });

    it('should discover multiple steps from one directory', () => {
      writeFileSync(join(testDir, 'step-a.js'), VALID_STEP_JS);
      writeFileSync(join(testDir, 'step-b.js'), VALID_STEP_NAMED_EXPORT);

      const result = loadStepsFromDirectories({ dirs: [testDir] });

      expect(result.steps.size).toBe(2);
      expect(result.steps.has('custom-step')).toBe(true);
      expect(result.steps.has('named-step')).toBe(true);
    });
  });

  describe('isStepCommand', () => {
    it('should return true for valid StepCommand objects', () => {
      const valid = {
        type: 'test',
        description: 'test',
        configSchema: { type: 'object' },
        validate: () => ({ valid: true, errors: [] }),
        execute: async () => ({ success: true, data: {} }),
        describeOutputs: () => [],
      };
      expect(isStepCommand(valid)).toBe(true);
    });

    it('should return false for null/undefined', () => {
      expect(isStepCommand(null)).toBe(false);
      expect(isStepCommand(undefined)).toBe(false);
    });

    it('should return false for objects missing required fields', () => {
      expect(isStepCommand({ type: 'test' })).toBe(false);
      expect(isStepCommand({ type: '', description: 'x', configSchema: {}, validate: () => {}, execute: () => {}, describeOutputs: () => [] })).toBe(false);
    });

    it('should return false for non-objects', () => {
      expect(isStepCommand('string')).toBe(false);
      expect(isStepCommand(42)).toBe(false);
      expect(isStepCommand(true)).toBe(false);
    });
  });

  describe('StepCommandRegistry.loadFromDirectories', () => {
    it('should register discovered steps into registry', () => {
      writeFileSync(join(testDir, 'custom-step.js'), VALID_STEP_JS);

      const registry = new StepCommandRegistry();
      const warnings = registry.loadFromDirectories([testDir]);

      expect(warnings).toHaveLength(0);
      expect(registry.has('custom-step')).toBe(true);
      expect(registry.get('custom-step')!.type).toBe('custom-step');
    });

    it('should allow user steps to override built-in commands', () => {
      // Create a step with the same type as a built-in
      const overrideStep = VALID_STEP_JS
        .replace("'custom-step'", "'bash'")
        .replace('A custom step for testing', 'User override of bash');

      writeFileSync(join(testDir, 'override-bash.js'), overrideStep);

      const registry = new StepCommandRegistry();
      for (const cmd of builtinCommands) {
        registry.register(cmd);
      }

      registry.loadFromDirectories([testDir]);

      expect(registry.has('bash')).toBe(true);
      expect(registry.get('bash')!.description).toBe('User override of bash');
    });

    it('should return warnings for invalid files', () => {
      writeFileSync(join(testDir, 'bad.js'), INVALID_STEP_JS);

      const registry = new StepCommandRegistry();
      const warnings = registry.loadFromDirectories([testDir]);

      expect(warnings).toHaveLength(1);
      expect(registry.size).toBe(0);
    });
  });

  describe('StepCommandRegistry.registerOrReplace', () => {
    it('should replace existing command without throwing', () => {
      const registry = new StepCommandRegistry();
      const cmd1 = {
        type: 'test', description: 'first', configSchema: { type: 'object' as const },
        validate: () => ({ valid: true as const, errors: [] }),
        execute: async () => ({ success: true, data: {} }),
        describeOutputs: () => [],
      };
      const cmd2 = { ...cmd1, description: 'second' };

      registry.register(cmd1);
      registry.registerOrReplace(cmd2);

      expect(registry.get('test')!.description).toBe('second');
      expect(registry.size).toBe(1);
    });

    it('should reject empty type', () => {
      const registry = new StepCommandRegistry();
      const cmd = {
        type: '', description: 'bad', configSchema: { type: 'object' as const },
        validate: () => ({ valid: true as const, errors: [] }),
        execute: async () => ({ success: true, data: {} }),
        describeOutputs: () => [],
      };

      expect(() => registry.registerOrReplace(cmd)).toThrow('non-empty string type');
    });
  });
});
