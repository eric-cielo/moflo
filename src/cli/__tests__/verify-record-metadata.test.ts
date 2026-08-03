/**
 * Regression tests for #1328 — `/verify` computed a structured per-criterion
 * verdict and then flattened it to prose when storing, so nothing downstream
 * could filter for failures or join a verdict to a commit.
 *
 * The fix stores the Step 4 table in the `metadata` column (prose stays in
 * `value`, which is the embedded text). That only helps if metadata survives
 * the read: before this change `shapeRetrievedEntry` passed metadata through
 * `parseNavigation` alone, which hard-returns null unless `type === 'chunk'`,
 * so metadata was **write-only** for every non-chunk entry. These tests pin
 * both halves — the surfacing, and the chunk path it must not disturb.
 *
 * Cross-platform (Rule #1): entirely in-memory. The backend is mocked, so
 * there is no filesystem, no temp dir, no shelling out, and nothing that
 * behaves differently on Linux, macOS, or Windows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import type { MCPTool } from '../mcp-tools/types.js';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

/** The record shape Step 5 of the verify skill now writes. */
const verifyRecord = {
  type: 'verify-record',
  issue: '1328',
  commit: 'abc1234',
  overall: 'FAIL',
  verifiedAt: '2026-08-03T22:00:00Z',
  criteria: [
    {
      id: 1,
      statement: 'structured record persists',
      verdict: 'PASS',
      evidence: 'verify-record-metadata.test.ts',
      freshlyExecuted: true,
    },
    {
      id: 2,
      statement: 'cited evidence is distinguishable from fresh',
      verdict: 'FAIL',
      evidence: 'cited from an earlier run this session',
      freshlyExecuted: false,
    },
  ],
};

const chunkMetadata = JSON.stringify({
  type: 'chunk',
  parentDoc: 'doc-guidance-foo',
  parentPath: '.claude/guidance/foo.md',
  chunkIndex: 1,
  totalChunks: 3,
  prevChunk: null,
  nextChunk: 'chunk-guidance-foo-2',
  chunkTitle: 'Section One',
  headerLevel: 2,
});

const entries: Record<string, { content: string; metadata?: string }> = {
  'verify:1328': { content: 'FAIL — 1 of 2 criteria unproven; commit abc1234', metadata: JSON.stringify(verifyRecord) },
  'chunk-guidance-foo-1': { content: 'chunk body', metadata: chunkMetadata },
  'plain-note': { content: 'just prose', metadata: undefined },
  'empty-meta': { content: 'prose', metadata: '{}' },
  'broken-meta': { content: 'prose', metadata: '{ not valid json' },
  'array-meta': { content: 'prose', metadata: '["a","b"]' },
};

const getEntrySpy = vi.fn(async (opts: { key: string }) => {
  const hit = entries[opts.key];
  if (!hit) return { success: true, found: false };
  return {
    success: true,
    found: true,
    entry: {
      id: `id-${opts.key}`,
      key: opts.key,
      namespace: 'learnings',
      content: hit.content,
      accessCount: 0,
      createdAt: '2026-08-03',
      updatedAt: '2026-08-03',
      hasEmbedding: true,
      tags: ['verify', 'sdd'],
      metadata: hit.metadata,
    },
  };
});

vi.mock('../memory/memory-initializer.js', () => ({
  storeEntry: vi.fn(),
  searchEntries: vi.fn(async () => ({ success: true, results: [], searchTime: 0 })),
  listEntries: vi.fn(),
  getEntry: getEntrySpy,
  deleteEntry: vi.fn(),
  initializeMemoryDatabase: vi.fn(async () => ({ success: true, dbPath: '' })),
  checkMemoryInitialization: vi.fn(async () => ({ initialized: true, dbPath: '', tableExists: true, version: '3.0.0' })),
}));

vi.mock('../services/spell-gate.js', () => ({
  GateService: class { recordMemorySearched(): void { /* no-op */ } notifyMemoryGate(): void { /* no-op */ } },
}));

beforeEach(() => { getEntrySpy.mockClear(); });
afterEach(() => { vi.restoreAllMocks(); });

async function retrieve(key: string): Promise<Record<string, unknown>> {
  const mod = await import('../mcp-tools/memory-tools.js');
  const tool = (mod.memoryTools as MCPTool[]).find(t => t.name === 'memory_retrieve');
  if (!tool) throw new Error('memory_retrieve not registered');
  return await tool.handler({ key, namespace: 'learnings' }) as Record<string, unknown>;
}

describe('#1328 a structured verify record survives the round trip', () => {
  it('memory_retrieve surfaces the parsed per-criterion record', async () => {
    const result = await retrieve('verify:1328');
    expect(result.found).toBe(true);
    expect(result.metadata).toEqual(verifyRecord);
  });

  it('a FAIL verdict is readable as structure, not prose', async () => {
    // The whole point of #1328: downstream can filter for failures without
    // parsing free text an agent composed.
    const meta = (await retrieve('verify:1328')).metadata as typeof verifyRecord;
    expect(meta.overall).toBe('FAIL');

    const failed = meta.criteria.filter(c => c.verdict !== 'PASS');
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe(2);
  });

  it('distinguishes freshly-executed evidence from cited evidence', async () => {
    const meta = (await retrieve('verify:1328')).metadata as typeof verifyRecord;
    expect(meta.criteria.map(c => c.freshlyExecuted)).toEqual([true, false]);
  });

  it('joins the verdict to a commit', async () => {
    const meta = (await retrieve('verify:1328')).metadata as typeof verifyRecord;
    expect(meta.commit).toBe('abc1234');
  });

  it('keeps the human-readable summary in value — additive, not a replacement', async () => {
    const result = await retrieve('verify:1328');
    expect(result.value).toBe('FAIL — 1 of 2 criteria unproven; commit abc1234');
  });

  it('records no exit code — the runtime cannot supply one (#1322)', async () => {
    const meta = (await retrieve('verify:1328')).metadata as Record<string, unknown>;
    expect(JSON.stringify(meta)).not.toMatch(/exitCode/i);
  });
});

describe('#1328 metadata surfacing does not disturb the chunk path', () => {
  it('chunk entries still get navigation and are NOT double-billed via metadata', async () => {
    const result = await retrieve('chunk-guidance-foo-1');
    expect(result.navigation).toMatchObject({
      parentDoc: 'doc-guidance-foo',
      nextChunk: 'chunk-guidance-foo-2',
      chunkTitle: 'Section One',
    });
    // Chunk metadata is ~4x the size of non-chunk metadata; navigation already
    // projects it, so echoing it raw would inflate every traversal hop.
    expect(result.metadata).toBeNull();
  });

  it('non-chunk entries get metadata and a null navigation', async () => {
    const result = await retrieve('verify:1328');
    expect(result.navigation).toBeNull();
    expect(result.metadata).not.toBeNull();
  });
});

describe('#1328 metadata parsing is total (never throws)', () => {
  it.each([
    ['absent metadata', 'plain-note'],
    ['an empty object', 'empty-meta'],
    ['malformed JSON', 'broken-meta'],
    ['a JSON array rather than an object', 'array-meta'],
  ])('returns null for %s rather than throwing', async (_label, key) => {
    const result = await retrieve(key);
    expect(result.found).toBe(true);
    expect(result.metadata).toBeNull();
  });
});

describe('#1328 the verify skill instructs the structured store', () => {
  // The skill text IS the implementation here — an agent reads it and acts.
  // If Step 5 reverts to a prose-only store, the record silently stops being
  // written and every test above keeps passing against its own fixture.
  const skill = readFileSync(
    path.join(repoRoot, '.claude', 'skills', 'verify', 'SKILL.md'),
    'utf-8',
  );

  it('Step 5 passes a metadata block to memory_store', () => {
    expect(skill).toMatch(/metadata:\s*\{/);
    expect(skill).toMatch(/type:\s*["']verify-record["']/);
  });

  it('specifies overall plus a per-criterion array', () => {
    expect(skill).toMatch(/overall:/);
    expect(skill).toMatch(/criteria:\s*\[/);
    expect(skill).toMatch(/verdict:/);
  });

  it('requires freshlyExecuted so cited evidence stays distinguishable', () => {
    expect(skill).toMatch(/freshlyExecuted/);
    expect(skill).toMatch(/required on every criterion/i);
  });

  it('retains the prose value alongside the structured record', () => {
    expect(skill).toMatch(/value:\s*["']<overall PASS\/FAIL>/);
  });

  it('forbids recording an exit code', () => {
    expect(skill).toMatch(/[Nn]ever record an exit code/);
  });
});
