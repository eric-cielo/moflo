import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectorAccessorImpl } from '../src/core/connector-accessor.js';
import { SpellConnectorRegistry } from '../src/registry/connector-registry.js';
import type { SpellConnector } from '../src/types/spell-connector.types.js';

function makeConnector(name: string): SpellConnector {
  return {
    name,
    description: `${name} connector`,
    version: '1.0.0',
    capabilities: ['read', 'write'],
    initialize: async () => {},
    dispose: async () => {},
    execute: async (action, params) => ({
      success: true,
      data: { action, params },
    }),
    listActions: () => [{
      name: 'get',
      description: 'Get something',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    }],
  };
}

describe('ConnectorAccessorImpl', () => {
  let registry: SpellConnectorRegistry;
  let accessor: ConnectorAccessorImpl;

  beforeEach(() => {
    registry = new SpellConnectorRegistry();
    registry.register(makeConnector('http'), 'shipped');
    registry.register(makeConnector('slack'), 'user');
    accessor = new ConnectorAccessorImpl(registry);
  });

  it('has returns true for registered connector', () => {
    expect(accessor.has('http')).toBe(true);
    expect(accessor.has('slack')).toBe(true);
  });

  it('has returns false for unregistered connector', () => {
    expect(accessor.has('nonexistent')).toBe(false);
  });

  it('get returns connector by name', () => {
    const connector = accessor.get('http');
    expect(connector).toBeDefined();
    expect(connector!.name).toBe('http');
  });

  it('get returns undefined for unknown connector', () => {
    expect(accessor.get('nonexistent')).toBeUndefined();
  });

  it('list returns all connectors with metadata', () => {
    const connectors = accessor.list();
    expect(connectors).toHaveLength(2);
    expect(connectors[0].name).toBe('http');
    expect(connectors[0].capabilities).toEqual(['read', 'write']);
  });

  it('execute delegates to connector', async () => {
    const result = await accessor.execute('http', 'get', { url: 'https://example.com' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      action: 'get',
      params: { url: 'https://example.com' },
    });
  });

  it('execute returns error for unknown connector', async () => {
    const result = await accessor.execute('nonexistent', 'get', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('SpellCaster connector integration', () => {
  // Dynamic imports + factory init are slow under Windows parallel-fork load;
  // 5s default isn't enough when worker cold-starts contend for CPU.
  it('runner works without connector registry (backward compat)', { timeout: 30000 }, async () => {
    const { createRunner } = await import('../src/factory/runner-factory.js');
    const runner = createRunner();

    // A simple spell with a wait step
    const result = await runner.run(
      {
        name: 'test-no-connectors',
        version: '1.0.0',
        steps: [{
          id: 'step1',
          type: 'wait',
          config: { duration: 0 },
        }],
      },
      {},
    );
    expect(result.success).toBe(true);
  });

  it('runner with connector registry populates context.tools', async () => {
    const { SpellCaster } = await import('../src/core/runner.js');
    const { StepCommandRegistry } = await import('../src/core/step-command-registry.js');

    const connectorRegistry = new SpellConnectorRegistry();
    connectorRegistry.register(makeConnector('http'), 'shipped');

    const stepRegistry = new StepCommandRegistry();
    // Register a custom step that checks for connectors in context
    let contextTools: unknown = undefined;
    stepRegistry.register({
      type: 'check-connectors',
      description: 'Check if connectors are in context',
      configSchema: { type: 'object' },
      validate: () => ({ valid: true, errors: [] }),
      execute: async (_config, context) => {
        contextTools = context.tools;
        return {
          success: true,
          data: { hasTools: !!context.tools, hasHttp: context.tools?.has('http') ?? false },
        };
      },
      describeOutputs: () => [],
    });

    const runner = new SpellCaster(
      stepRegistry,
      { async get() { return undefined; }, async has() { return false; } },
      { async read() { return null; }, async write() {}, async search() { return []; } },
      connectorRegistry,
    );

    const result = await runner.run(
      {
        name: 'test-with-connectors',
        version: '1.0.0',
        steps: [{
          id: 'step1',
          type: 'check-connectors',
          config: {},
        }],
      },
      {},
    );

    expect(result.success).toBe(true);
    expect(contextTools).toBeDefined();
    expect(result.outputs.step1).toEqual({ hasTools: true, hasHttp: true });
  });
});
