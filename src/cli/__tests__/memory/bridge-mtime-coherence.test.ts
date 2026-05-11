/**
 * Bridge mtime-coherence tests (story #1058 / epic #1054).
 *
 * The bridge holds an in-memory sql.js snapshot per process and never re-reads
 * disk after init. In a multi-process scenario without the daemon (e.g.
 * `daemon.auto_start: false`) a long-lived MCP server returns stale rows
 * because another writer's persist is invisible to its snapshot. The mtime-
 * coherence guard in `bridge-core.ts:withDb` detects that disk has advanced
 * past our last-known value and tears the bridge down so the next op reloads
 * fresh from disk.
 *
 * These tests exercise the guard end-to-end through the bridge surface.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  _resetProjectRootForTest,
  _getBridgeCoherenceCursorForTest,
  shutdownBridge,
} from '../../memory/bridge-core.js';
import {
  storeEntry,
  getEntry,
} from '../../memory/memory-initializer.js';

describe('bridge mtime-coherence (#1058)', () => {
  let tempDir: string;
  let projectRoot: string;
  let dbPath: string;
  let originalCwd: string;
  let originalProjectDir: string | undefined;

  beforeEach(async () => {
    // Each test gets its own project root with its own .moflo/moflo.db so the
    // bridge's process-singleton state can be re-anchored cleanly. The bridge
    // singleton is shared across tests in the same process — we reset it and
    // re-anchor here. Tests that mutate the disk between bridge ops are the
    // whole point of this suite, so coherence is checked here, not faked.
    tempDir = fs.mkdtempSync(path.join(tmpdir(), 'moflo-1058-coh-'));
    projectRoot = tempDir;
    fs.mkdirSync(path.join(projectRoot, '.moflo'), { recursive: true });
    dbPath = path.join(projectRoot, '.moflo', 'moflo.db');

    originalCwd = process.cwd();
    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = projectRoot;
    // Take routing out of the picture — we exercise the bridge directly.
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

  it('own persist updates the cursor (no self-invalidation)', async () => {
    await storeEntry({ key: 'k1', value: 'v1', namespace: 'ns' });
    const after1 = _getBridgeCoherenceCursorForTest();
    expect(after1).not.toBeNull();

    // Force a real mtime delta by sleeping past filesystem mtime resolution
    // (Windows = 1s, ext4 = 1ns, macOS varies). 1100ms is generous.
    await new Promise(r => setTimeout(r, 1100));

    await storeEntry({ key: 'k2', value: 'v2', namespace: 'ns' });
    const after2 = _getBridgeCoherenceCursorForTest();
    // Our own writes move the cursor forward, but they MUST NOT trip the
    // invalidation path — the bridge stays loaded between writes.
    expect(after2).not.toBeNull();
    expect(after2!).toBeGreaterThanOrEqual(after1!);

    // Both rows still retrievable via the same bridge → no reinit needed
    // for own writes.
    const g1 = await getEntry({ key: 'k1', namespace: 'ns' });
    const g2 = await getEntry({ key: 'k2', namespace: 'ns' });
    expect(g1.found).toBe(true);
    expect(g2.found).toBe(true);
  });

  it('another writer\'s mtime bump invalidates and forces fresh disk read', async () => {
    // Phase 1: this process writes a row. Bridge has it; cursor anchored.
    await storeEntry({ key: 'first', value: 'first-value', namespace: 'ns' });
    const cursorAfterOwn = _getBridgeCoherenceCursorForTest();
    expect(cursorAfterOwn).not.toBeNull();

    // Phase 2: simulate another process writing the SAME dbPath with an
    // entirely different snapshot. We open a fresh sql.js, insert a row the
    // current process's bridge does not know about, persist, and bump mtime.
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const buf = fs.readFileSync(dbPath);
    const otherDb = new SQL.Database(new Uint8Array(buf));
    // Insert a row the current bridge's snapshot lacks.
    const otherId = `entry_other_${Date.now()}`;
    otherDb.run(
      `INSERT INTO memory_entries (id, key, namespace, content, type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'semantic', 'active', ?, ?)`,
      [otherId, 'injected-by-other-writer', 'ns', 'remote-value', Date.now(), Date.now()],
    );
    // Wait past filesystem mtime granularity so the persist bumps mtime
    // beyond the cursor (Windows 1s, macOS HFS+ 1s, ext4 ns).
    await new Promise(r => setTimeout(r, 1100));
    fs.writeFileSync(dbPath, Buffer.from(otherDb.export()));
    otherDb.close();

    // Phase 3: this process reads the injected row. The mtime check on the
    // next withDb call must invalidate the stale bridge and reload.
    const result = await getEntry({ key: 'injected-by-other-writer', namespace: 'ns' });
    expect(result.success).toBe(true);
    expect(result.found).toBe(true);
    expect(result.entry?.content).toBe('remote-value');

    // The cursor must have moved past the original anchor — the reload
    // re-anchored to the new disk mtime.
    const cursorAfterReload = _getBridgeCoherenceCursorForTest();
    expect(cursorAfterReload).not.toBeNull();
    expect(cursorAfterReload!).toBeGreaterThan(cursorAfterOwn!);
  });

  it('search reflects external writes after coherence-driven reload', async () => {
    // Seed via our bridge.
    await storeEntry({ key: 'in-process', value: 'in-process-content', namespace: 'ns' });

    // External writer injects a semantically related row.
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const buf = fs.readFileSync(dbPath);
    const otherDb = new SQL.Database(new Uint8Array(buf));
    otherDb.run(
      `INSERT INTO memory_entries (id, key, namespace, content, type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'semantic', 'active', ?, ?)`,
      [`entry_search_${Date.now()}`, 'external-key', 'ns', 'external-content', Date.now(), Date.now()],
    );
    await new Promise(r => setTimeout(r, 1100));
    fs.writeFileSync(dbPath, Buffer.from(otherDb.export()));
    otherDb.close();

    // Bridge must reload → list (via the bridge) sees the external row.
    const result = await getEntry({ key: 'external-key', namespace: 'ns' });
    expect(result.found).toBe(true);
    expect(result.entry?.content).toBe('external-content');
  });

  it('does NOT invalidate the bridge when mtime is unchanged', async () => {
    await storeEntry({ key: 'k1', value: 'v1', namespace: 'ns' });
    const cursor1 = _getBridgeCoherenceCursorForTest();
    expect(cursor1).not.toBeNull();

    // Read without any disk mutation between writes.
    await getEntry({ key: 'k1', namespace: 'ns' });
    const cursor2 = _getBridgeCoherenceCursorForTest();

    // No mtime change → no reload → cursor stays put.
    expect(cursor2).toBe(cursor1);
  });

  // #1073 / smoke regression gate. Pre-fix, the daemon was exempted from
  // mtime-coherence under "daemon is sole writer", but `bin/index-guidance.mjs`
  // and the consumer-smoke memory-protocol probe both write directly to disk
  // while the daemon is up. With the exemption in place, daemon-routed reads
  // returned the pre-init snapshot indefinitely. This test pins the daemon
  // path through the same coherence guard the non-daemon case uses.
  it('daemon process (MOFLO_IS_DAEMON=1) also detects external writes', async () => {
    const originalIsDaemon = process.env.MOFLO_IS_DAEMON;
    process.env.MOFLO_IS_DAEMON = '1';
    try {
      // Anchor the daemon's bridge against its own first op.
      await storeEntry({ key: 'daemon-own', value: 'own-content', namespace: 'ns' });
      const cursorAfterOwn = _getBridgeCoherenceCursorForTest();
      expect(cursorAfterOwn).not.toBeNull();

      // External writer (simulating the indexer) bumps mtime past the anchor.
      const initSqlJs = (await import('sql.js')).default;
      const SQL = await initSqlJs();
      const buf = fs.readFileSync(dbPath);
      const otherDb = new SQL.Database(new Uint8Array(buf));
      otherDb.run(
        `INSERT INTO memory_entries (id, key, namespace, content, type, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'semantic', 'active', ?, ?)`,
        [`entry_indexer_${Date.now()}`, 'indexer-written-key', 'ns', 'indexer-content', Date.now(), Date.now()],
      );
      await new Promise(r => setTimeout(r, 1100));
      fs.writeFileSync(dbPath, Buffer.from(otherDb.export()));
      otherDb.close();

      // Daemon's next read must reload from disk and see the external row.
      const result = await getEntry({ key: 'indexer-written-key', namespace: 'ns' });
      expect(result.found).toBe(true);
      expect(result.entry?.content).toBe('indexer-content');

      const cursorAfterReload = _getBridgeCoherenceCursorForTest();
      expect(cursorAfterReload).not.toBeNull();
      expect(cursorAfterReload!).toBeGreaterThan(cursorAfterOwn!);
    } finally {
      if (originalIsDaemon === undefined) delete process.env.MOFLO_IS_DAEMON;
      else process.env.MOFLO_IS_DAEMON = originalIsDaemon;
    }
  });
});
