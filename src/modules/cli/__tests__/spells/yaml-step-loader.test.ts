/**
 * YAML Step Loader & Composite Command Tests
 *
 * Story #215: YAML composite step definitions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadYamlStep, isYamlStepFile } from '../../src/spells/loaders/yaml-step-loader.js';
import { loadStepsFromDirectories } from '../../src/spells/loaders/directory-step-loader.js';
import { createMockContext } from './helpers.js';
import type { ConnectorAccessor, ConnectorOutput } from '../../src/spells/types/spell-connector.types.js';

// ============================================================================
// Fixtures
// ============================================================================

const VALID_YAML_STEP = `
name: send-report
description: Send a report via email
tool: gmail
inputs:
  to:
    type: string
    required: true
  subject:
    type: string
    required: true
  body:
    type: string
    required: false
    default: "No body"
actions:
  - tool: gmail
    action: send
    params:
      to: "\${inputs.to}"
      subject: "\${inputs.subject}"
      body: "\${inputs.body}"
`;

const MINIMAL_YAML_STEP = `
name: simple-action
actions:
  - command: echo hello
`;

const NO_NAME_YAML = `
actions:
  - command: echo hello
`;

const NO_ACTIONS_YAML = `
name: broken
`;

const EMPTY_ACTIONS_YAML = `
name: broken
actions: []
`;

// ============================================================================
// Helpers
// ============================================================================

let testDir: string;
let cleanupDirs: string[] = [];

function createTempDir(suffix: string): string {
  const dir = join(tmpdir(), `moflo-yaml-step-test-${suffix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  cleanupDirs.push(dir);
  return dir;
}

// ============================================================================
// Tests
// ============================================================================

describe('YamlStepLoader', () => {
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

  describe('loadYamlStep', () => {
    it('should parse a valid YAML step definition into a StepCommand', () => {
      const filePath = join(testDir, 'send-report.yaml');
      writeFileSync(filePath, VALID_YAML_STEP);

      const command = loadYamlStep(filePath);

      expect(command.type).toBe('send-report');
      expect(command.description).toBe('Send a report via email');
      expect(command.configSchema.properties).toHaveProperty('to');
      expect(command.configSchema.properties).toHaveProperty('subject');
      expect(command.configSchema.properties).toHaveProperty('body');
      expect(command.configSchema.required).toContain('to');
      expect(command.configSchema.required).toContain('subject');
    });

    it('should parse a minimal YAML step (no inputs)', () => {
      const filePath = join(testDir, 'simple.yaml');
      writeFileSync(filePath, MINIMAL_YAML_STEP);

      const command = loadYamlStep(filePath);

      expect(command.type).toBe('simple-action');
      expect(command.description).toContain('simple-action');
    });

    it('should throw on missing name', () => {
      const filePath = join(testDir, 'no-name.yaml');
      writeFileSync(filePath, NO_NAME_YAML);

      expect(() => loadYamlStep(filePath)).toThrow("'name' is required");
    });

    it('should throw on missing actions', () => {
      const filePath = join(testDir, 'no-actions.yaml');
      writeFileSync(filePath, NO_ACTIONS_YAML);

      expect(() => loadYamlStep(filePath)).toThrow("'actions' is required");
    });

    it('should throw on empty actions array', () => {
      const filePath = join(testDir, 'empty-actions.yaml');
      writeFileSync(filePath, EMPTY_ACTIONS_YAML);

      expect(() => loadYamlStep(filePath)).toThrow("'actions' is required");
    });
  });

  describe('isYamlStepFile', () => {
    it('should return true for .yaml files', () => {
      expect(isYamlStepFile('step.yaml')).toBe(true);
      expect(isYamlStepFile('/path/to/step.YAML')).toBe(true);
    });

    it('should return true for .yml files', () => {
      expect(isYamlStepFile('step.yml')).toBe(true);
    });

    it('should return false for non-YAML files', () => {
      expect(isYamlStepFile('step.js')).toBe(false);
      expect(isYamlStepFile('step.ts')).toBe(false);
      expect(isYamlStepFile('step.json')).toBe(false);
    });
  });

  describe('Composite command execution', () => {
    it('should validate required inputs', () => {
      const filePath = join(testDir, 'send-report.yaml');
      writeFileSync(filePath, VALID_YAML_STEP);

      const command = loadYamlStep(filePath);
      const context = createMockContext();

      const result = command.validate({}, context);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2); // to and subject are required
    });

    it('should pass validation with all required inputs', () => {
      const filePath = join(testDir, 'send-report.yaml');
      writeFileSync(filePath, VALID_YAML_STEP);

      const command = loadYamlStep(filePath);
      const context = createMockContext();

      const result = command.validate({ to: 'test@example.com', subject: 'Hello' }, context);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate input types', () => {
      const filePath = join(testDir, 'send-report.yaml');
      writeFileSync(filePath, VALID_YAML_STEP);

      const command = loadYamlStep(filePath);
      const context = createMockContext();

      const result = command.validate({ to: 123, subject: 'Hello' }, context);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('expected type "string"');
    });

    it('should execute and return action results with interpolated params', async () => {
      const filePath = join(testDir, 'send-report.yaml');
      writeFileSync(filePath, VALID_YAML_STEP);

      const command = loadYamlStep(filePath);
      const mockConnectors: ConnectorAccessor = {
        get: (name: string) => name === 'gmail' ? { name, description: '', version: '1', capabilities: [], listActions: () => [] } : undefined,
        has: (name: string) => name === 'gmail',
        list: () => [],
        execute: async (_connectorName: string, _action: string, params: Record<string, unknown>): Promise<ConnectorOutput> => {
          return { success: true, data: { sent: true, ...params } };
        },
      };
      const context = createMockContext({ tools: mockConnectors });

      const output = await command.execute(
        { to: 'user@test.com', subject: 'Test', body: 'Body text' },
        context,
      );

      expect(output.success).toBe(true);
      expect(output.data.actionCount).toBe(1);
      const results = output.data.results as Array<Record<string, unknown>>;
      expect(results[0].tool).toBe('gmail');
      expect(results[0].action).toBe('send');
      expect(results[0].params).toEqual({
        to: 'user@test.com',
        subject: 'Test',
        body: 'Body text',
      });
    });

    it('should execute minimal step with no inputs', async () => {
      const filePath = join(testDir, 'simple.yaml');
      writeFileSync(filePath, MINIMAL_YAML_STEP);

      const command = loadYamlStep(filePath);
      const context = createMockContext();

      const validation = command.validate({}, context);
      expect(validation.valid).toBe(true);

      const output = await command.execute({}, context);
      expect(output.success).toBe(true);
      expect(output.data.actionCount).toBe(1);
    });

    it('should describe outputs', () => {
      const filePath = join(testDir, 'send-report.yaml');
      writeFileSync(filePath, VALID_YAML_STEP);

      const command = loadYamlStep(filePath);
      const outputs = command.describeOutputs();

      expect(outputs).toHaveLength(3);
      expect(outputs.map((o) => o.name)).toEqual(['actionCount', 'results', 'inputs']);
    });
  });

  describe('Directory integration', () => {
    it('should discover YAML steps alongside JS steps', () => {
      writeFileSync(join(testDir, 'notify.yaml'), VALID_YAML_STEP);
      writeFileSync(
        join(testDir, 'custom.js'),
        `module.exports = {
          type: 'custom-js',
          description: 'JS step',
          configSchema: { type: 'object' },
          validate() { return { valid: true, errors: [] }; },
          async execute() { return { success: true, data: {} }; },
          describeOutputs() { return []; },
        };`,
      );

      const result = loadStepsFromDirectories({ dirs: [testDir] });

      expect(result.steps.size).toBe(2);
      expect(result.steps.has('send-report')).toBe(true);
      expect(result.steps.has('custom-js')).toBe(true);
    });

    it('should handle invalid YAML step files as warnings', () => {
      writeFileSync(join(testDir, 'bad.yaml'), NO_NAME_YAML);

      const result = loadStepsFromDirectories({ dirs: [testDir] });

      expect(result.steps.size).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].message).toContain("'name' is required");
    });
  });

  describe('Capabilities and prerequisites', () => {
    it('should declare net capability when tool is specified', () => {
      const filePath = join(testDir, 'with-tool.yaml');
      writeFileSync(filePath, VALID_YAML_STEP);

      const command = loadYamlStep(filePath);

      expect(command.capabilities).toEqual(
        expect.arrayContaining([{ type: 'net' }]),
      );
    });

    it('should declare shell capability when command is used in actions', () => {
      const filePath = join(testDir, 'with-command.yaml');
      writeFileSync(filePath, MINIMAL_YAML_STEP);

      const command = loadYamlStep(filePath);

      expect(command.capabilities).toEqual(
        expect.arrayContaining([{ type: 'shell' }]),
      );
    });

    it('should declare prerequisite for tool dependency', () => {
      const filePath = join(testDir, 'with-tool.yaml');
      writeFileSync(filePath, VALID_YAML_STEP);

      const command = loadYamlStep(filePath);

      expect(command.prerequisites).toHaveLength(1);
      expect(command.prerequisites![0].name).toBe('gmail');
    });
  });
});
