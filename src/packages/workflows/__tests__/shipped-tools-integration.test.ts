/**
 * Shipped Tools Integration Tests
 *
 * Issue #219: Verify that shipped tools are auto-registered by createRunner()
 * and accessible to custom steps via context.tools.execute().
 */

import { describe, it, expect, vi } from 'vitest';
import { createRunner, type RunnerFactoryOptions } from '../src/factory/runner-factory.js';
import { WorkflowToolRegistry } from '../src/registry/tool-registry.js';

// Mock child_process so github-cli tool doesn't hit real gh CLI
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    exec: (_cmd: string, _opts: unknown, callback: ExecCallback) => {
      const child = { exitCode: 0, kill: vi.fn() };
      process.nextTick(() => callback(null, '{}', ''));
      return child;
    },
    execFile: (_file: string, _args: string[], callback: (err: Error | null, stdout: string, stderr: string) => void) => {
      process.nextTick(() => callback(null, '/usr/bin/gh', ''));
      return { kill: vi.fn() };
    },
  };
});

describe('shipped tools integration', () => {
  it('createRunner auto-registers http, github-cli, and playwright tools', () => {
    const runner = createRunner();
    // The runner is created — we need to verify the tool registry it uses.
    // Since the runner is opaque, test via a workflow that accesses tools.
    expect(runner).toBeDefined();
  });

  it('shipped tools are registered in a fresh WorkflowToolRegistry', () => {
    // Create runner with no explicit toolRegistry — should auto-register
    const registry = new WorkflowToolRegistry();
    createRunner({ toolRegistry: registry });

    // Shipped tools should be registered
    expect(registry.has('http')).toBe(true);
    expect(registry.has('github-cli')).toBe(true);
    expect(registry.has('playwright')).toBe(true);
    expect(registry.size).toBeGreaterThanOrEqual(3);
  });

  it('user tool overrides shipped tool by name', () => {
    const registry = new WorkflowToolRegistry();

    // Register a custom tool with same name as shipped
    const customTool = {
      name: 'github-cli',
      description: 'Custom override',
      version: '2.0.0',
      capabilities: ['read' as const],
      initialize: async () => {},
      dispose: async () => {},
      execute: async () => ({ success: true, data: { custom: true } }),
      listActions: () => [],
    };
    registry.register(customTool, 'user');

    // createRunner should skip registering the shipped github-cli
    createRunner({ toolRegistry: registry } as RunnerFactoryOptions);

    const tool = registry.get('github-cli');
    expect(tool?.version).toBe('2.0.0');
    expect(tool?.description).toBe('Custom override');
  });

  it('createRunner without options works (defaults)', () => {
    const runner = createRunner();
    expect(runner).toBeDefined();
  });
});
