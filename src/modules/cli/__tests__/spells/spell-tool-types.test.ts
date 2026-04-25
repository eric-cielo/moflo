import { describe, it, expect } from 'vitest';
import type {
  SpellConnector,
  ConnectorOutput,
  ConnectorAction,
  ConnectorCapability,
  ConnectorAccessor,
  ConnectorRegistryEntry,
  ConnectorSource,
} from '../../src/spells/types/spell-connector.types.js';

describe('SpellConnector types', () => {
  it('ConnectorOutput has required shape', () => {
    const output: ConnectorOutput = { success: true, data: { body: 'hello' } };
    expect(output.success).toBe(true);
    expect(output.data).toEqual({ body: 'hello' });
    expect(output.error).toBeUndefined();
    expect(output.duration).toBeUndefined();
  });

  it('ConnectorOutput with error fields', () => {
    const output: ConnectorOutput = {
      success: false,
      data: {},
      error: 'connection refused',
      duration: 150,
    };
    expect(output.success).toBe(false);
    expect(output.error).toBe('connection refused');
    expect(output.duration).toBe(150);
  });

  it('ConnectorAction has input/output schemas', () => {
    const action: ConnectorAction = {
      name: 'get',
      description: 'HTTP GET request',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          status: { type: 'number' },
          body: { type: 'string' },
        },
      },
    };
    expect(action.name).toBe('get');
    expect(action.inputSchema.required).toContain('url');
  });

  it('ConnectorCapability covers expected values', () => {
    const caps: ConnectorCapability[] = ['read', 'write', 'search', 'subscribe', 'authenticate'];
    expect(caps).toHaveLength(5);
  });

  it('ConnectorSource covers expected values', () => {
    const sources: ConnectorSource[] = ['shipped', 'user', 'npm'];
    expect(sources).toHaveLength(3);
  });

  it('SpellConnector can be structurally implemented', () => {
    const connector: SpellConnector = {
      name: 'test-connector',
      description: 'A test connector',
      version: '1.0.0',
      capabilities: ['read'] as const,
      initialize: async () => {},
      dispose: async () => {},
      execute: async (_action, _params) => ({ success: true, data: {} }),
      listActions: () => [],
    };
    expect(connector.name).toBe('test-connector');
    expect(connector.capabilities).toContain('read');
  });

  it('ConnectorRegistryEntry has expected structure', () => {
    const mockConnector: SpellConnector = {
      name: 'mock',
      description: 'mock',
      version: '0.0.1',
      capabilities: [],
      initialize: async () => {},
      dispose: async () => {},
      execute: async () => ({ success: true, data: {} }),
      listActions: () => [],
    };
    const entry: ConnectorRegistryEntry = {
      connector: mockConnector,
      source: 'shipped',
      registeredAt: new Date(),
    };
    expect(entry.source).toBe('shipped');
    expect(entry.connector.name).toBe('mock');
  });

  it('ConnectorAccessor interface is structurally valid', () => {
    const mockConnector: SpellConnector = {
      name: 'http',
      description: 'HTTP connector',
      version: '1.0.0',
      capabilities: ['read', 'write'],
      initialize: async () => {},
      dispose: async () => {},
      execute: async () => ({ success: true, data: {} }),
      listActions: () => [],
    };
    const accessor: ConnectorAccessor = {
      get: (name: string) => name === 'http' ? mockConnector : undefined,
      has: (name: string) => name === 'http',
      list: () => [{ name: 'http', description: 'HTTP connector', capabilities: ['read', 'write'] }],
      execute: async (_connectorName, _action, _params) => ({ success: true, data: {} }),
    };
    expect(accessor.has('http')).toBe(true);
    expect(accessor.get('http')?.name).toBe('http');
  });
});
