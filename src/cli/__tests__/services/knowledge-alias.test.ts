/**
 * knowledge → learnings soft-redirect (storeEntry).
 *
 * Verifies that calls into storeEntry with namespace='knowledge' are
 * transparently routed to the learnings namespace with provenance tags
 * (source:user, locked) so future decay/prune leaves them alone.
 *
 * The bridge.bridgeStoreEntry path is mocked to capture the post-redirect
 * options without touching real sql.js or the filesystem.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs so nothing touches the real filesystem.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(Buffer.alloc(0)),
    statSync: vi.fn().mockReturnValue({ size: 1024 }),
  };
});

vi.mock('../../services/moflo-require.js', () => ({
  mofloImport: vi.fn().mockRejectedValue(new Error('mocked — bridge path captures the call first')),
}));

const bridgeCalls: Array<Record<string, unknown>> = [];

// memory-initializer's getBridge() does `await import('./memory-bridge.js')`
// and calls bridgeStoreEntry as a named export on that module — so the mock
// needs to expose bridgeStoreEntry at module level, not inside a getBridge wrapper.
vi.mock('../../memory/memory-bridge.js', () => ({
  bridgeStoreEntry: async (options: Record<string, unknown>) => {
    bridgeCalls.push(options);
    return { success: true, id: 'mock-id' };
  },
  // Other named exports memory-initializer.ts may pull from this module.
  getControllerRegistry: () => null,
}));

describe('storeEntry: knowledge → learnings soft-redirect', () => {
  beforeEach(() => {
    bridgeCalls.length = 0;
  });

  it('redirects namespace="knowledge" to "learnings" before reaching the bridge', async () => {
    const { storeEntry } = await import('../../memory/memory-initializer.js');

    const result = await storeEntry({
      key: 'session:2026-04-28-decision',
      value: 'decided to consolidate knowledge into learnings',
      namespace: 'knowledge',
    });

    expect(result.success).toBe(true);
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0].namespace).toBe('learnings');
  });

  it('stamps locked + source:user tags on redirected writes', async () => {
    const { storeEntry } = await import('../../memory/memory-initializer.js');

    await storeEntry({
      key: 'k:remember-this',
      value: 'remember this decision',
      namespace: 'knowledge',
    });

    expect(bridgeCalls).toHaveLength(1);
    const tags = bridgeCalls[0].tags as string[];
    expect(tags).toContain('source:user');
    expect(tags).toContain('locked');
  });

  it('preserves caller-supplied tags alongside the provenance markers', async () => {
    const { storeEntry } = await import('../../memory/memory-initializer.js');

    await storeEntry({
      key: 'k:tagged',
      value: 'something',
      namespace: 'knowledge',
      tags: ['decision', 'architecture'],
    });

    const tags = bridgeCalls[0].tags as string[];
    expect(tags).toEqual(expect.arrayContaining(['decision', 'architecture', 'source:user', 'locked']));
  });

  it('does NOT redirect non-knowledge namespaces', async () => {
    const { storeEntry } = await import('../../memory/memory-initializer.js');

    await storeEntry({
      key: 'p:singleton',
      value: 'singleton pattern',
      namespace: 'patterns',
    });

    expect(bridgeCalls[0].namespace).toBe('patterns');
    const tags = (bridgeCalls[0].tags as string[]) || [];
    expect(tags).not.toContain('locked');
  });

  it('does NOT add locked tag to direct learnings writes', async () => {
    const { storeEntry } = await import('../../memory/memory-initializer.js');

    await storeEntry({
      key: 'l:auto-distilled',
      value: 'auto-distilled insight',
      namespace: 'learnings',
      tags: ['insight', 'source:claude'],
    });

    expect(bridgeCalls[0].namespace).toBe('learnings');
    const tags = bridgeCalls[0].tags as string[];
    expect(tags).not.toContain('locked');
    expect(tags).not.toContain('source:user');
  });
});
