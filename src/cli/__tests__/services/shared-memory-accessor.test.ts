/**
 * Tests for `getSharedMemoryAccessor` in services/daemon-dashboard.ts (#1020).
 *
 * The shared accessor consolidates lazy-init that was previously duplicated
 * across `mcp-tools/spell-tools.ts` and `epic/runner-adapter.ts`. Both
 * previously paid the cold init cost independently and the runner-adapter
 * version had a latent concurrent-init race (the spell-tools one was fixed
 * in #1016 by promise-memoization). The shared helper preserves the
 * promise-memoization and adds a test reset so the singleton can be
 * cleared between cases.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Stable mock for memory-initializer — the real one performs DB I/O and
// we only care about *how many times* createDashboardMemoryAccessor's
// dynamic import resolves, not what the entries do.
vi.mock('../../memory/memory-initializer.js', () => ({
  searchEntries: vi.fn().mockResolvedValue({ success: true, results: [], searchTime: 0 }),
  getEntry: vi.fn().mockResolvedValue({ success: true, found: false }),
  storeEntry: vi.fn().mockResolvedValue({ success: true }),
  listEntries: vi.fn().mockResolvedValue({ success: true, entries: [], total: 0 }),
}));

import {
  getSharedMemoryAccessor,
  _resetSharedMemoryAccessorForTest,
} from '../../services/daemon-dashboard.js';

const INIT_LOG = '[dashboard] Memory accessor initialized successfully';

describe('getSharedMemoryAccessor (#1020)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetSharedMemoryAccessorForTest();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    _resetSharedMemoryAccessorForTest();
  });

  it('returns a working accessor on first call', async () => {
    const accessor = await getSharedMemoryAccessor();
    expect(accessor).not.toBeNull();
    expect(typeof accessor!.read).toBe('function');
    expect(typeof accessor!.write).toBe('function');
    expect(typeof accessor!.search).toBe('function');
  });

  it('two concurrent first-callers share a single init (no double init race)', async () => {
    // The race the helper prevents: without promise-memoization, both
    // awaits would fire createDashboardMemoryAccessor in parallel and the
    // loser's accessor handle would leak. Promise-memoization means both
    // callers receive the SAME accessor instance and the underlying init
    // log fires exactly once.
    const [a, b] = await Promise.all([
      getSharedMemoryAccessor(),
      getSharedMemoryAccessor(),
    ]);
    expect(a).toBe(b);

    const initLogs = logSpy.mock.calls.filter(c => c[0] === INIT_LOG);
    expect(initLogs).toHaveLength(1);
  });

  it('sequential calls return the memoized instance without re-running init', async () => {
    const first = await getSharedMemoryAccessor();
    const second = await getSharedMemoryAccessor();
    const third = await getSharedMemoryAccessor();

    expect(second).toBe(first);
    expect(third).toBe(first);

    const initLogs = logSpy.mock.calls.filter(c => c[0] === INIT_LOG);
    expect(initLogs).toHaveLength(1);
  });

  it('_resetSharedMemoryAccessorForTest clears the singleton so the next call re-inits', async () => {
    const before = await getSharedMemoryAccessor();
    _resetSharedMemoryAccessorForTest();
    const after = await getSharedMemoryAccessor();

    // Different objects — proves the singleton was actually cleared.
    expect(after).not.toBe(before);

    // Init log fired twice (once per fresh init).
    const initLogs = logSpy.mock.calls.filter(c => c[0] === INIT_LOG);
    expect(initLogs).toHaveLength(2);
  });
});

describe('getSharedMemoryAccessor — error path (#1020)', () => {
  // Separate describe block uses vi.resetModules + vi.doMock to simulate
  // a failing dynamic import (e.g. the memory-initializer module is broken
  // in the consumer's install). The helper must catch, warn, and return
  // null so callers degrade gracefully.
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    // Clear vi.doMock registrations + module graph together so a subsequent
    // describe block (or growth of this file) starts with a clean slate.
    vi.doUnmock('../../memory/memory-initializer.js');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('returns null and warns when memory-initializer import fails', async () => {
    // Reset the module graph and re-mock the importer to throw.
    vi.resetModules();
    vi.doMock('../../memory/memory-initializer.js', () => {
      throw new Error('memory-initializer is broken');
    });

    const mod = await import('../../services/daemon-dashboard.js');
    mod._resetSharedMemoryAccessorForTest();

    const accessor = await mod.getSharedMemoryAccessor();
    expect(accessor).toBeNull();

    const warnings = warnSpy.mock.calls.map(c => String(c[0]));
    expect(warnings.some(w => /\[memory\] dashboard accessor unavailable/.test(w))).toBe(true);
    expect(warnings.some(w => /\[memory\] runs will NOT appear in The Luminarium/.test(w))).toBe(true);
  });
});
