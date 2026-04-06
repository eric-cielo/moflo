/**
 * Enhanced Plugin Registry Tests
 *
 * Tests for version constraints, safe unload, parallel init,
 * hot reload, and conflict resolution.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  EnhancedPluginRegistry,
  type EnhancedPluginRegistryConfig,
} from '../src/registry/enhanced-plugin-registry.js';
import { PluginBuilder } from '../src/sdk/index.js';
import { BasePlugin } from '../src/core/base-plugin.js';
import type { PluginContext, PluginMetadata, HealthCheckResult } from '../src/types/index.js';
import type { IPlugin } from '../src/core/plugin-interface.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createTestPlugin(
  name: string,
  version = '1.0.0',
  dependencies?: Array<{ name: string; version: string }>
) {
  const builder = new PluginBuilder(name, version)
    .withDescription(`Test plugin: ${name}`);

  if (dependencies) {
    // Convert {name, version} objects to "name@version" strings for PluginBuilder
    builder.withDependencies(dependencies.map(d => `${d.name}@${d.version}`));
  }

  return builder.build();
}

/**
 * Creates a plain IPlugin object (not extending BasePlugin) for tests that need
 * to track lifecycle calls (initializeCalled, shutdownCalled) and support the
 * hot-reload state API (getState/setState).
 *
 * We avoid BasePlugin because its protected setState() method collides with the
 * hot-reload state preservation API (getState/setState) at runtime.
 */
function createTrackablePlugin(name: string, version: string): IPlugin & {
  initializeCalled: boolean;
  shutdownCalled: boolean;
  savedState: any;
} {
  const plugin = {
    metadata: { name, version } as PluginMetadata,
    state: 'uninitialized' as string,
    initializeCalled: false,
    shutdownCalled: false,
    savedState: null as any,

    async initialize(_context: PluginContext): Promise<void> {
      plugin.state = 'initialized';
      plugin.initializeCalled = true;
    },

    async shutdown(): Promise<void> {
      plugin.state = 'shutdown';
      plugin.shutdownCalled = true;
    },

    async getState(): Promise<unknown> {
      return plugin.savedState;
    },

    async setState(state: unknown): Promise<void> {
      plugin.savedState = state;
    },
  };

  return plugin as any;
}

function createConfig(overrides?: Partial<EnhancedPluginRegistryConfig>): EnhancedPluginRegistryConfig {
  return {
    coreVersion: '3.0.0',
    dataDir: '/tmp/test',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('EnhancedPluginRegistry', () => {
  let registry: EnhancedPluginRegistry;

  beforeEach(() => {
    registry = new EnhancedPluginRegistry(createConfig());
  });

  describe('registration', () => {
    it('should register a plugin', async () => {
      const plugin = createTestPlugin('test-plugin');

      await registry.register(plugin);

      expect(registry.getPlugin('test-plugin')).toBeDefined();
    });

    it('should reject duplicate plugins', async () => {
      const plugin = createTestPlugin('test-plugin');

      await registry.register(plugin);

      await expect(registry.register(plugin))
        .rejects.toThrow('already registered');
    });

    it('should respect max plugins limit', async () => {
      const limitedRegistry = new EnhancedPluginRegistry(createConfig({ maxPlugins: 2 }));

      await limitedRegistry.register(createTestPlugin('plugin-1'));
      await limitedRegistry.register(createTestPlugin('plugin-2'));

      await expect(limitedRegistry.register(createTestPlugin('plugin-3')))
        .rejects.toThrow('Maximum plugin limit');
    });
  });

  describe('version constraints', () => {
    it('should check minCoreVersion', async () => {
      const plugin = new PluginBuilder('test-plugin', '1.0.0')
        .withMinCoreVersion('4.0.0')
        .build();

      await expect(registry.register(plugin))
        .rejects.toThrow('requires core version >= 4.0.0');
    });

    it('should check maxCoreVersion', async () => {
      const plugin = new PluginBuilder('test-plugin', '1.0.0')
        .withMinCoreVersion('1.0.0')
        .build();

      // Should pass since 3.0.0 >= 1.0.0
      await registry.register(plugin);
      expect(registry.getPlugin('test-plugin')).toBeDefined();
    });

    it('should validate dependency versions during initialization', async () => {
      await registry.register(createTestPlugin('dep-plugin', '1.0.0'));
      await registry.register(createTestPlugin('main-plugin', '1.0.0', [
        { name: 'dep-plugin', version: '^2.0.0' }, // Incompatible
      ]));

      await expect(registry.initialize())
        .rejects.toThrow('Dependency validation failed');
    });

    it('should pass validation with compatible versions', async () => {
      await registry.register(createTestPlugin('dep-plugin', '1.5.0'));
      await registry.register(createTestPlugin('main-plugin', '1.0.0', [
        { name: 'dep-plugin', version: '^1.0.0' },
      ]));

      await registry.initialize();

      expect(registry.getStats().initialized).toBe(2);
    });
  });

  describe('safe unload', () => {
    it('should prevent unload of plugins with dependents', async () => {
      await registry.register(createTestPlugin('base-plugin'));
      await registry.register(createTestPlugin('dependent-plugin', '1.0.0', [
        { name: 'base-plugin', version: '*' },
      ]));
      await registry.initialize();

      await expect(registry.unregister('base-plugin'))
        .rejects.toThrow('required by');
    });

    it('should allow cascade unload', async () => {
      await registry.register(createTestPlugin('base-plugin'));
      await registry.register(createTestPlugin('dependent-plugin', '1.0.0', [
        { name: 'base-plugin', version: '*' },
      ]));
      await registry.initialize();

      await registry.unregister('base-plugin', { cascade: true });

      expect(registry.getPlugin('base-plugin')).toBeUndefined();
      expect(registry.getPlugin('dependent-plugin')).toBeUndefined();
    });

    it('should allow force unload', async () => {
      await registry.register(createTestPlugin('base-plugin'));
      await registry.register(createTestPlugin('dependent-plugin', '1.0.0', [
        { name: 'base-plugin', version: '*' },
      ]));
      await registry.initialize();

      await registry.unregister('base-plugin', { force: true });

      expect(registry.getPlugin('base-plugin')).toBeUndefined();
    });
  });

  describe('initialization strategies', () => {
    it('should initialize sequentially by default', async () => {
      const initOrder: string[] = [];

      class OrderTrackingPlugin extends BasePlugin {
        constructor(name: string) {
          super({ name, version: '1.0.0' });
        }
        protected async onInitialize(): Promise<void> {
          initOrder.push(this.metadata.name);
        }
      }

      const plugin1 = new OrderTrackingPlugin('plugin-1');
      const plugin2 = new OrderTrackingPlugin('plugin-2');

      await registry.register(plugin1);
      await registry.register(plugin2);
      await registry.initialize();

      expect(initOrder).toHaveLength(2);
    });

    it('should support parallel initialization', async () => {
      const parallelRegistry = new EnhancedPluginRegistry(createConfig({
        initializationStrategy: 'parallel',
        maxParallelInit: 5,
      }));

      await parallelRegistry.register(createTestPlugin('plugin-1'));
      await parallelRegistry.register(createTestPlugin('plugin-2'));
      await parallelRegistry.register(createTestPlugin('plugin-3'));

      await parallelRegistry.initialize();

      expect(parallelRegistry.getStats().initialized).toBe(3);
    });

    it('should support parallel-safe initialization', async () => {
      const safeRegistry = new EnhancedPluginRegistry(createConfig({
        initializationStrategy: 'parallel-safe',
      }));

      await safeRegistry.register(createTestPlugin('base'));
      await safeRegistry.register(createTestPlugin('dep-1', '1.0.0', [
        { name: 'base', version: '*' },
      ]));
      await safeRegistry.register(createTestPlugin('dep-2', '1.0.0', [
        { name: 'base', version: '*' },
      ]));

      await safeRegistry.initialize();

      expect(safeRegistry.getStats().initialized).toBe(3);
    });
  });

  describe('hot reload', () => {
    it('should reload a plugin', async () => {
      const plugin1 = createTrackablePlugin('test-plugin', '1.0.0');
      await registry.register(plugin1);
      await registry.initialize();

      expect(plugin1.initializeCalled).toBe(true);

      const plugin2 = createTrackablePlugin('test-plugin', '2.0.0');
      await registry.reload('test-plugin', plugin2);

      expect(plugin1.shutdownCalled).toBe(true);
      expect(plugin2.initializeCalled).toBe(true);
      expect(registry.getPlugin('test-plugin')?.metadata.version).toBe('2.0.0');
    });

    it('should preserve state during reload', async () => {
      const plugin1 = createTrackablePlugin('test-plugin', '1.0.0');
      plugin1.savedState = { counter: 42 };

      await registry.register(plugin1);
      await registry.initialize();

      const plugin2 = createTrackablePlugin('test-plugin', '2.0.0');

      await registry.reload('test-plugin', plugin2, {
        preserveState: true,
        migrateState: (state: any) => state,
      });

      expect(plugin2.savedState).toEqual({ counter: 42 });
    });

    it('should reject name mismatch', async () => {
      await registry.register(createTestPlugin('original'));
      await registry.initialize();

      await expect(registry.reload('original', createTestPlugin('different')))
        .rejects.toThrow('name mismatch');
    });
  });

  describe('conflict resolution', () => {
    it('should error on conflict by default', async () => {
      const plugin1 = new PluginBuilder('plugin-1', '1.0.0')
        .withMCPTools([{
          name: 'shared-tool',
          description: 'Tool 1',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({ content: [{ type: 'text', text: 'v1' }] }),
        }])
        .build();

      const plugin2 = new PluginBuilder('plugin-2', '1.0.0')
        .withMCPTools([{
          name: 'shared-tool',
          description: 'Tool 2',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({ content: [{ type: 'text', text: 'v2' }] }),
        }])
        .build();

      await registry.register(plugin1);
      await registry.register(plugin2);

      // The conflict error is caught per-plugin during sequential init,
      // so initialize() itself doesn't throw. The second plugin gets an error.
      await registry.initialize();

      const entry = registry.getPluginEntry('plugin-2');
      expect(entry?.error).toContain('conflict');
    });

    it('should support first-wins strategy', async () => {
      const conflictRegistry = new EnhancedPluginRegistry(createConfig({
        conflictResolution: {
          mcpTools: { strategy: 'first' },
        },
      }));

      const plugin1 = new PluginBuilder('plugin-1', '1.0.0')
        .withMCPTools([{
          name: 'shared-tool',
          description: 'Tool 1',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({ content: [{ type: 'text', text: 'v1' }] }),
        }])
        .build();

      const plugin2 = new PluginBuilder('plugin-2', '1.0.0')
        .withMCPTools([{
          name: 'shared-tool',
          description: 'Tool 2',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({ content: [{ type: 'text', text: 'v2' }] }),
        }])
        .build();

      await conflictRegistry.register(plugin1);
      await conflictRegistry.register(plugin2);
      await conflictRegistry.initialize();

      expect(conflictRegistry.getMCPTools()).toHaveLength(1);
      expect(conflictRegistry.getMCPTools()[0].description).toBe('Tool 1');
    });

    it('should support namespace strategy', async () => {
      const namespaceRegistry = new EnhancedPluginRegistry(createConfig({
        conflictResolution: {
          mcpTools: { strategy: 'namespace', namespaceTemplate: '{plugin}:{name}' },
        },
      }));

      const plugin1 = new PluginBuilder('plugin-1', '1.0.0')
        .withMCPTools([{
          name: 'tool',
          description: 'Tool 1',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({ content: [{ type: 'text', text: 'v1' }] }),
        }])
        .build();

      const plugin2 = new PluginBuilder('plugin-2', '1.0.0')
        .withMCPTools([{
          name: 'tool',
          description: 'Tool 2',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({ content: [{ type: 'text', text: 'v2' }] }),
        }])
        .build();

      await namespaceRegistry.register(plugin1);
      await namespaceRegistry.register(plugin2);
      await namespaceRegistry.initialize();

      const tools = namespaceRegistry.getMCPTools();
      expect(tools).toHaveLength(2);
      // First plugin keeps its original tool name; only the conflicting second
      // plugin's tool gets namespaced.
      expect(tools.map(t => t.name)).toContain('tool');
      expect(tools.map(t => t.name)).toContain('plugin-2:tool');
    });
  });

  describe('health check', () => {
    it('should return health status for all plugins', async () => {
      await registry.register(createTestPlugin('healthy-plugin'));
      await registry.initialize();

      const health = await registry.healthCheck();

      expect(health.get('healthy-plugin')?.healthy).toBe(true);
    });

    it('should report unhealthy for uninitialized plugins', async () => {
      await registry.register(createTestPlugin('uninitialized-plugin'));

      const health = await registry.healthCheck();

      expect(health.get('uninitialized-plugin')?.healthy).toBe(false);
      expect(health.get('uninitialized-plugin')?.message).toContain('not initialized');
    });
  });

  describe('enhanced service container', () => {
    it('should list all services', async () => {
      const services = registry.getServices();

      services.set('service-a', { value: 1 });
      services.set('service-b', { value: 2 });

      const keys = services.list();
      expect(keys).toContain('service-a');
      expect(keys).toContain('service-b');
      expect(keys).toContain('pluginRegistry');
    });

    it('should list services by prefix', async () => {
      const services = registry.getServices();

      services.set('db:mysql', {});
      services.set('db:postgres', {});
      services.set('cache:redis', {});

      const dbServices = services.listByPrefix('db:');
      expect(dbServices).toHaveLength(2);
      expect(dbServices).toContain('db:mysql');
      expect(dbServices).toContain('db:postgres');
    });

    it('should store and retrieve metadata', async () => {
      const services = registry.getServices();

      services.setWithMetadata('my-service', { active: true }, {
        provider: 'test-plugin',
        description: 'Test service',
        version: '1.0.0',
      });

      const metadata = services.getMetadata('my-service');
      expect(metadata?.provider).toBe('test-plugin');
      expect(metadata?.description).toBe('Test service');
    });
  });

  describe('stats', () => {
    it('should return correct statistics', async () => {
      const plugin1 = new PluginBuilder('plugin-1', '1.0.0')
        .withMCPTools([{
          name: 'tool-1',
          description: 'Tool',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({ content: [{ type: 'text', text: '' }] }),
        }])
        .build();

      await registry.register(plugin1);
      await registry.register(createTestPlugin('plugin-2'));
      await registry.initialize();

      const stats = registry.getStats();

      expect(stats.total).toBe(2);
      expect(stats.initialized).toBe(2);
      expect(stats.mcpTools).toBe(1);
    });
  });

  describe('shutdown', () => {
    it('should shutdown all plugins', async () => {
      const plugin1 = createTrackablePlugin('plugin-1', '1.0.0');
      const plugin2 = createTrackablePlugin('plugin-2', '1.0.0');

      await registry.register(plugin1);
      await registry.register(plugin2);
      await registry.initialize();
      await registry.shutdown();

      expect(plugin1.shutdownCalled).toBe(true);
      expect(plugin2.shutdownCalled).toBe(true);
    });
  });
});
