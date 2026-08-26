/**
 * `storeEntry` rejects captured tool-call markup before anything is spent (#1467).
 *
 * The chokepoint matters more than the surface here: `flo memory store`, the
 * MCP `memory_store` tool and the daemon's own RPC handler all land in
 * `storeEntry`, so guarding it once covers every write path. What this file
 * proves is that the guard runs FIRST — no embedding is generated and the
 * bridge is never asked to persist — which is the half that makes the ticket's
 * "the check runs before embedding" criterion non-vacuous. A rejected value
 * that still produced a vector would leave the exact artefact the fix exists
 * to prevent.
 *
 * Bridge + embedder are mocked (as in learnings-provenance.test.ts), so this is
 * pure logic on all three platforms — no db, no fs, no model load.
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
  mofloImport: vi.fn().mockRejectedValue(new Error('mocked — the bridge path captures the call first')),
}));

const bridgeCalls: Array<Record<string, unknown>> = [];
const embedCalls: string[] = [];

vi.mock('../../memory/memory-bridge.js', () => ({
  bridgeStoreEntry: async (options: Record<string, unknown>) => {
    bridgeCalls.push(options);
    return { success: true, id: 'mock-id' };
  },
  getControllerRegistry: () => null,
}));

vi.mock('../../memory/embedding-model.js', async () => {
  const actual = await vi.importActual<typeof import('../../memory/embedding-model.js')>(
    '../../memory/embedding-model.js',
  );
  return {
    ...actual,
    generateEmbedding: async (text: string) => {
      embedCalls.push(text);
      return new Float32Array([0.1, 0.2]);
    },
  };
});

/** The exact shape reported in #1467. */
const CORRUPT = 'the actual lesson text.",\n    <parameter name="tags">["a","b","source:manual"]';

async function store(value: string, key = 'k') {
  const { storeEntry } = await import('../../memory/memory-initializer.js');
  return storeEntry({ key, value, namespace: 'learnings', generateEmbeddingFlag: true });
}

describe('storeEntry rejects captured tool-call markup (#1467)', () => {
  beforeEach(() => {
    bridgeCalls.length = 0;
    embedCalls.length = 0;
    delete process.env.MOFLO_ALLOW_TOOL_CALL_MARKUP;
  });

  it('returns success:false instead of the silent success that hid 68 entries', async () => {
    const result = await store(CORRUPT, 'corrupt-lesson');
    expect(result.success).toBe(false);
    expect(result.error).toContain('learnings/corrupt-lesson');
    expect(result.error).toContain('tool-call markup');
  });

  it('never persists the row', async () => {
    await store(CORRUPT);
    expect(bridgeCalls).toHaveLength(0);
  });

  it('never generates a vector for the rejected value', async () => {
    await store(CORRUPT);
    expect(embedCalls).toHaveLength(0);
  });

  it('rejects the </value> shape too', async () => {
    const result = await store('a lesson that got cut off\n</value>');
    expect(result.success).toBe(false);
    expect(bridgeCalls).toHaveLength(0);
  });

  it('stores a clean value normally', async () => {
    const result = await store('A perfectly ordinary lesson about cache invalidation.', 'clean');
    expect(result.success).toBe(true);
    expect(bridgeCalls).toHaveLength(1);
  });

  it('stores a value that discusses the markup without trailing off into it', async () => {
    const lesson = [
      'A memory value can arrive carrying `<parameter name="tags">` or a stray',
      '`</value>` from the harness that wrote it. Reject those at the store, but',
      'anchor the detector to the trailing position — a bare marker match rejects',
      'this very lesson, and a rule that cannot describe itself is not usable.',
    ].join('\n');
    const result = await store(lesson, 'lesson-about-1467');
    expect(result.success).toBe(true);
    expect(bridgeCalls).toHaveLength(1);
  });

  it('MOFLO_ALLOW_TOOL_CALL_MARKUP=1 stores it anyway', async () => {
    // The escape hatch the error message advertises. Without it a consumer with
    // a genuinely fragment-shaped value would have no way through at all.
    process.env.MOFLO_ALLOW_TOOL_CALL_MARKUP = '1';
    const result = await store(CORRUPT, 'forced');
    expect(result.success).toBe(true);
    expect(bridgeCalls).toHaveLength(1);
  });
});
