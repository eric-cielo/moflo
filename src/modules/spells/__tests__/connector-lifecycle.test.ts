/**
 * Connector Lifecycle Tests
 *
 * Story #246: Verify SpellCaster manages connector initialize/dispose.
 *
 * Connectors are lazily initialized on first execute() call via
 * ConnectorAccessorImpl, and disposed by the runner in a finally block
 * after step execution completes (regardless of success/failure).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpellCaster } from '../src/core/runner.js';
import { StepCommandRegistry } from '../src/core/step-command-registry.js';
import { SpellConnectorRegistry } from '../src/registry/connector-registry.js';
import type {
  StepCommand,
  CredentialAccessor,
  MemoryAccessor,
  CastingContext,
} from '../src/types/step-command.types.js';
import type { SpellDefinition } from '../src/types/workflow-definition.types.js';
import type { SpellConnector } from '../src/types/workflow-connector.types.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockCredentials(): CredentialAccessor {
  return {
    async get() { return undefined; },
    async has() { return false; },
  };
}

function createMockMemory(): MemoryAccessor {
  const store = new Map<string, unknown>();
  return {
    async read(ns: string, key: string) { return store.get(`${ns}:${key}`) ?? null; },
    async write(ns: string, key: string, value: unknown) { store.set(`${ns}:${key}`, value); },
    async search() { return []; },
  };
}

function simpleWorkflow(steps: SpellDefinition['steps']): SpellDefinition {
  return { name: 'test-workflow', steps };
}

function createMockConnector(name: string, overrides?: Partial<SpellConnector>): SpellConnector {
  return {
    name,
    description: `Mock ${name} connector`,
    version: '1.0.0',
    capabilities: ['read'],
    initialize: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    execute: vi.fn(async () => ({ success: true, data: {} })),
    listActions: () => [],
    ...overrides,
  };
}

/** Step command that calls context.tools.execute() to trigger connector use. */
function createConnectorCallingCommand(connectorName: string): StepCommand {
  return {
    type: 'connector-call',
    description: 'Calls a connector',
    configSchema: { type: 'object' },
    capabilities: [{ type: 'net' }],
    validate: () => ({ valid: true, errors: [] }),
    execute: async (_config: unknown, context: CastingContext) => {
      const tools = context.tools;
      if (!tools) return { success: false, data: {}, error: 'No tools' };
      const result = await tools.execute(connectorName, 'test-action', {});
      return { success: result.success, data: result.data, duration: 1 };
    },
    describeOutputs: () => [],
  };
}

function createMockCommand(overrides?: Partial<StepCommand>): StepCommand {
  return {
    type: 'mock',
    description: 'Mock command',
    configSchema: { type: 'object' },
    validate: () => ({ valid: true, errors: [] }),
    execute: async () => ({ success: true, data: { result: 'ok' }, duration: 10 }),
    describeOutputs: () => [{ name: 'result', type: 'string' }],
    ...overrides,
  };
}

// ============================================================================
// Setup
// ============================================================================

let stepRegistry: StepCommandRegistry;
let memory: MemoryAccessor;

beforeEach(() => {
  stepRegistry = new StepCommandRegistry();
  memory = createMockMemory();
});

// ============================================================================
// Connector Lifecycle (Lazy Init + Dispose)
// ============================================================================

describe('SpellCaster — connector lifecycle', () => {
  it('should lazily initialize connector on first execute and dispose after run', async () => {
    const conn = createMockConnector('test-conn');
    const connectorRegistry = new SpellConnectorRegistry();
    connectorRegistry.register(conn, 'shipped');

    stepRegistry.register(createConnectorCallingCommand('test-conn'));
    const runner = new SpellCaster(stepRegistry, createMockCredentials(), memory, connectorRegistry);

    const result = await runner.run(
      simpleWorkflow([{ id: 's1', type: 'connector-call', config: {} }]),
      {},
    );

    expect(result.success).toBe(true);
    expect(conn.initialize).toHaveBeenCalledOnce();
    expect(conn.dispose).toHaveBeenCalledOnce();
  });

  it('should not initialize connectors that are never used', async () => {
    const usedConn = createMockConnector('used-conn');
    const unusedConn = createMockConnector('unused-conn');

    const connectorRegistry = new SpellConnectorRegistry();
    connectorRegistry.register(usedConn, 'shipped');
    connectorRegistry.register(unusedConn, 'shipped');

    stepRegistry.register(createConnectorCallingCommand('used-conn'));
    const runner = new SpellCaster(stepRegistry, createMockCredentials(), memory, connectorRegistry);

    const result = await runner.run(
      simpleWorkflow([{ id: 's1', type: 'connector-call', config: {} }]),
      {},
    );

    expect(result.success).toBe(true);
    expect(usedConn.initialize).toHaveBeenCalledOnce();
    expect(usedConn.dispose).toHaveBeenCalledOnce();
    expect(unusedConn.initialize).not.toHaveBeenCalled();
    expect(unusedConn.dispose).not.toHaveBeenCalled();
  });

  it('should return failure when connector init fails during step execution', async () => {
    const conn = createMockConnector('failing-conn', {
      initialize: vi.fn(async () => { throw new Error('browser not installed'); }),
    });

    const connectorRegistry = new SpellConnectorRegistry();
    connectorRegistry.register(conn, 'shipped');

    stepRegistry.register(createConnectorCallingCommand('failing-conn'));
    const runner = new SpellCaster(stepRegistry, createMockCredentials(), memory, connectorRegistry);

    const result = await runner.run(
      simpleWorkflow([{ id: 's1', type: 'connector-call', config: {} }]),
      {},
    );

    expect(result.success).toBe(false);
    // The step that triggered the connector init should have failed
    expect(result.steps[0].status).toBe('failed');
    // The init error surfaces through the workflow errors
    const allErrors = [
      ...result.errors.map(e => e.message),
      result.steps[0].error ?? '',
    ].join(' ');
    expect(allErrors).toBeTruthy();
  });

  it('should swallow dispose errors without affecting spell result', async () => {
    const conn = createMockConnector('test-conn', {
      dispose: vi.fn(async () => { throw new Error('dispose boom'); }),
    });

    const connectorRegistry = new SpellConnectorRegistry();
    connectorRegistry.register(conn, 'shipped');

    stepRegistry.register(createConnectorCallingCommand('test-conn'));
    const runner = new SpellCaster(stepRegistry, createMockCredentials(), memory, connectorRegistry);

    const result = await runner.run(
      simpleWorkflow([{ id: 's1', type: 'connector-call', config: {} }]),
      {},
    );

    // Workflow should still succeed despite dispose failure
    expect(result.success).toBe(true);
    expect(conn.dispose).toHaveBeenCalledOnce();
  });

  it('should work identically when no connector registry is provided', async () => {
    stepRegistry.register(createMockCommand());
    const runner = new SpellCaster(stepRegistry, createMockCredentials(), memory);

    const result = await runner.run(
      simpleWorkflow([{ id: 's1', type: 'mock', config: {} }]),
      {},
    );

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(1);
  });

  it('should work when connector registry is empty', async () => {
    const connectorRegistry = new SpellConnectorRegistry();

    stepRegistry.register(createMockCommand());
    const runner = new SpellCaster(stepRegistry, createMockCredentials(), memory, connectorRegistry);

    const result = await runner.run(
      simpleWorkflow([{ id: 's1', type: 'mock', config: {} }]),
      {},
    );

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(1);
  });

  it('should dispose initialized connectors even when a step fails', async () => {
    const conn = createMockConnector('test-conn');
    const connectorRegistry = new SpellConnectorRegistry();
    connectorRegistry.register(conn, 'shipped');

    // First step uses the connector (triggers init), second step fails
    stepRegistry.register(createConnectorCallingCommand('test-conn'));
    stepRegistry.register(createMockCommand({
      type: 'failing',
      execute: async () => ({ success: false, data: {}, error: 'step boom', duration: 5 }),
    }));
    const runner = new SpellCaster(stepRegistry, createMockCredentials(), memory, connectorRegistry);

    const result = await runner.run(
      simpleWorkflow([
        { id: 's1', type: 'connector-call', config: {} },
        { id: 's2', type: 'failing', config: {} },
      ]),
      {},
    );

    expect(result.success).toBe(false);
    expect(conn.initialize).toHaveBeenCalledOnce();
    expect(conn.dispose).toHaveBeenCalledOnce();
  });

  it('should dispose initialized connectors when spell is cancelled', async () => {
    const conn = createMockConnector('test-conn');
    const connectorRegistry = new SpellConnectorRegistry();
    connectorRegistry.register(conn, 'shipped');

    // Step that uses connector, then triggers cancellation
    const ac = new AbortController();
    stepRegistry.register({
      type: 'use-and-cancel',
      description: 'Uses connector then cancels',
      configSchema: { type: 'object' },
      capabilities: [{ type: 'net' }],
      validate: () => ({ valid: true, errors: [] }),
      execute: async (_config: unknown, context: CastingContext) => {
        const tools = context.tools;
        if (tools) await tools.execute('test-conn', 'test-action', {});
        ac.abort();
        return { success: true, data: {}, duration: 1 };
      },
      describeOutputs: () => [],
    });
    stepRegistry.register(createMockCommand());

    const runner = new SpellCaster(stepRegistry, createMockCredentials(), memory, connectorRegistry);

    const result = await runner.run(
      simpleWorkflow([
        { id: 's1', type: 'use-and-cancel', config: {} },
        { id: 's2', type: 'mock', config: {} },
      ]),
      {},
      { signal: ac.signal },
    );

    expect(result.cancelled).toBe(true);
    expect(conn.initialize).toHaveBeenCalledOnce();
    expect(conn.dispose).toHaveBeenCalledOnce();
  });

  it('should only initialize a connector once even if called multiple times', async () => {
    const conn = createMockConnector('test-conn');
    const connectorRegistry = new SpellConnectorRegistry();
    connectorRegistry.register(conn, 'shipped');

    stepRegistry.register(createConnectorCallingCommand('test-conn'));
    const runner = new SpellCaster(stepRegistry, createMockCredentials(), memory, connectorRegistry);

    const result = await runner.run(
      simpleWorkflow([
        { id: 's1', type: 'connector-call', config: {} },
        { id: 's2', type: 'connector-call', config: {} },
      ]),
      {},
    );

    expect(result.success).toBe(true);
    expect(conn.initialize).toHaveBeenCalledOnce();
    expect(conn.execute).toHaveBeenCalledTimes(2);
    expect(conn.dispose).toHaveBeenCalledOnce();
  });
});
