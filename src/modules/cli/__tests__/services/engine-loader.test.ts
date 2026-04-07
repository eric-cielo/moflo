/**
 * Engine Loader Tests
 *
 * Validates the shared workflow engine loader: caching behavior,
 * error handling, and getCachedEngine() semantics.
 *
 * Story #229: Shared engine loader.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// The engine loader uses a module-level cache, so we need resetModules()
// to get a fresh instance per test.

function createFakeEngine() {
  return {
    bridgeRunWorkflow: vi.fn(),
    bridgeExecuteWorkflow: vi.fn(),
    bridgeCancelWorkflow: vi.fn(),
    bridgeIsRunning: vi.fn(),
    bridgeActiveWorkflows: vi.fn(),
    Grimoire: vi.fn(),
    runWorkflowFromContent: vi.fn(),
  };
}

describe('engine-loader', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should export loadSpellEngine and getCachedEngine', async () => {
    const mod = await import('../../src/services/engine-loader.js');
    expect(typeof mod.loadSpellEngine).toBe('function');
    expect(typeof mod.getCachedEngine).toBe('function');
  });

  it('getCachedEngine should return null before any load', async () => {
    const mod = await import('../../src/services/engine-loader.js');
    expect(mod.getCachedEngine()).toBeNull();
  });

  it('loadSpellEngine should throw when workflows package is not built', async () => {
    vi.doMock('../../../../modules/spells/dist/index.js', () => {
      throw new Error('Cannot find module');
    });

    const mod = await import('../../src/services/engine-loader.js');
    await expect(mod.loadSpellEngine()).rejects.toThrow(
      'Workflow engine not available',
    );
  });

  it('loadSpellEngine should return the engine module on success', async () => {
    vi.doMock('../../../../modules/spells/dist/index.js', () => createFakeEngine());

    const mod = await import('../../src/services/engine-loader.js');
    const engine = await mod.loadSpellEngine();

    expect(engine).toBeDefined();
    expect(engine.bridgeRunWorkflow).toBeDefined();
    expect(engine.runWorkflowFromContent).toBeDefined();
  });

  it('should cache the engine after first load (singleton)', async () => {
    vi.doMock('../../../../modules/spells/dist/index.js', () => createFakeEngine());

    const mod = await import('../../src/services/engine-loader.js');

    const first = await mod.loadSpellEngine();
    const second = await mod.loadSpellEngine();
    expect(first).toBe(second);
  });

  it('getCachedEngine should return the engine after successful load', async () => {
    vi.doMock('../../../../modules/spells/dist/index.js', () => createFakeEngine());

    const mod = await import('../../src/services/engine-loader.js');

    expect(mod.getCachedEngine()).toBeNull();
    await mod.loadSpellEngine();
    expect(mod.getCachedEngine()).not.toBeNull();
  });
});
