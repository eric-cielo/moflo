/**
 * Write-time learnings provenance (#1203).
 *
 * Verifies storeEntry stamps a default `source:manual` tag on learnings
 * writes that lack any `source:*` tag, preserves an explicit source tag, and
 * never touches non-learnings namespaces. Mirrors knowledge-alias.test.ts —
 * the bridge path is mocked to capture post-normalization options without
 * touching real sql.js or the filesystem.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../../memory/memory-bridge.js', () => ({
  bridgeStoreEntry: async (options: Record<string, unknown>) => {
    bridgeCalls.push(options);
    return { success: true, id: 'mock-id' };
  },
  getControllerRegistry: () => null,
}));

describe('storeEntry: learnings source provenance', () => {
  beforeEach(() => {
    bridgeCalls.length = 0;
  });

  it('stamps source:manual on a learnings write with no source tag', async () => {
    const { storeEntry } = await import('../../memory/memory-initializer.js');
    await storeEntry({ key: 'l:bare', value: 'a lesson', namespace: 'learnings' });
    const tags = (bridgeCalls[0].tags as string[]) || [];
    expect(tags).toContain('source:manual');
  });

  it('appends source:manual alongside caller tags lacking a source', async () => {
    const { storeEntry } = await import('../../memory/memory-initializer.js');
    await storeEntry({ key: 'l:tagged', value: 'a lesson', namespace: 'learnings', tags: ['topic'] });
    const tags = bridgeCalls[0].tags as string[];
    expect(tags).toEqual(expect.arrayContaining(['topic', 'source:manual']));
  });

  it('preserves an explicit source tag and does NOT add source:manual', async () => {
    const { storeEntry } = await import('../../memory/memory-initializer.js');
    await storeEntry({
      key: 'l:auto',
      value: 'a distilled lesson',
      namespace: 'learnings',
      tags: ['topic', 'source:auto-meditate'],
    });
    const tags = bridgeCalls[0].tags as string[];
    expect(tags).toContain('source:auto-meditate');
    expect(tags).not.toContain('source:manual');
  });

  it('honors a /meditate-supplied source tag', async () => {
    const { storeEntry } = await import('../../memory/memory-initializer.js');
    await storeEntry({
      key: 'l:med',
      value: 'a curated lesson',
      namespace: 'learnings',
      tags: ['source:meditate-manual'],
    });
    const tags = bridgeCalls[0].tags as string[];
    expect(tags).toContain('source:meditate-manual');
    expect(tags).not.toContain('source:manual');
  });

  it('keeps the knowledge redirect on source:user (no source:manual override)', async () => {
    const { storeEntry } = await import('../../memory/memory-initializer.js');
    await storeEntry({ key: 'k:remember', value: 'remember this', namespace: 'knowledge' });
    expect(bridgeCalls[0].namespace).toBe('learnings');
    const tags = bridgeCalls[0].tags as string[];
    expect(tags).toContain('source:user');
    expect(tags).not.toContain('source:manual');
  });

  it('does NOT stamp source:manual on non-learnings namespaces', async () => {
    const { storeEntry } = await import('../../memory/memory-initializer.js');
    await storeEntry({ key: 'p:x', value: 'a pattern', namespace: 'patterns' });
    const tags = (bridgeCalls[0].tags as string[]) || [];
    expect(tags).not.toContain('source:manual');
  });
});
