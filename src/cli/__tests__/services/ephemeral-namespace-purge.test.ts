/**
 * Unit tests for the #729 / #968 session-start memory cleanup service.
 *
 * Covers:
 *  - Hard-purges rows from PURGE_ON_SESSION_START_NAMESPACES
 *    (hive-mind, epic-state, test-bridge-fix)
 *  - Hard-purges rows whose namespace matches PURGE_ON_SESSION_START_PREFIXES
 *    (doctor-memprobe-<persona>) — added post-#1090 to stop healer probe
 *    residue accumulating across consumer sessions
 *  - Preserves tasklist rows up to retention cap (#968 fix)
 *  - Trims tasklist beyond retention cap, keeping the most recent entries
 *  - Preserves rows in unrelated namespaces (knowledge, patterns, etc.)
 *  - Idempotent: clean DB returns { purged: 0, trimmed: 0 } without writing
 *  - Skips DBs that lack memory_entries
 *  - Returns zero counts when the DB does not exist
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  purgeEphemeralNamespaces,
  purgeMemoryProbeNamespaces,
} from '../../services/ephemeral-namespace-purge.js';
import {
  EPHEMERAL_NAMESPACES,
  EPHEMERAL_NAMESPACE_PREFIXES,
  PURGE_ON_SESSION_START_NAMESPACES,
  PURGE_ON_SESSION_START_PREFIXES,
  TASKLIST_RETENTION_CAP,
  isEphemeralNamespace,
  shouldPurgeOnSessionStart,
} from '../../memory/bridge-embedder.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';
import { openDaemonDatabase, type SqlJsLikeDatabase } from '../../memory/daemon-backend.js';

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* non-fatal — Windows occasionally holds file handles */
    }
  }
});

async function makeTmpDb(setup: (db: SqlJsLikeDatabase) => void): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'moflo-eph-purge-'));
  tmpDirs.push(dir);
  const dbPath = join(dir, 'memory.db');
  const db = openDaemonDatabase(dbPath);
  db.run(MEMORY_SCHEMA_V3);
  setup(db);
  db.close();
  return dbPath;
}

function countByNamespace(dbPath: string, namespace: string): number {
  const db = openDaemonDatabase(dbPath);
  try {
    const stmt = `SELECT COUNT(*) FROM memory_entries WHERE namespace = '${namespace}'`;
    const rows = db.exec(stmt);
    return Number(rows[0]?.values?.[0]?.[0] ?? 0);
  } finally {
    db.close();
  }
}

describe('purgeEphemeralNamespaces (#729, #968)', () => {
  it('returns zero counts when the DB file does not exist', async () => {
    const result = await purgeEphemeralNamespaces({
      dbPath: join(tmpdir(), 'moflo-missing-729', 'nope.db'),
    });
    expect(result).toEqual({ purged: 0, trimmed: 0 });
  });

  it('hard-deletes only PURGE_ON_SESSION_START_NAMESPACES and preserves tasklist + others', async () => {
    const dbPath = await makeTmpDb((db) => {
      let n = 0;
      const insert = (id: string, ns: string, content: string) =>
        db.run(
          `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
          [id, `k-${id}`, ns, content],
        );

      // 2 rows per purge-set namespace
      for (const ns of PURGE_ON_SESSION_START_NAMESPACES) {
        insert(`${ns}-${++n}`, ns, `purge-${ns}-1`);
        insert(`${ns}-${++n}`, ns, `purge-${ns}-2`);
      }
      // 3 tasklist rows — well under retention cap, all should survive
      insert('tl-1', 'tasklist', 'flo-100-1700000000000');
      insert('tl-2', 'tasklist', 'flo-101-1700000001000');
      insert('tl-3', 'tasklist', 'flo-102-1700000002000');

      // Untouchable: rows in real user namespaces
      insert('keep-1', 'knowledge', 'real user knowledge');
      insert('keep-2', 'patterns', 'a learned pattern');
      insert('keep-3', 'guidance', 'guidance entry');
    });

    const result = await purgeEphemeralNamespaces({ dbPath });
    expect(result.purged).toBe(PURGE_ON_SESSION_START_NAMESPACES.size * 2);
    expect(result.trimmed).toBe(0); // 3 < cap, no trim

    for (const ns of PURGE_ON_SESSION_START_NAMESPACES) {
      expect(countByNamespace(dbPath, ns)).toBe(0);
    }
    // #968: tasklist must survive
    expect(countByNamespace(dbPath, 'tasklist')).toBe(3);
    expect(countByNamespace(dbPath, 'knowledge')).toBe(1);
    expect(countByNamespace(dbPath, 'patterns')).toBe(1);
    expect(countByNamespace(dbPath, 'guidance')).toBe(1);
  });

  it('trims tasklist beyond retention cap, keeping the most recent rows (#968)', async () => {
    const dbPath = await makeTmpDb((db) => {
      // 7 tasklist rows with monotonic created_at; cap=3 keeps last 3.
      const base = 1_700_000_000_000;
      for (let i = 0; i < 7; i++) {
        db.run(
          `INSERT INTO memory_entries (id, key, namespace, content, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
          [`tl-${i}`, `flo-${i}`, 'tasklist', `record-${i}`, base + i * 1000],
        );
      }
    });

    const result = await purgeEphemeralNamespaces({ dbPath, tasklistRetentionCap: 3 });
    expect(result.purged).toBe(0);
    expect(result.trimmed).toBe(4); // 7 - 3 = 4 oldest deleted

    expect(countByNamespace(dbPath, 'tasklist')).toBe(3);

    // The three most recent (tl-4, tl-5, tl-6) should be the survivors.
    const db = openDaemonDatabase(dbPath);
    try {
      const rows = db.exec(`SELECT id FROM memory_entries WHERE namespace = 'tasklist' ORDER BY created_at ASC`);
      const ids = (rows[0]?.values ?? []).map(r => r[0]);
      expect(ids).toEqual(['tl-4', 'tl-5', 'tl-6']);
    } finally {
      db.close();
    }
  });

  it('is idempotent: a clean DB returns zero counts and preserves rows', async () => {
    const dbPath = await makeTmpDb((db) => {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
        ['live', 'k', 'patterns', 'c'],
      );
    });

    const result = await purgeEphemeralNamespaces({ dbPath });
    expect(result).toEqual({ purged: 0, trimmed: 0 });

    // Pre-WAL the test verified byte-equality of the file, but the daemon
    // factory rewrites journal_mode pragma bytes in the header on every open
    // (Phase 5 / #1084) — even read-only probes touch the file. Switch to a
    // semantic invariant: the surviving row count is unchanged.
    expect(countByNamespace(dbPath, 'patterns')).toBe(1);
  });

  it('running twice in succession is a no-op on the second pass', async () => {
    const dbPath = await makeTmpDb((db) => {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
        ['t1', 'k1', 'hive-mind', 'msg-foo'],
      );
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
        ['t2', 'k2', 'epic-state', 'epic-7'],
      );
    });

    const first = await purgeEphemeralNamespaces({ dbPath });
    expect(first.purged).toBe(2);
    expect(first.trimmed).toBe(0);

    const second = await purgeEphemeralNamespaces({ dbPath });
    expect(second).toEqual({ purged: 0, trimmed: 0 });
  });

  it('skips DBs that lack a memory_entries table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moflo-eph-purge-other-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'something.db');
    const db = openDaemonDatabase(dbPath);
    db.run(`CREATE TABLE other_table (id TEXT PRIMARY KEY);`);
    db.close();

    const result = await purgeEphemeralNamespaces({ dbPath });
    expect(result).toEqual({ purged: 0, trimmed: 0 });
  });

  it('hard-purges prefix-match namespaces (doctor-memprobe-*) alongside exact-match', async () => {
    // Mirrors the production failure pattern: `flo healer`'s round-trip probe
    // writes a sentinel row in `doctor-memprobe-<persona>` and registers a
    // best-effort cleanup. When the cleanup fails silently (daemon race,
    // EPERM, MCP transport error), rows accumulate across sessions. The
    // session-start launcher must purge them via the prefix match.
    const dbPath = await makeTmpDb((db) => {
      // Exact-match purgeable rows (existing contract)
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
        ['exact-1', 'k-exact-1', 'hive-mind', 'msg-foo'],
      );
      // Prefix-match purgeable rows — every known healer persona variant
      const personas = ['subagent', 'swarm-agent', 'hive-mind-worker', 'iter', 'test'];
      let i = 0;
      for (const p of personas) {
        db.run(
          `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
          [`probe-${++i}`, `k-probe-${i}`, `doctor-memprobe-${p}`, `sentinel-${p}`],
        );
      }
      // Decoy: a namespace that *contains* but doesn't *start with* the prefix
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
        ['decoy', 'k-decoy', 'my-doctor-memprobe-fake', 'should-survive'],
      );
      // Untouchable user row
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
        ['keep', 'k-keep', 'learnings', 'real learning'],
      );
    });

    const result = await purgeEphemeralNamespaces({ dbPath });
    expect(result.purged).toBe(6); // 1 exact + 5 prefix-match
    expect(result.trimmed).toBe(0);

    // Exact-match cleared
    expect(countByNamespace(dbPath, 'hive-mind')).toBe(0);
    // All prefix-match cleared
    expect(countByNamespace(dbPath, 'doctor-memprobe-subagent')).toBe(0);
    expect(countByNamespace(dbPath, 'doctor-memprobe-swarm-agent')).toBe(0);
    expect(countByNamespace(dbPath, 'doctor-memprobe-hive-mind-worker')).toBe(0);
    expect(countByNamespace(dbPath, 'doctor-memprobe-iter')).toBe(0);
    expect(countByNamespace(dbPath, 'doctor-memprobe-test')).toBe(0);
    // Decoy and user row survive — LIKE must anchor at the start
    expect(countByNamespace(dbPath, 'my-doctor-memprobe-fake')).toBe(1);
    expect(countByNamespace(dbPath, 'learnings')).toBe(1);
  });

  it('hard-purges doctor-neighbors-* timestamped namespaces', async () => {
    // Unlike memprobe (fixed persona set), the neighbors probe creates a
    // brand-new namespace on every healer run. Without auto-purge, a heavy
    // healer user accumulates one fresh namespace per run.
    const dbPath = await makeTmpDb((db) => {
      // Three timestamp-suffixed neighbor probe namespaces, 3 chunks each
      const stamps = ['1778702104739-nw6tcl', '1778701810936-zmnzzp', '1778700000000-aaaaaa'];
      let id = 0;
      for (const stamp of stamps) {
        for (let i = 0; i < 3; i++) {
          db.run(
            `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
            [`n-${++id}`, `chunk-doctor-neighbors-${stamp}-${i}`, `doctor-neighbors-${stamp}`, `chunk ${i}`],
          );
        }
      }
      // User row that must survive
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
        ['keep', 'k-keep', 'learnings', 'real learning'],
      );
    });

    const result = await purgeEphemeralNamespaces({ dbPath });
    expect(result.purged).toBe(9); // 3 namespaces × 3 chunks
    expect(countByNamespace(dbPath, 'doctor-neighbors-1778702104739-nw6tcl')).toBe(0);
    expect(countByNamespace(dbPath, 'doctor-neighbors-1778701810936-zmnzzp')).toBe(0);
    expect(countByNamespace(dbPath, 'doctor-neighbors-1778700000000-aaaaaa')).toBe(0);
    expect(countByNamespace(dbPath, 'learnings')).toBe(1);
  });
});

describe('purgeMemoryProbeNamespaces (#1166)', () => {
  it('returns { purged: 0 } when the DB file does not exist', async () => {
    const result = await purgeMemoryProbeNamespaces({
      dbPath: join(tmpdir(), 'moflo-missing-1166', 'nope.db'),
    });
    expect(result).toEqual({ purged: 0 });
  });

  it('hard-deletes only prefix-match namespaces; exact ephemerals and user data survive', async () => {
    // The doctor's namespace sweep must NOT clobber hive-mind / epic-state /
    // test-bridge-fix (the launcher owns those) and obviously NOT user data.
    const dbPath = await makeTmpDb((db) => {
      const insert = (id: string, key: string, ns: string, content: string) =>
        db.run(
          `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
          [id, key, ns, content],
        );

      // Prefix-match probe rows — every healer persona plus a neighbors stamp.
      const personas = ['subagent', 'swarm-agent', 'hive-mind-worker'];
      let i = 0;
      for (const p of personas) {
        insert(`probe-${++i}`, `k-probe-${i}`, `doctor-memprobe-${p}`, `sentinel-${p}`);
      }
      for (let n = 0; n < 3; n++) {
        insert(
          `nbr-${++i}`,
          `chunk-doctor-neighbors-1778702104739-nw6tcl-${n}`,
          'doctor-neighbors-1778702104739-nw6tcl',
          `chunk ${n}`,
        );
      }

      // Exact ephemerals the doctor must NOT touch (launcher owns these).
      for (const ns of PURGE_ON_SESSION_START_NAMESPACES) {
        insert(`exact-${++i}`, `k-exact-${i}`, ns, `exact-${ns}`);
      }

      // Decoy: namespace contains the prefix but doesn't start with it.
      insert(`decoy`, 'k-decoy', 'my-doctor-memprobe-fake', 'should-survive');

      // User rows that must survive.
      insert('keep-1', 'k-keep-1', 'learnings', 'real learning');
      insert('keep-2', 'k-keep-2', 'knowledge', 'real knowledge');
      insert('keep-3', 'k-keep-3', 'tasklist', 'flo-1-1700000000000');
    });

    const result = await purgeMemoryProbeNamespaces({ dbPath });
    expect(result.purged).toBe(3 + 3); // 3 personas + 3 neighbors chunks

    // Prefix-match cleared.
    expect(countByNamespace(dbPath, 'doctor-memprobe-subagent')).toBe(0);
    expect(countByNamespace(dbPath, 'doctor-memprobe-swarm-agent')).toBe(0);
    expect(countByNamespace(dbPath, 'doctor-memprobe-hive-mind-worker')).toBe(0);
    expect(countByNamespace(dbPath, 'doctor-neighbors-1778702104739-nw6tcl')).toBe(0);

    // Exact ephemerals untouched — the launcher owns those.
    for (const ns of PURGE_ON_SESSION_START_NAMESPACES) {
      expect(countByNamespace(dbPath, ns)).toBe(1);
    }
    // Decoy and user data survive.
    expect(countByNamespace(dbPath, 'my-doctor-memprobe-fake')).toBe(1);
    expect(countByNamespace(dbPath, 'learnings')).toBe(1);
    expect(countByNamespace(dbPath, 'knowledge')).toBe(1);
    expect(countByNamespace(dbPath, 'tasklist')).toBe(1);
  });

  it('is idempotent — second pass over a clean DB returns { purged: 0 }', async () => {
    const dbPath = await makeTmpDb((db) => {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, 'active')`,
        ['p1', 'kp1', 'doctor-memprobe-subagent', 'probe'],
      );
    });

    const first = await purgeMemoryProbeNamespaces({ dbPath });
    expect(first.purged).toBe(1);

    const second = await purgeMemoryProbeNamespaces({ dbPath });
    expect(second).toEqual({ purged: 0 });
  });

  it('skips DBs that lack a memory_entries table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moflo-probe-purge-other-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'something.db');
    const db = openDaemonDatabase(dbPath);
    db.run(`CREATE TABLE other_table (id TEXT PRIMARY KEY);`);
    db.close();

    const result = await purgeMemoryProbeNamespaces({ dbPath });
    expect(result).toEqual({ purged: 0 });
  });
});

describe('namespace constants (#729, #968)', () => {
  it('EPHEMERAL_NAMESPACES contains exactly the four embedding-skip namespaces', () => {
    expect(Array.from(EPHEMERAL_NAMESPACES).sort()).toEqual(
      ['epic-state', 'hive-mind', 'tasklist', 'test-bridge-fix'],
    );
  });

  it('PURGE_ON_SESSION_START_NAMESPACES is a strict subset that excludes tasklist (#968)', () => {
    expect(Array.from(PURGE_ON_SESSION_START_NAMESPACES).sort()).toEqual(
      ['epic-state', 'hive-mind', 'test-bridge-fix'],
    );
    expect(PURGE_ON_SESSION_START_NAMESPACES.has('tasklist')).toBe(false);
    for (const ns of PURGE_ON_SESSION_START_NAMESPACES) {
      expect(EPHEMERAL_NAMESPACES.has(ns)).toBe(true);
    }
  });

  it('TASKLIST_RETENTION_CAP is set to a sensible default', () => {
    expect(TASKLIST_RETENTION_CAP).toBeGreaterThan(0);
    expect(TASKLIST_RETENTION_CAP).toBeLessThanOrEqual(1000);
  });

  it('EPHEMERAL_NAMESPACE_PREFIXES is empty by design (post-#1090)', () => {
    // doctor-memprobe-<persona> is purgeable but NOT skip-embed: the
    // `Memory Access Functional` doctor check writes there specifically to
    // validate the embedder is wired (asserts hasEmbedding=true). Putting it
    // in EPHEMERAL_NAMESPACE_PREFIXES would skip embedding generation and
    // break the doctor check. Kept as an explicit empty export so any
    // future skip-embed prefix has an obvious home.
    expect(Array.from(EPHEMERAL_NAMESPACE_PREFIXES)).toEqual([]);
  });

  it('PURGE_ON_SESSION_START_PREFIXES contains the doctor probe prefixes (post-#1090)', () => {
    expect(Array.from(PURGE_ON_SESSION_START_PREFIXES).sort()).toEqual([
      'doctor-memprobe-',
      'doctor-neighbors-',
    ]);
  });

  it('every purge-prefix-match namespace either gets embeddings or is also in EPHEMERAL_NAMESPACE_PREFIXES', () => {
    // Cross-check invariant: a namespace must not be auto-purged without
    // *also* being skip-embed UNLESS the caller has a deliberate reason
    // (like `doctor-memprobe-*` / `doctor-neighbors-*` needing embeddings
    // for the doctor check). This test documents the exception explicitly
    // so future prefix additions get a deliberate review.
    const purgeOnly = Array.from(PURGE_ON_SESSION_START_PREFIXES)
      .filter(p => !EPHEMERAL_NAMESPACE_PREFIXES.has(p));
    expect(purgeOnly.sort()).toEqual(['doctor-memprobe-', 'doctor-neighbors-']);
  });
});

describe('isEphemeralNamespace / shouldPurgeOnSessionStart helpers (#1090)', () => {
  it('isEphemeralNamespace returns true for exact-match members', () => {
    expect(isEphemeralNamespace('hive-mind')).toBe(true);
    expect(isEphemeralNamespace('tasklist')).toBe(true);
    expect(isEphemeralNamespace('epic-state')).toBe(true);
    expect(isEphemeralNamespace('test-bridge-fix')).toBe(true);
  });

  it('isEphemeralNamespace returns false for doctor-memprobe namespaces (they need embeddings)', () => {
    // The doctor `Memory Access Functional` probe writes to
    // doctor-memprobe-<persona> and asserts hasEmbedding=true. The bridge
    // embedder must therefore NOT skip embedding generation for them, even
    // though they auto-purge on session start.
    expect(isEphemeralNamespace('doctor-memprobe-subagent')).toBe(false);
    expect(isEphemeralNamespace('doctor-memprobe-swarm-agent')).toBe(false);
    expect(isEphemeralNamespace('doctor-memprobe-hive-mind-worker')).toBe(false);
  });

  it('isEphemeralNamespace returns false for non-ephemeral namespaces', () => {
    expect(isEphemeralNamespace('learnings')).toBe(false);
    expect(isEphemeralNamespace('knowledge')).toBe(false);
    expect(isEphemeralNamespace('guidance')).toBe(false);
    expect(isEphemeralNamespace('patterns')).toBe(false);
    expect(isEphemeralNamespace('')).toBe(false);
  });

  it('shouldPurgeOnSessionStart returns true for both exact-match and prefix-match purgeable namespaces', () => {
    // Exact matches
    expect(shouldPurgeOnSessionStart('hive-mind')).toBe(true);
    expect(shouldPurgeOnSessionStart('epic-state')).toBe(true);
    expect(shouldPurgeOnSessionStart('test-bridge-fix')).toBe(true);
    // Prefix matches (memprobe)
    expect(shouldPurgeOnSessionStart('doctor-memprobe-subagent')).toBe(true);
    expect(shouldPurgeOnSessionStart('doctor-memprobe-')).toBe(true);
    expect(shouldPurgeOnSessionStart('doctor-memprobe-anything-arbitrary')).toBe(true);
    // Prefix matches (neighbors)
    expect(shouldPurgeOnSessionStart('doctor-neighbors-1778702104739-nw6tcl')).toBe(true);
    expect(shouldPurgeOnSessionStart('doctor-neighbors-')).toBe(true);

    // tasklist is ephemeral (skip-embed) but NOT purged — see #968.
    expect(shouldPurgeOnSessionStart('tasklist')).toBe(false);
    expect(isEphemeralNamespace('tasklist')).toBe(true);

    // Non-ephemeral, non-purgeable namespaces
    expect(shouldPurgeOnSessionStart('learnings')).toBe(false);
    expect(shouldPurgeOnSessionStart('hive-mind-memory')).toBe(false); // production runtime, not a probe
    // Anchored at the start: a namespace containing but not starting with
    // the prefix must not match.
    expect(shouldPurgeOnSessionStart('my-doctor-memprobe-suffix')).toBe(false);
    expect(shouldPurgeOnSessionStart('my-doctor-neighbors-suffix')).toBe(false);
  });
});
