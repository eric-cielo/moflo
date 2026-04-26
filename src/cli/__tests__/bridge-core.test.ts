/**
 * Tests for bridge-core — the registry loader that powers every moflodb_*
 * MCP tool. Regression guard for #511 (silent catch → bridge-not-available).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

describe('bridge-core error surfacing', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.MOFLO_BRIDGE_QUIET;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('captures init error on getBridgeLastError() when ControllerRegistry throws', async () => {
    process.env.MOFLO_BRIDGE_QUIET = '1'; // suppress stderr in test output
    const kaboom = new Error('ControllerRegistry init failed: synthetic test failure');
    // Stub the ControllerRegistry import so we can control the failure mode.
    vi.doMock('../memory/controller-registry.js', () => ({
      ControllerRegistry: class {
        async initialize() {
          throw kaboom;
        }
      },
    }));

    const { getRegistry, getBridgeLastError } = await import('../memory/bridge-core.js');
    const reg = await getRegistry(':memory:');
    expect(reg).toBeNull();

    const err = getBridgeLastError();
    expect(err).not.toBeNull();
    expect(err?.message).toContain('synthetic test failure');
  });

  it('clears lastBridgeError after a successful init', async () => {
    process.env.MOFLO_BRIDGE_QUIET = '1';
    let attempt = 0;
    vi.doMock('../memory/controller-registry.js', () => ({
      ControllerRegistry: class {
        async initialize() {
          attempt++;
          if (attempt === 1) throw new Error('first attempt fails');
          // Second attempt succeeds — simulate minimal surface the bridge uses.
        }
        getMofloDb() { return { database: null }; }
        listControllers() { return [{ name: 'tieredCache', enabled: true, level: 1 }]; }
        get() { return null; }
        async shutdown() {}
      },
    }));

    const { getRegistry, getBridgeLastError } = await import('../memory/bridge-core.js');
    const first = await getRegistry(':memory:');
    expect(first).toBeNull();
    expect(getBridgeLastError()?.message).toContain('first attempt fails');

    // A second getRegistry() with a fresh error state retries because the
    // first failure nulled registryPromise.
    const second = await getRegistry(':memory:');
    expect(second).not.toBeNull();
    expect(getBridgeLastError()).toBeNull();
  });

  it('writes a stderr breadcrumb on init failure (unless MOFLO_BRIDGE_QUIET is set)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('../memory/controller-registry.js', () => ({
      ControllerRegistry: class {
        async initialize() { throw new Error('boom-surfaced-to-stderr'); }
      },
    }));

    const { getRegistry } = await import('../memory/bridge-core.js');
    await getRegistry(':memory:');

    const calls = errSpy.mock.calls.map(c => String(c[0] ?? ''));
    expect(calls.some(m => m.includes('MofloDb bridge init failed'))).toBe(true);
    expect(calls.some(m => m.includes('boom-surfaced-to-stderr'))).toBe(true);
  });

  it('respects MOFLO_BRIDGE_QUIET=1 — no stderr breadcrumb', async () => {
    process.env.MOFLO_BRIDGE_QUIET = '1';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('../memory/controller-registry.js', () => ({
      ControllerRegistry: class {
        async initialize() { throw new Error('quiet-error'); }
      },
    }));

    const { getRegistry } = await import('../memory/bridge-core.js');
    await getRegistry(':memory:');

    const calls = errSpy.mock.calls.map(c => String(c[0] ?? ''));
    expect(calls.some(m => m.includes('quiet-error'))).toBe(false);
  });
});
