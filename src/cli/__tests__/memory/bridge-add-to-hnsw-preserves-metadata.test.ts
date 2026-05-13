/**
 * #1067 regression — bridgeAddToHNSW must NOT clobber the row's metadata.
 *
 * Pre-#1067 the function used `INSERT OR REPLACE INTO memory_entries (...)` with
 * only the embedding-related columns, which silently reset every other column
 * (metadata, tags, expires_at, access_count) to NULL/default. When
 * `storeEntry`'s direct-write fallback ran for the first row in a fresh DB —
 * inserting metadata first, then calling `addToHNSWIndex` which routes to
 * `bridgeAddToHNSW` — the REPLACE wiped the JSON the writer had just persisted.
 * Chunk-traversal smoke saw "neighbors without navigation" for the first chunk
 * only; subsequent chunks were unaffected because they hit a different routing
 * path that didn't call `bridgeAddToHNSW`.
 *
 * Post-#1067 `bridgeAddToHNSW` UPDATEs the embedding columns by id and only
 * falls back to INSERT when the row genuinely doesn't exist yet.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import {
  _resetProjectRootForTest,
  shutdownBridge,
} from '../../memory/bridge-core.js';
import { bridgeStoreEntry, bridgeAddToHNSW } from '../../memory/memory-bridge.js';

describe('bridgeAddToHNSW metadata preservation (#1067)', () => {
  let tempDir: string;
  let projectRoot: string;
  let dbPath: string;
  let originalCwd: string;
  let originalProjectDir: string | undefined;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(tmpdir(), 'moflo-1067-hnsw-'));
    projectRoot = tempDir;
    fs.mkdirSync(path.join(projectRoot, '.moflo'), { recursive: true });
    dbPath = path.join(projectRoot, '.moflo', 'moflo.db');

    originalCwd = process.cwd();
    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = projectRoot;
    process.env.MOFLO_DISABLE_DAEMON_ROUTING = '1';

    await shutdownBridge();
    _resetProjectRootForTest();
  });

  afterEach(async () => {
    await shutdownBridge();
    _resetProjectRootForTest();
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    delete process.env.MOFLO_DISABLE_DAEMON_ROUTING;
    try { process.chdir(originalCwd); } catch { /* ignore */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('preserves metadata when called for a row that already exists', async () => {
    const chunkMetadata = {
      type: 'chunk',
      parentDoc: 'doc-foo',
      parentPath: '/foo.md',
      chunkIndex: 0,
      totalChunks: 3,
      prevChunk: null,
      nextChunk: 'chunk-foo-1',
      siblings: ['chunk-foo-0', 'chunk-foo-1', 'chunk-foo-2'],
      hierarchicalParent: null,
      hierarchicalChildren: null,
      chunkTitle: 'Chunk 0',
      headerLevel: 2,
    };

    // Phase 1: bridge persists a row carrying chunk metadata — mirrors what
    // a memory_store call with metadata does.
    const storeResult = await bridgeStoreEntry({
      key: 'chunk-foo-0',
      value: 'chunk body 0',
      namespace: 'ns-1067',
      tags: [],
      metadata: chunkMetadata,
      upsert: true,
    });
    expect(storeResult).not.toBeNull();
    expect(storeResult?.success).toBe(true);

    const rowId = storeResult!.id;

    // Phase 2: addToHNSWIndex routes here for the same id when the
    // direct-write fallback runs (the #1067 trigger).
    const hnswResult = await bridgeAddToHNSW(
      rowId,
      Array.from({ length: 8 }, (_, i) => i / 10),
      { id: rowId, key: 'chunk-foo-0', namespace: 'ns-1067', content: 'chunk body 0' },
    );
    expect(hnswResult).toBe(true);

    // Phase 3: assert the row's metadata column still carries the chunk JSON.
    // Direct sql probe bypasses the bridge cache so we read what's actually
    // on disk.
    const probeDb = new DatabaseSync(dbPath);
    try {
      const row = probeDb.prepare(
        'SELECT metadata FROM memory_entries WHERE id = ?',
      ).get(rowId) as { metadata: string | null } | undefined;

      expect(row).toBeDefined();
      expect(row?.metadata).toBeTruthy();
      const parsed = JSON.parse(row!.metadata!);
      expect(parsed.type).toBe('chunk');
      expect(parsed.parentDoc).toBe('doc-foo');
      expect(parsed.nextChunk).toBe('chunk-foo-1');
      expect(parsed.siblings).toEqual(['chunk-foo-0', 'chunk-foo-1', 'chunk-foo-2']);
    } finally {
      probeDb.close();
    }
  });

  it('preserves tags when called for a row that already exists', async () => {
    // Same shape as the metadata case — make sure the UPDATE-by-id fix
    // didn't fall back to a column-stripping path for any neighboring column.
    const storeResult = await bridgeStoreEntry({
      key: 'tagged-row',
      value: 'tagged content',
      namespace: 'ns-1067',
      tags: ['alpha', 'beta'],
      upsert: true,
    });
    expect(storeResult?.success).toBe(true);
    const rowId = storeResult!.id;

    await bridgeAddToHNSW(
      rowId,
      [0.1, 0.2, 0.3],
      { id: rowId, key: 'tagged-row', namespace: 'ns-1067', content: 'tagged content' },
    );

    const probeDb = new DatabaseSync(dbPath);
    try {
      const row = probeDb.prepare(
        'SELECT tags FROM memory_entries WHERE id = ?',
      ).get(rowId) as { tags: string | null } | undefined;
      const parsed = row?.tags ? JSON.parse(row.tags) : null;
      expect(parsed).toEqual(['alpha', 'beta']);
    } finally {
      probeDb.close();
    }
  });

  it('back-fills via INSERT when no row exists for the id (rebuild path)', async () => {
    // This is the "first time we see this id" fallback the function still
    // needs to support — e.g. an HNSW rebuilder feeding rows that never went
    // through storeEntry. The result is a row without metadata (caller
    // didn't supply it), but the row exists and is searchable.
    const orphanId = `entry_orphan_${Date.now()}`;
    const result = await bridgeAddToHNSW(
      orphanId,
      [0.5, 0.5, 0.5],
      { id: orphanId, key: 'orphan-row', namespace: 'ns-1067', content: 'rebuilt' },
    );
    expect(result).toBe(true);

    const probeDb = new DatabaseSync(dbPath);
    try {
      const row = probeDb.prepare(
        'SELECT key, namespace, content, metadata FROM memory_entries WHERE id = ?',
      ).get(orphanId) as { key: string; namespace: string; content: string; metadata: string | null } | undefined;
      expect(row?.key).toBe('orphan-row');
      expect(row?.namespace).toBe('ns-1067');
      expect(row?.content).toBe('rebuilt');
      // metadata wasn't supplied to bridgeAddToHNSW — column is NULL, NOT
      // the literal string "null" (the pre-fix bug fingerprint).
      expect(row?.metadata).toBeNull();
    } finally {
      probeDb.close();
    }
  });
});
