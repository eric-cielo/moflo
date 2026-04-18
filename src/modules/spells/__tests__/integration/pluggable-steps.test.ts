/**
 * Pluggable Steps Integration Tests
 *
 * Story #217: Example user-defined step commands
 * Tests the full discovery → registration → execution pipeline.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { StepCommandRegistry } from '../../src/core/step-command-registry.js';
import { builtinCommands } from '../../src/commands/index.js';
import { createMockContext } from '../helpers.js';

// ============================================================================
// Paths to example step commands
// ============================================================================

const EXAMPLES_DIR = resolve(__dirname, '../../../../../examples/spell-steps');

// ============================================================================
// Helpers
// ============================================================================

let testDir: string;
let cleanupDirs: string[] = [];

function createTempDir(suffix: string): string {
  const dir = join(tmpdir(), `moflo-pluggable-test-${suffix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  cleanupDirs.push(dir);
  return dir;
}

// ============================================================================
// Tests
// ============================================================================

describe('Pluggable Steps Integration', () => {
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

  describe('JS example: file-stats', () => {
    it('should be discovered from a user directory', () => {
      copyFileSync(
        join(EXAMPLES_DIR, 'file-stats.js'),
        join(testDir, 'file-stats.js'),
      );

      const registry = new StepCommandRegistry();
      for (const cmd of builtinCommands) {
        registry.register(cmd);
      }
      registry.loadFromDirectories([testDir]);

      expect(registry.has('file-stats')).toBe(true);
      expect(registry.get('file-stats')!.description).toContain('file statistics');
    });

    it('should execute and return file statistics', async () => {
      copyFileSync(
        join(EXAMPLES_DIR, 'file-stats.js'),
        join(testDir, 'file-stats.js'),
      );

      const registry = new StepCommandRegistry();
      registry.loadFromDirectories([testDir]);

      const command = registry.get('file-stats')!;
      const context = createMockContext();

      // Create a test file to analyze
      const testFile = join(testDir, 'sample.txt');
      writeFileSync(testFile, 'line 1\nline 2\nline 3\n');

      const output = await command.execute({ path: testFile }, context);

      expect(output.success).toBe(true);
      expect(output.data.lines).toBe(4); // 3 lines + trailing newline
      expect(output.data.bytes).toBeGreaterThan(0);
      expect(output.data.extension).toBe('.txt');
    });

    it('should validate config: path is required', () => {
      copyFileSync(
        join(EXAMPLES_DIR, 'file-stats.js'),
        join(testDir, 'file-stats.js'),
      );

      const registry = new StepCommandRegistry();
      registry.loadFromDirectories([testDir]);

      const command = registry.get('file-stats')!;
      const context = createMockContext();

      const result = command.validate({}, context);
      expect(result.valid).toBe(false);
    });
  });

  describe('YAML example: notify', () => {
    it('should be discovered from a user directory', () => {
      copyFileSync(
        join(EXAMPLES_DIR, 'notify.yaml'),
        join(testDir, 'notify.yaml'),
      );

      const registry = new StepCommandRegistry();
      for (const cmd of builtinCommands) {
        registry.register(cmd);
      }
      registry.loadFromDirectories([testDir]);

      expect(registry.has('notify')).toBe(true);
      expect(registry.get('notify')!.description).toContain('notification');
    });

    it('should validate: message is required', () => {
      copyFileSync(
        join(EXAMPLES_DIR, 'notify.yaml'),
        join(testDir, 'notify.yaml'),
      );

      const registry = new StepCommandRegistry();
      registry.loadFromDirectories([testDir]);

      const command = registry.get('notify')!;
      const context = createMockContext();

      const result = command.validate({}, context);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('message');
    });

    it('should execute with interpolated params', async () => {
      copyFileSync(
        join(EXAMPLES_DIR, 'notify.yaml'),
        join(testDir, 'notify.yaml'),
      );

      const registry = new StepCommandRegistry();
      registry.loadFromDirectories([testDir]);

      const command = registry.get('notify')!;
      const context = createMockContext();

      const output = await command.execute(
        { level: 'warning', message: 'Build done' },
        context,
      );

      expect(output.success).toBe(true);
      expect(output.data.actionCount).toBe(1);
    });
  });

  describe('Mixed discovery', () => {
    it('should discover JS and YAML steps from the same directory', () => {
      copyFileSync(
        join(EXAMPLES_DIR, 'file-stats.js'),
        join(testDir, 'file-stats.js'),
      );
      copyFileSync(
        join(EXAMPLES_DIR, 'notify.yaml'),
        join(testDir, 'notify.yaml'),
      );

      const registry = new StepCommandRegistry();
      for (const cmd of builtinCommands) {
        registry.register(cmd);
      }
      registry.loadFromDirectories([testDir]);

      // Built-in commands still present
      expect(registry.has('bash')).toBe(true);
      expect(registry.has('agent')).toBe(true);

      // User-defined steps discovered
      expect(registry.has('file-stats')).toBe(true);
      expect(registry.has('notify')).toBe(true);

      // Total: 15 built-in + 2 user
      expect(registry.size).toBe(17);
    });

    it('should allow user JS step to override a built-in', () => {
      // Create a custom "bash" step that overrides the built-in
      writeFileSync(
        join(testDir, 'custom-bash.js'),
        `module.exports = {
          type: 'bash',
          description: 'Custom bash override',
          configSchema: { type: 'object' },
          validate() { return { valid: true, errors: [] }; },
          async execute() { return { success: true, data: { custom: true } }; },
          describeOutputs() { return []; },
        };`,
      );

      const registry = new StepCommandRegistry();
      for (const cmd of builtinCommands) {
        registry.register(cmd);
      }
      registry.loadFromDirectories([testDir]);

      expect(registry.get('bash')!.description).toBe('Custom bash override');
    });
  });
});
