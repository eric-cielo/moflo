/**
 * Bridge cross-process coherence tests (story #1058 / epic #1054).
 *
 * History:
 *   Pre-Phase-4 (#1083) the bridge held an in-memory sql.js snapshot per
 *   process and never re-read disk after init. The mtime-coherence guard in
 *   `bridge-core.ts:withDb` stat-ed the file before every op and tore down
 *   the bridge when another process bumped mtime.
 *
 *   Phase 4 flipped the daemon's engine to node:sqlite + WAL. Two node:sqlite
 *   connections on the same WAL DB are coherent by construction — the WAL
 *   sidecar carries pending writes, and every reader's queries see committed
 *   writes from every other writer immediately. The mtime guard is kept as
 *   a belt-and-braces fallback (no harm under WAL) but the load-bearing
 *   property is now WAL coherence itself.
 *
 *   These tests pin the user-observable invariant: an external writer's
 *   committed rows show up in the next bridge read. They no longer assert
 *   the specific mtime-cursor advance — that's an implementation detail and
 *   WAL writes don't always touch the main file's mtime (the sidecar is the
 *   carrier between checkpoints).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import {
  _resetProjectRootForTest,
  _getBridgeCoherenceCursorForTest,
  shutdownBridge,
} from '../../memory/bridge-core.js';
import {
  storeEntry,
  getEntry,
} from '../../memory/memory-initializer.js';

describe('bridge cross-process coherence (#1058 / Phase 4)', () => {
  let tempDir: string;
  let projectRoot: string;
  let dbPath: string;
  let originalCwd: string;
  let originalProjectDir: string | undefined;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(tmpdir(), 'moflo-1058-coh-'));
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

  it('anchors the coherence cursor after the first bridge op', async () => {
    expect(_getBridgeCoherenceCursorForTest()).toBeNull();
    const r = await storeEntry({ key: 'k1', value: 'v1', namespace: 'ns' });
    expect(r.success).toBe(true);
    expect(_getBridgeCoherenceCursorForTest()).not.toBeNull();
  });

  it('own persist leaves the bridge loaded (no self-invalidation)', async () => {
    await storeEntry({ key: 'k1', value: 'v1', namespace: 'ns' });
    const after1 = _getBridgeCoherenceCursorForTest();
    expect(after1).not.toBeNull();

    // Force a real mtime delta on the main file (Windows = 1s).
    await new Promise(r => setTimeout(r, 1100));

    await storeEntry({ key: 'k2', value: 'v2', namespace: 'ns' });

    // Both rows still retrievable from the same bridge — own writes never
    // cause the bridge to drop its handle.
    const g1 = await getEntry({ key: 'k1', namespace: 'ns' });
    const g2 = await getEntry({ key: 'k2', namespace: 'ns' });
    expect(g1.found).toBe(true);
    expect(g2.found).toBe(true);
  });

  it('an external node:sqlite writer\'s row is visible to the bridge', async () => {
    // Phase 1: bridge writes a row so the DB + WAL exist.
    await storeEntry({ key: 'first', value: 'first-value', namespace: 'ns' });

    // Phase 2: simulate another process writing the SAME dbPath via
    // node:sqlite + WAL — the supported cross-process pattern under Phase 4.
    // Sql.js + writeFileSync would clobber the WAL sidecar (the catastrophic
    // case the migration explicitly kills); we no longer test that path.
    const otherDb = new DatabaseSync(dbPath);
    try {
      otherDb.exec('PRAGMA journal_mode = WAL');
      otherDb.exec('PRAGMA synchronous = NORMAL');
      const otherId = `entry_other_${Date.now()}`;
      const insert = otherDb.prepare(
        `INSERT INTO memory_entries (id, key, namespace, content, type, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'semantic', 'active', ?, ?)`,
      );
      insert.run(otherId, 'injected-by-other-writer', 'ns', 'remote-value', Date.now(), Date.now());
    } finally {
      otherDb.close();
    }

    // Phase 3: the bridge's next read sees the externally-injected row.
    // Under WAL this works through SQLite's built-in cross-connection
    // coherence, not the mtime guard — the cursor may or may not advance
    // depending on whether SQLite checkpointed back to the main file.
    const result = await getEntry({ key: 'injected-by-other-writer', namespace: 'ns' });
    expect(result.success).toBe(true);
    expect(result.found).toBe(true);
    expect(result.entry?.content).toBe('remote-value');
  });

  it('search reflects external writes from another node:sqlite connection', async () => {
    await storeEntry({ key: 'in-process', value: 'in-process-content', namespace: 'ns' });

    const otherDb = new DatabaseSync(dbPath);
    try {
      otherDb.exec('PRAGMA journal_mode = WAL');
      otherDb.exec('PRAGMA synchronous = NORMAL');
      const insert = otherDb.prepare(
        `INSERT INTO memory_entries (id, key, namespace, content, type, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'semantic', 'active', ?, ?)`,
      );
      insert.run(
        `entry_search_${Date.now()}`,
        'external-key',
        'ns',
        'external-content',
        Date.now(),
        Date.now(),
      );
    } finally {
      otherDb.close();
    }

    const result = await getEntry({ key: 'external-key', namespace: 'ns' });
    expect(result.found).toBe(true);
    expect(result.entry?.content).toBe('external-content');
  });

  it('does NOT invalidate the bridge when nothing changed on disk', async () => {
    await storeEntry({ key: 'k1', value: 'v1', namespace: 'ns' });
    const cursor1 = _getBridgeCoherenceCursorForTest();
    expect(cursor1).not.toBeNull();

    // Read without any disk mutation between writes.
    await getEntry({ key: 'k1', namespace: 'ns' });
    const cursor2 = _getBridgeCoherenceCursorForTest();

    // No external write → no reload → cursor stays put.
    expect(cursor2).toBe(cursor1);
  });

  // #1073 regression gate. Pre-fix, the daemon was exempted from the coherence
  // guard under "daemon is sole writer", but `bin/index-guidance.mjs` and the
  // consumer-smoke memory-protocol probe write directly to disk while the
  // daemon is up. Under Phase 4, the indexer's node:sqlite writes are visible
  // to the daemon via WAL — but pinning the daemon through the same coherence
  // surface as everyone else keeps the failure-mode bounded if WAL ever falls
  // back (e.g. network FS where WAL is disabled).
  it('daemon process (MOFLO_IS_DAEMON=1) sees external writes', async () => {
    const originalIsDaemon = process.env.MOFLO_IS_DAEMON;
    process.env.MOFLO_IS_DAEMON = '1';
    try {
      await storeEntry({ key: 'daemon-own', value: 'own-content', namespace: 'ns' });

      const otherDb = new DatabaseSync(dbPath);
      try {
        otherDb.exec('PRAGMA journal_mode = WAL');
        otherDb.exec('PRAGMA synchronous = NORMAL');
        const insert = otherDb.prepare(
          `INSERT INTO memory_entries (id, key, namespace, content, type, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'semantic', 'active', ?, ?)`,
        );
        insert.run(
          `entry_indexer_${Date.now()}`,
          'indexer-written-key',
          'ns',
          'indexer-content',
          Date.now(),
          Date.now(),
        );
      } finally {
        otherDb.close();
      }

      const result = await getEntry({ key: 'indexer-written-key', namespace: 'ns' });
      expect(result.found).toBe(true);
      expect(result.entry?.content).toBe('indexer-content');
    } finally {
      if (originalIsDaemon === undefined) delete process.env.MOFLO_IS_DAEMON;
      else process.env.MOFLO_IS_DAEMON = originalIsDaemon;
    }
  });
});
