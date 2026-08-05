/**
 * Single-writer lock for the HNSW sidecar pair (#1388).
 *
 * The failure this guards against is not a torn write — both files are written
 * atomically. It is that a writer decides *what* to write by loading the graph
 * and diffing it against the DB, so two writers that each load the same
 * starting graph both compute a diff against it and the loser's work is
 * overwritten wholesale. Serialising only the write would not help; the lock
 * has to span load → diff → write.
 *
 * These tests pin the lock's own contract (mutual exclusion, release on throw,
 * reclaiming a lock nobody holds) and the property that matters at the call
 * site: concurrent `syncHnswSidecar` calls converge on a sidecar holding every
 * embedded row, rather than whichever writer finished last.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  hnswLockPath,
  pendingLockChainCount,
  withHnswSidecarLock,
} from '../../memory/hnsw-sidecar-lock.js';
import { syncHnswSidecar, tryLoadHnswSidecar } from '../../memory/hnsw-persistence.js';
import { MOFLO_DIR, MEMORY_DB_FILE } from '../../services/moflo-paths.js';
import { openDaemonDatabase } from '../../memory/daemon-backend.js';

const DIM = 8;

function vectorFor(seed: number): number[] {
  return Array.from({ length: DIM }, (_, j) => Number(Math.sin(seed * 0.7 + j * 0.3).toFixed(6)));
}

function withDb<T>(dbPath: string, fn: (db: ReturnType<typeof openDaemonDatabase>) => T): T {
  const db = openDaemonDatabase(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function createSchema(dbPath: string): void {
  withDb(dbPath, (db) => {
    db.run(`CREATE TABLE memory_entries (
      id TEXT PRIMARY KEY,
      key TEXT,
      namespace TEXT,
      content TEXT,
      embedding TEXT,
      updated_at INTEGER,
      status TEXT
    )`);
  });
}

function insertRows(dbPath: string, namespace: string, count: number, seedBase: number): void {
  withDb(dbPath, (db) => {
    for (let i = 0; i < count; i++) {
      const seed = seedBase + i;
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, embedding, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`,
        [`${namespace}-${i}`, `key-${seed}`, namespace, `content ${seed}`,
          JSON.stringify(vectorFor(seed)), 1_700_000_000_000],
      );
    }
  });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('hnsw-sidecar-lock (#1388)', () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-1388-'));
    fs.mkdirSync(path.join(tmp, MOFLO_DIR));
    dbPath = path.join(tmp, MOFLO_DIR, MEMORY_DB_FILE);
    createSchema(dbPath);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  describe('mutual exclusion', () => {
    it('never runs two critical sections at once', async () => {
      let concurrent = 0;
      let peak = 0;

      const section = async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await delay(10);
        concurrent--;
      };

      await Promise.all(
        Array.from({ length: 8 }, () => withHnswSidecarLock(tmp, section)),
      );

      expect(peak).toBe(1);
    });

    it('runs them in the order they asked, so no waiter is starved', async () => {
      const order: number[] = [];

      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          withHnswSidecarLock(tmp, async () => {
            order.push(i);
            await delay(5);
          }),
        ),
      );

      expect(order).toEqual([0, 1, 2, 3, 4]);
    });
  });

  describe('release', () => {
    it('removes the lock file after a successful run', async () => {
      await withHnswSidecarLock(tmp, async () => {
        expect(fs.existsSync(hnswLockPath(tmp))).toBe(true);
      });

      expect(fs.existsSync(hnswLockPath(tmp))).toBe(false);
    });

    it('releases when the critical section throws, and propagates the error', async () => {
      await expect(
        withHnswSidecarLock(tmp, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(fs.existsSync(hnswLockPath(tmp))).toBe(false);
    });

    it('keeps serialising after a critical section throws', async () => {
      const ran: string[] = [];

      const failing = withHnswSidecarLock(tmp, async () => {
        ran.push('failing');
        throw new Error('boom');
      }).catch(() => undefined);
      const following = withHnswSidecarLock(tmp, async () => { ran.push('following'); });

      await Promise.all([failing, following]);

      expect(ran).toEqual(['failing', 'following']);
    });
  });

  describe('a project root without a state directory yet', () => {
    it('creates .moflo on demand rather than failing to acquire', async () => {
      // The common path skips `mkdirSync` entirely — `.moflo/` exists for any
      // project with a database to index — so the directory is created lazily
      // off the ENOENT retry. That branch needs its own coverage precisely
      // because normal runs never reach it.
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-1388-bare-'));
      try {
        expect(fs.existsSync(path.join(bare, MOFLO_DIR))).toBe(false);

        let ran = false;
        await withHnswSidecarLock(bare, async () => { ran = true; });

        expect(ran).toBe(true);
        expect(fs.existsSync(path.join(bare, MOFLO_DIR))).toBe(true);
        expect(fs.existsSync(hnswLockPath(bare))).toBe(false);
      } finally {
        fs.rmSync(bare, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });
  });

  describe('giving up on a live holder', () => {
    it('throws rather than writing alongside a holder that is still alive', async () => {
      // Our own pid, stamped now: alive and not stale, so the only way out is
      // the deadline. Breaking the lock here would run concurrently with a
      // confirmed-live writer — the race the module exists to close.
      fs.writeFileSync(
        hnswLockPath(tmp),
        JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      );

      let ran = false;
      await expect(
        withHnswSidecarLock(tmp, async () => { ran = true; }, { acquireTimeoutMs: 120 }),
      ).rejects.toThrow(/still held by pid/);

      expect(ran).toBe(false);
      // The holder's lock is left untouched — it is still theirs.
      expect(fs.existsSync(hnswLockPath(tmp))).toBe(true);
    });

    it('names the blocking pid so a wedged lock is diagnosable', async () => {
      fs.writeFileSync(
        hnswLockPath(tmp),
        JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      );

      await expect(
        withHnswSidecarLock(tmp, async () => undefined, { acquireTimeoutMs: 120 }),
      ).rejects.toThrow(new RegExp(`pid ${process.pid}`));
    });
  });

  describe('the in-process chain drains', () => {
    it('tracks nothing once every caller has settled', async () => {
      await Promise.all(
        Array.from({ length: 6 }, () => withHnswSidecarLock(tmp, async () => { await delay(1); })),
      );

      expect(pendingLockChainCount()).toBe(0);
    });

    it('drains even when callers reject', async () => {
      await Promise.all([
        withHnswSidecarLock(tmp, async () => { throw new Error('boom'); }).catch(() => undefined),
        withHnswSidecarLock(tmp, async () => undefined),
      ]);

      expect(pendingLockChainCount()).toBe(0);
    });
  });

  describe('reclaiming a lock nobody holds', () => {
    it('takes over a lock whose holder process has exited', async () => {
      // PID 0x7FFFFFFF is beyond any real pid_max on the platforms we ship to.
      fs.writeFileSync(
        hnswLockPath(tmp),
        JSON.stringify({ pid: 2_147_483_647, startedAt: Date.now() }),
      );

      let ran = false;
      await withHnswSidecarLock(tmp, async () => { ran = true; });

      expect(ran).toBe(true);
      expect(fs.existsSync(hnswLockPath(tmp))).toBe(false);
    });

    it('takes over a lock left half-written by a killed process', async () => {
      fs.writeFileSync(hnswLockPath(tmp), '{"pid":123,"star');

      let ran = false;
      await withHnswSidecarLock(tmp, async () => { ran = true; });

      expect(ran).toBe(true);
    });

    it('takes over a lock older than the staleness cap even if its pid is live', async () => {
      // Our own pid is unambiguously alive — only the age can free this one,
      // which is the Windows pid-recycling backstop.
      fs.writeFileSync(
        hnswLockPath(tmp),
        JSON.stringify({ pid: process.pid, startedAt: Date.now() - 60 * 60_000 }),
      );

      let ran = false;
      await withHnswSidecarLock(tmp, async () => { ran = true; });

      expect(ran).toBe(true);
    });
  });

  describe('what the lock buys at the call site', () => {
    it('holds the lock for the whole sync, not just the write', async () => {
      // The discriminating test: a competitor asking for the lock while a sync
      // is in flight must be made to wait. Remove the wrapper from
      // `syncHnswSidecar` and the competitor runs first, because nothing is
      // holding anything — which is precisely the pre-#1388 behaviour.
      insertRows(dbPath, 'patterns', 40, 0);
      const order: string[] = [];

      const sync = syncHnswSidecar(dbPath, tmp, { dimensions: DIM })
        .then(() => { order.push('sync'); });
      // Yield once so the sync has taken the lock before the competitor asks.
      await delay(0);
      const competitor = withHnswSidecarLock(tmp, async () => { order.push('competitor'); });

      await Promise.all([sync, competitor]);

      expect(order).toEqual(['sync', 'competitor']);
    });

    it('converges on every embedded row when writers overlap', async () => {
      // Three namespace-scoped writers, exactly the shape index-patterns,
      // index-reference and index-guidance produce. Pre-#1388 the last one to
      // finish decided the sidecar's contents and the others' rows vanished.
      insertRows(dbPath, 'patterns', 5, 0);
      insertRows(dbPath, 'reference', 5, 100);
      insertRows(dbPath, 'guidance', 5, 200);

      await Promise.all([
        syncHnswSidecar(dbPath, tmp, { dimensions: DIM }),
        syncHnswSidecar(dbPath, tmp, { dimensions: DIM }),
        syncHnswSidecar(dbPath, tmp, { dimensions: DIM }),
      ]);

      const loaded = tryLoadHnswSidecar(tmp);
      expect(loaded?.size).toBe(15);
      expect(fs.existsSync(hnswLockPath(tmp))).toBe(false);
    });

    it('does not lose rows a writer added while another writer was mid-flight', async () => {
      insertRows(dbPath, 'patterns', 5, 0);

      // First sync establishes a sidecar; the second starts against a DB that
      // grew in between. Both must be reflected, not just the later one.
      const first = syncHnswSidecar(dbPath, tmp, { dimensions: DIM });
      insertRows(dbPath, 'reference', 4, 100);
      const second = syncHnswSidecar(dbPath, tmp, { dimensions: DIM });

      await Promise.all([first, second]);

      expect(tryLoadHnswSidecar(tmp)?.size).toBe(9);
    });

    it('leaves no lock behind when the guarded operation fails', async () => {
      await expect(
        syncHnswSidecar(path.join(tmp, MOFLO_DIR, 'missing.db'), tmp, { dimensions: DIM }),
      ).rejects.toThrow(/db not found/);

      expect(fs.existsSync(hnswLockPath(tmp))).toBe(false);
    });
  });
});
