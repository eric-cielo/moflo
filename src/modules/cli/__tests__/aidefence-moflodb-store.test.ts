/**
 * Tests for MofloDbAIDefenceStore.
 *
 * Exercises the adapter's shape-transformation logic against a mocked
 * memory-bridge so that coverage does not depend on @moflo/memory being
 * installed in the dev environment.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type StoredRow = { namespace: string; key: string; content: string };

const stored: StoredRow[] = [];

vi.mock('../src/memory/memory-bridge.js', () => ({
  isBridgeAvailable: vi.fn(async () => true),
  bridgeStoreEntry: vi.fn(async (opts: { namespace: string; key: string; value: string; upsert?: boolean }) => {
    const existingIdx = stored.findIndex(r => r.namespace === opts.namespace && r.key === opts.key);
    if (existingIdx >= 0 && opts.upsert) {
      stored[existingIdx] = { namespace: opts.namespace, key: opts.key, content: opts.value };
    } else if (existingIdx < 0) {
      stored.push({ namespace: opts.namespace, key: opts.key, content: opts.value });
    }
    return { success: true, id: opts.key };
  }),
  bridgeSearchEntries: vi.fn(async (opts: { namespace: string; query: string; limit?: number }) => {
    const results = stored
      .filter(r => r.namespace === opts.namespace)
      .map(r => ({
        id: r.key,
        key: r.key,
        content: r.content,
        score: r.content.toLowerCase().includes(opts.query.toLowerCase()) ? 0.9 : 0.3,
        namespace: r.namespace,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 10);
    return { success: true, results, searchTime: 1 };
  }),
  bridgeGetEntry: vi.fn(async (opts: { namespace: string; key: string }) => {
    const row = stored.find(r => r.namespace === opts.namespace && r.key === opts.key);
    if (!row) return { success: true, found: false };
    return {
      success: true,
      found: true,
      entry: {
        id: row.key,
        key: row.key,
        namespace: row.namespace,
        content: row.content,
        accessCount: 0,
        createdAt: '',
        updatedAt: '',
        hasEmbedding: false,
        tags: [],
      },
    };
  }),
  bridgeDeleteEntry: vi.fn(async (opts: { namespace: string; key: string }) => {
    const idx = stored.findIndex(r => r.namespace === opts.namespace && r.key === opts.key);
    if (idx >= 0) stored.splice(idx, 1);
    return { success: true, deleted: idx >= 0, key: opts.key, namespace: opts.namespace, remainingEntries: stored.length };
  }),
  shutdownBridge: vi.fn(async () => {}),
}));

const { MofloDbAIDefenceStore, tryCreateMofloDbStore } = await import(
  '../src/mcp-tools/aidefence-moflodb-store.js'
);

describe('MofloDbAIDefenceStore', () => {
  beforeEach(() => {
    stored.length = 0;
  });

  it('tryCreateMofloDbStore returns an instance when bridge is available', async () => {
    const store = await tryCreateMofloDbStore();
    expect(store).toBeInstanceOf(MofloDbAIDefenceStore);
  });

  it('prefixes namespaces with "aidefence:" to isolate from general memory', async () => {
    const store = new MofloDbAIDefenceStore();
    await store.store({
      namespace: 'security_threats',
      key: 'k1',
      value: { hello: 'world' },
    });
    expect(stored[0]!.namespace).toBe('aidefence:security_threats');
  });

  it('round-trips an arbitrary object via JSON serialization', async () => {
    const store = new MofloDbAIDefenceStore();
    const value = {
      id: 'learned-prompt_injection-abc',
      pattern: 'Ignore all previous instructions',
      effectiveness: 0.9,
      metadata: { source: 'learned', contextPatterns: ['code_block'] },
    };

    await store.store({ namespace: 'security_threats', key: value.id, value });
    const retrieved = (await store.get('security_threats', value.id)) as typeof value;

    expect(retrieved).toEqual(value);
  });

  it('upserts the same key instead of duplicating', async () => {
    const store = new MofloDbAIDefenceStore();
    const key = 'mitigation-prompt_injection-block';

    await store.store({ namespace: 'security_mitigations', key, value: { effectiveness: 0.5 } });
    await store.store({ namespace: 'security_mitigations', key, value: { effectiveness: 0.8 } });

    expect(stored.filter(r => r.key === key)).toHaveLength(1);
    const retrieved = (await store.get('security_mitigations', key)) as { effectiveness: number };
    expect(retrieved.effectiveness).toBe(0.8);
  });

  it('delete removes stored entries', async () => {
    const store = new MofloDbAIDefenceStore();
    await store.store({ namespace: 'security_threats', key: 'delete-me', value: { x: 1 } });

    await store.delete('security_threats', 'delete-me');

    expect(await store.get('security_threats', 'delete-me')).toBeNull();
  });

  it('search returns entries with similarity scores and k limit', async () => {
    const store = new MofloDbAIDefenceStore();
    await store.store({ namespace: 'security_threats', key: 'a', value: { pattern: 'prompt injection' } });
    await store.store({ namespace: 'security_threats', key: 'b', value: { pattern: 'jailbreak attempt' } });
    await store.store({ namespace: 'security_threats', key: 'c', value: { pattern: 'benign text' } });

    const results = await store.search({
      namespace: 'security_threats',
      query: 'prompt',
      k: 2,
    });

    expect(results.length).toBeLessThanOrEqual(2);
    expect(results[0]!.value).toEqual({ pattern: 'prompt injection' });
    expect(results[0]!.similarity).toBeGreaterThan(0);
  });
});

describe('tryCreateMofloDbStore falls back when bridge is unavailable', () => {
  it('returns null when isBridgeAvailable reports false', async () => {
    const bridgeModule = await import('../src/memory/memory-bridge.js');
    vi.mocked(bridgeModule.isBridgeAvailable).mockResolvedValueOnce(false);

    const store = await tryCreateMofloDbStore();
    expect(store).toBeNull();
  });
});
