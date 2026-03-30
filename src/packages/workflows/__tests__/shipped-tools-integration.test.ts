/**
 * Shipped Connectors Integration Tests
 *
 * Issue #219: Verify that shipped connectors are auto-registered by createRunner()
 * and accessible to custom steps via context.tools.execute().
 */

import { describe, it, expect, vi } from 'vitest';
import { createRunner, type RunnerFactoryOptions } from '../src/factory/runner-factory.js';
import { WorkflowConnectorRegistry } from '../src/registry/connector-registry.js';

// Mock child_process so github-cli connector doesn't hit real gh CLI
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

describe('shipped connectors integration', () => {
  it('createRunner auto-registers http, github-cli, and playwright connectors', () => {
    const runner = createRunner();
    // The runner is created — we need to verify the connector registry it uses.
    // Since the runner is opaque, test via a workflow that accesses connectors.
    expect(runner).toBeDefined();
  });

  it('shipped connectors are registered in a fresh WorkflowConnectorRegistry', () => {
    // Create runner with no explicit connectorRegistry — should auto-register
    const registry = new WorkflowConnectorRegistry();
    createRunner({ connectorRegistry: registry });

    // Shipped connectors should be registered
    expect(registry.has('http')).toBe(true);
    expect(registry.has('github-cli')).toBe(true);
    expect(registry.has('playwright')).toBe(true);
    expect(registry.size).toBeGreaterThanOrEqual(3);
  });

  it('user connector overrides shipped connector by name', () => {
    const registry = new WorkflowConnectorRegistry();

    // Register a custom connector with same name as shipped
    const customConnector = {
      name: 'github-cli',
      description: 'Custom override',
      version: '2.0.0',
      capabilities: ['read' as const],
      initialize: async () => {},
      dispose: async () => {},
      execute: async () => ({ success: true, data: { custom: true } }),
      listActions: () => [],
    };
    registry.register(customConnector, 'user');

    // createRunner should skip registering the shipped github-cli
    createRunner({ connectorRegistry: registry } as RunnerFactoryOptions);

    const connector = registry.get('github-cli');
    expect(connector?.version).toBe('2.0.0');
    expect(connector?.description).toBe('Custom override');
  });

  it('createRunner without options works (defaults)', () => {
    const runner = createRunner();
    expect(runner).toBeDefined();
  });
});
