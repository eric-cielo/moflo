/**
 * HNSW status is reported for the index that serves the search (#1387).
 *
 * `getHNSWStatus()` reports the calling process's singleton. That was a fair
 * proxy until #1058 routed reads through the daemon's RPC — after which
 * `searchEntries` returns before ever touching `searchHNSWIndex`, so the MCP
 * server and CLI never build a local index, and `flo status memory` told
 * healthy installs their index did not exist. The report inverted with health:
 * it only read "Active" in a process that had *failed* to reach the daemon.
 *
 * These tests pin the daemon-routed case specifically (no local singleton,
 * sidecar on disk), the honest negative (no sidecar at all — the fix must not
 * be unconditionally optimistic), and the "present but uncountable" case that
 * must not collapse to zero.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { buildAndWriteHnswSidecar, hnswManifestPath, readHnswSidecarStatus } from '../../memory/hnsw-persistence.js';
import { clearHNSWIndex, getEffectiveHNSWStatus, getHNSWStatus } from '../../memory/hnsw-singleton.js';
import { hnswIndexPath, MOFLO_DIR, MEMORY_DB_FILE } from '../../services/moflo-paths.js';
import { openDaemonDatabase } from '../../memory/daemon-backend.js';
import { hnswIndexLabel } from '../../commands/status.js';

const DIM = 8;
const ROW_COUNT = 7;

function vectorFor(seed: number): number[] {
  return Array.from({ length: DIM }, (_, j) => Number(Math.sin(seed * 0.7 + j * 0.3).toFixed(6)));
}

function seedDb(dbPath: string): void {
  const db = openDaemonDatabase(dbPath);
  try {
    db.run(`CREATE TABLE memory_entries (
      id TEXT PRIMARY KEY,
      key TEXT,
      namespace TEXT,
      content TEXT,
      embedding TEXT,
      updated_at INTEGER,
      status TEXT
    )`);
    for (let i = 0; i < ROW_COUNT; i++) {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, embedding, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`,
        [`row-${i}`, `key-${i}`, 'patterns', `content ${i}`, JSON.stringify(vectorFor(i)), 1_700_000_000_000],
      );
    }
  } finally {
    db.close();
  }
}

describe('HNSW status reporting (#1387)', () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-1387-'));
    fs.mkdirSync(path.join(tmp, MOFLO_DIR));
    dbPath = path.join(tmp, MOFLO_DIR, MEMORY_DB_FILE);
    seedDb(dbPath);
    // Every assertion below is about a process that has NOT built a local
    // index — which is every non-daemon process since #1058.
    clearHNSWIndex();
  });

  afterEach(() => {
    clearHNSWIndex();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('readHnswSidecarStatus', () => {
    it('reports the sidecar absent, with a count of zero, when none was written', () => {
      expect(readHnswSidecarStatus(tmp)).toEqual({ present: false, vectorCount: 0, dimensions: null });
    });

    it('counts vectors from the header, not by deserializing the graph', async () => {
      await buildAndWriteHnswSidecar(dbPath, tmp, { dimensions: DIM });

      expect(readHnswSidecarStatus(tmp)).toEqual({
        present: true,
        vectorCount: ROW_COUNT,
        dimensions: DIM,
      });
    });

    it('counts a sidecar that has no manifest beside it', async () => {
      await buildAndWriteHnswSidecar(dbPath, tmp, { dimensions: DIM });
      // A pre-#1384 sidecar, or the losing half of a torn write. The count
      // lives in the graph's own header, so it survives losing the manifest.
      fs.rmSync(hnswManifestPath(tmp));

      expect(readHnswSidecarStatus(tmp)).toEqual({
        present: true,
        vectorCount: ROW_COUNT,
        dimensions: DIM,
      });
    });

    it('reports an unknown count — not zero — when the header is unreadable', async () => {
      await buildAndWriteHnswSidecar(dbPath, tmp, { dimensions: DIM });
      fs.writeFileSync(hnswIndexPath(tmp), Buffer.from('not an hnsw sidecar'));

      const status = readHnswSidecarStatus(tmp);

      expect(status.present).toBe(true);
      expect(status.vectorCount).toBeNull();
    });

    it('treats a directory at the sidecar path as absent on every platform', () => {
      // POSIX opens a directory read-only and fails at the first read; Windows
      // refuses the open. Both must land on the same answer.
      fs.mkdirSync(hnswIndexPath(tmp));

      expect(readHnswSidecarStatus(tmp)).toEqual({ present: false, vectorCount: 0, dimensions: null });
    });
  });

  describe('getEffectiveHNSWStatus — the daemon-routed case', () => {
    it('reports the on-disk sidecar when this process built no index of its own', async () => {
      await buildAndWriteHnswSidecar(dbPath, tmp, { dimensions: DIM });

      // The state the bug reported as "not built": nothing local at all.
      expect(getHNSWStatus().entryCount).toBe(0);

      const status = getEffectiveHNSWStatus(tmp);

      expect(status.available).toBe(true);
      expect(status.initialized).toBe(true);
      expect(status.entryCount).toBe(ROW_COUNT);
      expect(status.dimensions).toBe(DIM);
      expect(status.source).toBe('sidecar');
    });

    it('still reports not-built when there is genuinely no sidecar', () => {
      const status = getEffectiveHNSWStatus(tmp);

      expect(status.available).toBe(false);
      expect(status.initialized).toBe(false);
      expect(status.entryCount).toBe(0);
      expect(status.source).toBe('none');
    });

    it('carries the unknown count through rather than reporting an empty index', async () => {
      await buildAndWriteHnswSidecar(dbPath, tmp, { dimensions: DIM });
      fs.writeFileSync(hnswIndexPath(tmp), Buffer.from('not an hnsw sidecar'));

      const status = getEffectiveHNSWStatus(tmp);

      expect(status.available).toBe(true);
      expect(status.entryCount).toBeNull();
      expect(status.source).toBe('sidecar');
    });
  });

  describe('hnswIndexLabel — what `flo status memory` prints', () => {
    it('names the sidecar so a routed answer is not mistaken for a local build', () => {
      expect(hnswIndexLabel({ hnswEnabled: true, hnswSource: 'sidecar' }))
        .toBe('Active (on-disk sidecar)');
    });

    it('says Active plainly when this process holds the index', () => {
      expect(hnswIndexLabel({ hnswEnabled: true, hnswSource: 'process' })).toBe('Active');
    });

    it('keeps the scan-fallback warning for a genuinely missing index', () => {
      expect(hnswIndexLabel({ hnswEnabled: false, hnswSource: 'none' }))
        .toBe('Not built (search falls back to scan)');
    });

    it('falls back to plain Active for a moflo predating the source field', () => {
      expect(hnswIndexLabel({ hnswEnabled: true })).toBe('Active');
    });
  });
});
