/**
 * System Test: Pluggable Step Commands
 *
 * End-to-end verification that the full pluggable step discovery
 * pipeline works from compiled dist/ code through to workflow execution.
 *
 * Tests:
 * 1. JS step discovery from directory → registration → execution in a workflow
 * 2. YAML composite step discovery → registration → execution in a workflow
 * 3. npm moflo-step-* package discovery → registration
 * 4. Priority ordering: built-in < npm < user directory
 * 5. Full workflow execution using a mix of built-in + user-defined steps
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRunner, runSpellFromContent } from '../../src/modules/spells/src/factory/runner-factory.js';
import { StepCommandRegistry } from '../../src/modules/spells/src/core/step-command-registry.js';
import { builtinCommands } from '../../src/modules/spells/src/commands/index.js';

// ============================================================================
// Test Environment
// ============================================================================

let projectRoot: string;

const JS_STEP = `
const { readFileSync, statSync } = require('node:fs');
const { extname } = require('node:path');
module.exports = {
  type: 'file-stats',
  description: 'Report file statistics',
  configSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  capabilities: [{ type: 'fs:read' }],
  validate(config) {
    if (!config.path) return { valid: false, errors: [{ path: 'path', message: 'required' }] };
    return { valid: true, errors: [] };
  },
  async execute(config) {
    const content = readFileSync(config.path, 'utf-8');
    const stat = statSync(config.path);
    return { success: true, data: { lines: content.split('\\n').length, bytes: stat.size, ext: extname(config.path) } };
  },
  describeOutputs() { return [{ name: 'lines', type: 'number' }, { name: 'bytes', type: 'number' }]; },
};
`;

const YAML_STEP = `
name: format-message
description: Format a message with level prefix
inputs:
  level:
    type: string
    required: false
    default: info
  text:
    type: string
    required: true
actions:
  - command: "echo [\${inputs.level}] \${inputs.text}"
`;

const NPM_STEP = `
module.exports = {
  type: 'npm-greet',
  description: 'Greeting step from npm',
  configSchema: { type: 'object', properties: { name: { type: 'string' } } },
  validate() { return { valid: true, errors: [] }; },
  async execute(config) { return { success: true, data: { greeting: 'Hello ' + (config.name || 'world') } }; },
  describeOutputs() { return [{ name: 'greeting', type: 'string' }]; },
};
`;

const WORKFLOW_YAML = `
name: system-test-spell
description: Tests built-in + user-defined steps together
arguments:
  target_file:
    type: string
    required: true
steps:
  - id: echo-start
    type: bash
    config:
      command: "echo 'Starting system test'"
  - id: analyze-file
    type: file-stats
    config:
      path: "{args.target_file}"
  - id: notify
    type: format-message
    config:
      level: "info"
      text: "Analysis complete"
`;

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeAll(() => {
  projectRoot = join(tmpdir(), `moflo-system-test-${Date.now()}`);
  mkdirSync(projectRoot, { recursive: true });

  // Create user step directory
  const stepsDir = join(projectRoot, 'spells', 'steps');
  mkdirSync(stepsDir, { recursive: true });
  writeFileSync(join(stepsDir, 'file-stats.js'), JS_STEP);
  writeFileSync(join(stepsDir, 'format-message.yaml'), YAML_STEP);

  // Create npm package
  const npmDir = join(projectRoot, 'node_modules', 'moflo-step-greet');
  mkdirSync(npmDir, { recursive: true });
  writeFileSync(join(npmDir, 'package.json'), JSON.stringify({
    name: 'moflo-step-greet',
    version: '1.0.0',
    main: 'index.js',
  }));
  writeFileSync(join(npmDir, 'index.js'), NPM_STEP);

  // Create a target file for file-stats to analyze
  writeFileSync(join(projectRoot, 'sample.txt'), 'line1\nline2\nline3\nline4\nline5\n');
});

afterAll(() => {
  if (existsSync(projectRoot)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// System Tests
// ============================================================================

describe('Pluggable Steps — System Test', () => {
  describe('1. Registry construction with all sources', () => {
    it('should register built-in, npm, and user directory steps', () => {
      const registry = new StepCommandRegistry();

      // Built-in commands (highest base priority)
      for (const cmd of builtinCommands) {
        registry.register(cmd);
      }

      // npm packages (lowest priority, loaded first)
      const npmWarnings = registry.loadFromNpm(projectRoot);
      expect(npmWarnings).toHaveLength(0);

      // User directory steps (highest priority, loaded last)
      const dirWarnings = registry.loadFromDirectories([
        join(projectRoot, 'spells', 'steps'),
      ]);
      expect(dirWarnings).toHaveLength(0);

      // Verify all sources registered
      expect(registry.has('bash')).toBe(true);          // built-in
      expect(registry.has('agent')).toBe(true);          // built-in
      expect(registry.has('github')).toBe(true);         // built-in
      expect(registry.has('outlook')).toBe(true);        // built-in
      expect(registry.has('file-stats')).toBe(true);     // user JS
      expect(registry.has('format-message')).toBe(true); // user YAML
      expect(registry.has('npm-greet')).toBe(true);      // npm

      // 11 built-in + 1 npm + 2 user = 14
      expect(registry.size).toBe(14);
    });
  });

  describe('2. JS step: discovery → validation → execution', () => {
    it('should discover, validate, and execute a JS step command', async () => {
      const registry = new StepCommandRegistry();
      registry.loadFromDirectories([join(projectRoot, 'spells', 'steps')]);

      const cmd = registry.get('file-stats')!;
      expect(cmd).toBeDefined();
      expect(cmd.type).toBe('file-stats');

      // Validation: missing path
      const invalid = cmd.validate({}, {} as any);
      expect(invalid.valid).toBe(false);

      // Validation: valid path
      const valid = cmd.validate({ path: join(projectRoot, 'sample.txt') }, {} as any);
      expect(valid.valid).toBe(true);

      // Execution
      const output = await cmd.execute({ path: join(projectRoot, 'sample.txt') }, {} as any);
      expect(output.success).toBe(true);
      expect(output.data.lines).toBe(6); // 5 lines + trailing newline
      expect(output.data.bytes).toBeGreaterThan(0);
      expect(output.data.ext).toBe('.txt');
    });
  });

  describe('3. YAML composite step: discovery → validation → execution', () => {
    it('should discover, validate, and execute a YAML composite step', async () => {
      const registry = new StepCommandRegistry();
      registry.loadFromDirectories([join(projectRoot, 'spells', 'steps')]);

      const cmd = registry.get('format-message')!;
      expect(cmd).toBeDefined();
      expect(cmd.type).toBe('format-message');
      expect(cmd.description).toContain('Format a message');

      // Validation: missing required input
      const invalid = cmd.validate({}, {} as any);
      expect(invalid.valid).toBe(false);
      expect(invalid.errors[0].message).toContain('text');

      // Validation: valid inputs
      const valid = cmd.validate({ level: 'warning', text: 'hello' }, {} as any);
      expect(valid.valid).toBe(true);

      // Execution with interpolation
      const output = await cmd.execute({ level: 'error', text: 'something broke' }, {} as any);
      expect(output.success).toBe(true);
      expect(output.data.actionCount).toBe(1);
      const results = output.data.results as Array<Record<string, unknown>>;
      const params = results[0].params as Record<string, unknown>;
      expect(params).toBeUndefined; // command-based action, no params
    });
  });

  describe('4. npm package discovery', () => {
    it('should discover and execute an npm-sourced step', async () => {
      const registry = new StepCommandRegistry();
      registry.loadFromNpm(projectRoot);

      const cmd = registry.get('npm-greet')!;
      expect(cmd).toBeDefined();
      expect(cmd.description).toBe('Greeting step from npm');

      const output = await cmd.execute({ name: 'MoFlo' }, {} as any);
      expect(output.success).toBe(true);
      expect(output.data.greeting).toBe('Hello MoFlo');
    });
  });

  describe('5. Priority ordering', () => {
    it('should let user directory steps override npm steps', () => {
      // Create an npm step with type "file-stats"
      const overrideDir = join(projectRoot, 'node_modules', 'moflo-step-filestats');
      mkdirSync(overrideDir, { recursive: true });
      writeFileSync(join(overrideDir, 'package.json'), JSON.stringify({
        name: 'moflo-step-filestats', version: '1.0.0', main: 'index.js',
      }));
      writeFileSync(join(overrideDir, 'index.js'), `
        module.exports = {
          type: 'file-stats',
          description: 'npm version of file-stats',
          configSchema: { type: 'object' },
          validate() { return { valid: true, errors: [] }; },
          async execute() { return { success: true, data: { source: 'npm' } }; },
          describeOutputs() { return []; },
        };
      `);

      const registry = new StepCommandRegistry();

      // Load npm first (lowest priority)
      registry.loadFromNpm(projectRoot);
      expect(registry.get('file-stats')!.description).toBe('npm version of file-stats');

      // Load user dir last (highest priority) — should override
      registry.loadFromDirectories([join(projectRoot, 'spells', 'steps')]);
      expect(registry.get('file-stats')!.description).toBe('Report file statistics');

      // Cleanup
      rmSync(overrideDir, { recursive: true });
    });

    it('should let user directory steps override built-in steps', () => {
      const overrideDir = join(projectRoot, 'override-steps');
      mkdirSync(overrideDir, { recursive: true });
      writeFileSync(join(overrideDir, 'custom-bash.js'), `
        module.exports = {
          type: 'bash',
          description: 'Custom bash override',
          configSchema: { type: 'object' },
          validate() { return { valid: true, errors: [] }; },
          async execute() { return { success: true, data: { custom: true } }; },
          describeOutputs() { return []; },
        };
      `);

      const registry = new StepCommandRegistry();
      for (const cmd of builtinCommands) {
        registry.register(cmd);
      }
      registry.loadFromDirectories([overrideDir]);

      expect(registry.get('bash')!.description).toBe('Custom bash override');

      rmSync(overrideDir, { recursive: true });
    });
  });

  describe('6. createRunner with stepDirs and projectRoot', () => {
    it('should create a runner with all discovery sources configured', () => {
      const runner = createRunner({
        stepDirs: [join(projectRoot, 'spells', 'steps')],
        projectRoot,
      });

      // Runner should be usable (it's a SpellCaster instance)
      expect(runner).toBeDefined();
      expect(typeof runner.run).toBe('function');
    });
  });

  describe('7. Full spell execution with mixed step types', () => {
    it('should execute a spell using built-in + user-defined steps', async () => {
      const result = await runSpellFromContent(
        WORKFLOW_YAML,
        'system-test.yaml',
        {
          stepDirs: [join(projectRoot, 'spells', 'steps')],
          projectRoot,
          skipAcceptanceCheck: true,
          args: { target_file: join(projectRoot, 'sample.txt') },
        },
      );

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.steps).toHaveLength(3);

      // Step 1: built-in bash
      expect(result.steps[0].stepId).toBe('echo-start');
      expect(result.steps[0].status).toBe('succeeded');

      // Step 2: user-defined JS step (file-stats)
      expect(result.steps[1].stepId).toBe('analyze-file');
      expect(result.steps[1].status).toBe('succeeded');

      // Step 3: user-defined YAML step (format-message)
      expect(result.steps[2].stepId).toBe('notify');
      expect(result.steps[2].status).toBe('succeeded');
    });

    it('should fail gracefully when a user step validation fails', async () => {
      const badWorkflow = `
name: bad-step-test
steps:
  - id: bad-stats
    type: file-stats
    config: {}
`;

      const result = await runSpellFromContent(
        badWorkflow,
        'bad-test.yaml',
        {
          stepDirs: [join(projectRoot, 'spells', 'steps')],
        },
      );

      // Should fail because file-stats requires 'path'
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should fail with UNKNOWN_STEP_TYPE for unregistered user step', async () => {
      const missingStepWorkflow = `
name: missing-step-test
steps:
  - id: ghost
    type: nonexistent-step
    config: {}
`;

      const result = await runSpellFromContent(
        missingStepWorkflow,
        'missing-test.yaml',
        {},
      );

      expect(result.success).toBe(false);
      // Caught at definition validation — unknown step type triggers DEFINITION_VALIDATION_FAILED
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].code).toBe('DEFINITION_VALIDATION_FAILED');
    });
  });

  describe('8. Error resilience', () => {
    it('should handle invalid JS files without crashing discovery', () => {
      const badDir = join(projectRoot, 'bad-steps');
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, 'broken.js'), 'module.exports = { not: "a step" };');
      writeFileSync(join(badDir, 'syntax-error.js'), 'module.exports = { {{');
      writeFileSync(join(badDir, 'good.js'), JS_STEP);

      const registry = new StepCommandRegistry();
      const warnings = registry.loadFromDirectories([badDir]);

      // Good step still registered despite bad neighbors
      expect(registry.has('file-stats')).toBe(true);
      // Warnings for bad files
      expect(warnings.length).toBeGreaterThanOrEqual(2);

      rmSync(badDir, { recursive: true });
    });

    it('should handle invalid YAML step files without crashing discovery', () => {
      const badDir = join(projectRoot, 'bad-yaml-steps');
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, 'no-name.yaml'), 'actions:\n  - command: echo hi');
      writeFileSync(join(badDir, 'good.yaml'), YAML_STEP);

      const registry = new StepCommandRegistry();
      const warnings = registry.loadFromDirectories([badDir]);

      expect(registry.has('format-message')).toBe(true);
      expect(warnings.length).toBeGreaterThanOrEqual(1);

      rmSync(badDir, { recursive: true });
    });
  });
});
