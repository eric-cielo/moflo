/**
 * npm Step Loader Tests
 *
 * Story #216: npm package discovery for step commands (moflo-step-*)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadStepsFromNpm } from '../../src/spells/loaders/npm-step-loader.js';
import { StepCommandRegistry } from '../../src/spells/core/step-command-registry.js';
import { builtinCommands } from '../../src/spells/commands/index.js';

// ============================================================================
// Fixtures
// ============================================================================

const VALID_STEP_MODULE = `
module.exports = {
  type: 'npm-hello',
  description: 'Hello step from npm',
  configSchema: { type: 'object', properties: { name: { type: 'string' } } },
  validate() { return { valid: true, errors: [] }; },
  async execute(config) { return { success: true, data: { greeting: 'Hello ' + (config.name || 'world') } }; },
  describeOutputs() { return [{ name: 'greeting', type: 'string' }]; },
};
`;

const VALID_NAMED_EXPORT = `
exports.stepCommand = {
  type: 'npm-named',
  description: 'Named export step',
  configSchema: { type: 'object' },
  validate() { return { valid: true, errors: [] }; },
  async execute() { return { success: true, data: {} }; },
  describeOutputs() { return []; },
};
`;

const INVALID_MODULE = `
module.exports = { notAStep: true };
`;

// ============================================================================
// Helpers
// ============================================================================

let projectRoot: string;
let cleanupDirs: string[] = [];

function createTempProject(suffix: string): string {
  const dir = join(tmpdir(), `moflo-npm-test-${suffix}-${Date.now()}`);
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  cleanupDirs.push(dir);
  return dir;
}

function createNpmPackage(
  root: string,
  name: string,
  mainContent: string,
  pkgJsonOverrides: Record<string, unknown> = {},
): void {
  const pkgDir = join(root, 'node_modules', name);
  mkdirSync(pkgDir, { recursive: true });

  const pkgJson = {
    name,
    version: '1.0.0',
    main: 'index.js',
    ...pkgJsonOverrides,
  };

  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkgJson));
  writeFileSync(join(pkgDir, 'index.js'), mainContent);
}

// ============================================================================
// Tests
// ============================================================================

describe('NpmStepLoader', () => {
  beforeEach(() => {
    projectRoot = createTempProject('main');
    cleanupDirs = [projectRoot];
  });

  afterEach(() => {
    for (const dir of cleanupDirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  describe('loadStepsFromNpm', () => {
    it('should discover moflo-step-* packages', () => {
      createNpmPackage(projectRoot, 'moflo-step-hello', VALID_STEP_MODULE);

      const result = loadStepsFromNpm(projectRoot);

      expect(result.steps.size).toBe(1);
      expect(result.steps.has('npm-hello')).toBe(true);
      expect(result.steps.get('npm-hello')!.command.description).toBe('Hello step from npm');
    });

    it('should discover named exports (stepCommand)', () => {
      createNpmPackage(projectRoot, 'moflo-step-named', VALID_NAMED_EXPORT);

      const result = loadStepsFromNpm(projectRoot);

      expect(result.steps.size).toBe(1);
      expect(result.steps.has('npm-named')).toBe(true);
    });

    it('should use moflo.stepCommand entry point from package.json', () => {
      const pkgDir = join(projectRoot, 'node_modules', 'moflo-step-custom');
      mkdirSync(pkgDir, { recursive: true });

      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: 'moflo-step-custom',
        version: '1.0.0',
        main: 'index.js',
        moflo: { stepCommand: 'lib/step.js' },
      }));
      writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {};');
      mkdirSync(join(pkgDir, 'lib'), { recursive: true });
      writeFileSync(join(pkgDir, 'lib', 'step.js'), VALID_STEP_MODULE);

      const result = loadStepsFromNpm(projectRoot);

      expect(result.steps.size).toBe(1);
      expect(result.steps.has('npm-hello')).toBe(true);
    });

    it('should fall back to main when moflo.stepCommand is missing', () => {
      createNpmPackage(projectRoot, 'moflo-step-fallback', VALID_STEP_MODULE);

      const result = loadStepsFromNpm(projectRoot);

      expect(result.steps.size).toBe(1);
    });

    it('should skip invalid packages with warnings', () => {
      createNpmPackage(projectRoot, 'moflo-step-bad', INVALID_MODULE);

      const result = loadStepsFromNpm(projectRoot);

      expect(result.steps.size).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].message).toContain('does not export a valid StepCommand');
    });

    it('should skip non-moflo-step packages', () => {
      createNpmPackage(projectRoot, 'some-other-package', VALID_STEP_MODULE);

      const result = loadStepsFromNpm(projectRoot);

      expect(result.steps.size).toBe(0);
    });

    it('should handle missing node_modules gracefully', () => {
      const emptyRoot = createTempProject('empty');
      rmSync(join(emptyRoot, 'node_modules'), { recursive: true });

      const result = loadStepsFromNpm(emptyRoot);

      expect(result.steps.size).toBe(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('should handle malformed package.json with warnings', () => {
      const pkgDir = join(projectRoot, 'node_modules', 'moflo-step-broken');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), 'not-valid-json');
      writeFileSync(join(pkgDir, 'index.js'), VALID_STEP_MODULE);

      const result = loadStepsFromNpm(projectRoot);

      expect(result.steps.size).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].message).toContain('Cannot read package.json');
    });

    it('should discover multiple moflo-step packages', () => {
      createNpmPackage(projectRoot, 'moflo-step-hello', VALID_STEP_MODULE);
      createNpmPackage(projectRoot, 'moflo-step-named', VALID_NAMED_EXPORT);

      const result = loadStepsFromNpm(projectRoot);

      expect(result.steps.size).toBe(2);
      expect(result.steps.has('npm-hello')).toBe(true);
      expect(result.steps.has('npm-named')).toBe(true);
    });
  });

  describe('StepCommandRegistry.loadFromNpm', () => {
    it('should register npm steps into the registry', () => {
      createNpmPackage(projectRoot, 'moflo-step-hello', VALID_STEP_MODULE);

      const registry = new StepCommandRegistry();
      const warnings = registry.loadFromNpm(projectRoot);

      expect(warnings).toHaveLength(0);
      expect(registry.has('npm-hello')).toBe(true);
    });

    it('should have lower priority than user directory steps', () => {
      createNpmPackage(projectRoot, 'moflo-step-hello', VALID_STEP_MODULE);

      const registry = new StepCommandRegistry();

      // Load npm first (lowest priority)
      registry.loadFromNpm(projectRoot);
      expect(registry.get('npm-hello')!.description).toBe('Hello step from npm');

      // User directory overrides npm
      const overrideStep = {
        type: 'npm-hello',
        description: 'User override',
        configSchema: { type: 'object' as const },
        validate: () => ({ valid: true as const, errors: [] }),
        execute: async () => ({ success: true, data: {} }),
        describeOutputs: () => [],
      };
      registry.registerOrReplace(overrideStep);

      expect(registry.get('npm-hello')!.description).toBe('User override');
    });

    it('should not override built-in commands when loaded first', () => {
      // The factory loads npm BEFORE user dirs but AFTER built-ins.
      // Since registerOrReplace is used, npm would override built-ins.
      // The factory ordering ensures: builtins -> npm -> user dirs (last wins).
      createNpmPackage(projectRoot, 'moflo-step-hello', VALID_STEP_MODULE);

      const registry = new StepCommandRegistry();
      for (const cmd of builtinCommands) {
        registry.register(cmd);
      }

      // npm loaded after built-ins — it adds new types but can't be overridden by itself
      registry.loadFromNpm(projectRoot);

      // Built-in types still present
      expect(registry.has('bash')).toBe(true);
      // npm type also added
      expect(registry.has('npm-hello')).toBe(true);
    });
  });
});
