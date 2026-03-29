/**
 * Runner Bridge & Factory Tests
 *
 * Story #139: Tests for MCP tool integration bridge.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  bridgeRunWorkflow,
  bridgeCancelWorkflow,
  bridgeIsRunning,
  bridgeActiveWorkflows,
} from '../src/factory/runner-bridge.js';
import { createRunner, runWorkflowFromContent } from '../src/factory/runner-factory.js';

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
    expect(result.workflowId).toBeDefined();
  });
});

describe('runWorkflowFromContent', () => {
  it('should parse and run a YAML workflow', async () => {
    const yaml = `
name: test-workflow
steps:
  - id: step1
    type: wait
    config:
      duration: 0
`;
    const result = await runWorkflowFromContent(yaml, 'test.yaml');

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].stepId).toBe('step1');
  });

  it('should return structured error for invalid YAML', async () => {
    const result = await runWorkflowFromContent('{{invalid', 'bad.yaml');

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
    const result = await runWorkflowFromContent(yaml, 'invalid.yaml');

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
    const result = await runWorkflowFromContent(yaml, 'test.yaml', { dryRun: true });

    expect(result.success).toBe(true);
    // Dry run doesn't produce step results
    expect(result.steps).toHaveLength(0);
  });
});

// ============================================================================
// Runner Bridge
// ============================================================================

describe('bridgeRunWorkflow', () => {
  it('should run a workflow from content and track it', async () => {
    const yaml = `
name: bridge-test
steps:
  - id: s1
    type: wait
    config:
      duration: 0
`;
    const result = await bridgeRunWorkflow(yaml, 'test.yaml', {});

    expect(result.success).toBe(true);
    expect(result.workflowId).toMatch(/^wf-\d+$/);
    // After completion, should no longer be tracked
    expect(bridgeIsRunning(result.workflowId)).toBe(false);
  });
});

describe('bridgeCancelWorkflow', () => {
  it('should return false for unknown workflow ID', () => {
    expect(bridgeCancelWorkflow('nonexistent')).toBe(false);
  });
});

describe('bridgeActiveWorkflows', () => {
  it('should return empty array when no workflows running', () => {
    expect(bridgeActiveWorkflows()).toEqual([]);
  });
});

// ============================================================================
// #160 — Credentials wired through bridge
// ============================================================================

describe('#160 — bridgeRunWorkflow credentials parameter', () => {
  it('bridgeRunWorkflow accepts and passes through credentials option', async () => {
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

    const result = await bridgeRunWorkflow(yaml, undefined, {}, { credentials });
    expect(result.workflowId).toBeDefined();
    expect(result.success).toBe(true);
  });
});
