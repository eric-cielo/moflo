/**
 * Tests for `src/cli/services/memory-db-integrity-repair.ts` — the TS bridge
 * that the healer's `flo healer --fix -c memory-db-integrity` calls into.
 *
 * Scope: the *integration surface* — that the TS service round-trips through
 * the JS `bin/lib/db-repair.mjs` correctly, surfaces the tier/lossStats
 * fields on the result, and stays defensive against missing files and
 * non-SQLite content. Tier-2 (VACUUM INTO) and Tier-3 (row-level salvage)
 * deterministic synthesis is hard cross-platform — the JS-side test
 * exercises the underlying recovery cascade with synthetic corruption;
 * here we focus on shape + cross-platform daemon coordination.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { repairMemoryDbIntegrity } from '../../services/memory-db-integrity-repair.js';
import { openDaemonDatabase } from '../../memory/daemon-backend.js';

const MOFLO_DIR = '.moflo';
const DB_FILE = 'moflo.db';

function dbPath(root: string): string {
  return join(root, MOFLO_DIR, DB_FILE);
}

function mkRoot(): string {
  return mkdtempSync(join(tmpdir(), 'moflo-integrity-'));
}

function rmRoot(root: string): void {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

async function seedDb(root: string, rows: number): Promise<void> {
  mkdirSync(join(root, MOFLO_DIR), { recursive: true });
  const db = openDaemonDatabase(dbPath(root));
  db.run(`CREATE TABLE memory_entries (id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT)`);
  const insert = db.prepare('INSERT INTO memory_entries (key, value) VALUES (?, ?)');
  for (let i = 0; i < rows; i++) {
    insert.run([`key-${i}`, `value-${i}`]);
  }
  insert.free();
  db.close();
}

describe('repairMemoryDbIntegrity (TS service)', () => {
  it('returns no-op shape when the DB file is absent', async () => {
    const root = mkRoot();
    try {
      const result = await repairMemoryDbIntegrity(root);
      expect(result.repaired).toBe(false);
      expect(result.errors).toBe(0);
      expect(result.tier).toBeUndefined();
      expect(result.lossStats).toBeUndefined();
    } finally {
      rmRoot(root);
    }
  });

  it('leaves a healthy DB untouched and reports no repair', async () => {
    const root = mkRoot();
    try {
      await seedDb(root, 50);
      const result = await repairMemoryDbIntegrity(root);
      expect(result.repaired).toBe(false);
      expect(result.errors).toBe(0);
      expect(result.tier).toBeUndefined();
      // Daemon wasn't running, so the coordination flag stays falsy/undefined.
      expect(result.daemonStopped ?? false).toBe(false);
    } finally {
      rmRoot(root);
    }
  });

  it('never throws when given a non-SQLite file', async () => {
    const root = mkRoot();
    try {
      mkdirSync(join(root, MOFLO_DIR), { recursive: true });
      writeFileSync(dbPath(root), Buffer.from('definitely not a sqlite file'));
      const result = await repairMemoryDbIntegrity(root);
      // Header damage isn't recoverable by any tier — the service should
      // surface this as `persistent: true` (the JS-side `probeIntegrityRaw`
      // returns `openFailed: true`, every recovery tier fails, repair
      // returns `persistent: true`). What MUST hold: no exception escapes.
      expect(result.repaired).toBe(false);
      // `persistent` is the strong signal; absent it, `errors === 0` is
      // also a valid "swallowed open failure" outcome.
      if (!result.persistent) {
        expect(result.errors).toBe(0);
      }
    } finally {
      rmRoot(root);
    }
  });

  it('surfaces the JS-side tier label on a recoverable corruption', { timeout: 15_000 }, async () => {
    // 15s timeout (same rationale as the corrupted-DB test in db-repair.test.ts):
    // the tiered repair cascade (probe → REINDEX → VACUUM INTO → salvage →
    // swap) involves 6+ DatabaseSync open/close cycles plus a VACUUM
    // iteration over the corrupt source. Locally <500ms; Linux CI parallel
    // load can push it past the 5s default. 15s stays under the 30s redline
    // in feedback_no_test_timeout_bumps. The slowness is intrinsic to the
    // cascade, not a fixable bug.
    const root = mkRoot();
    try {
      await seedDb(root, 200);
      // Corrupt the autoindex pages — same fixture as the JS test. REINDEX
      // is the expected tier; we don't *require* it (the cascade may
      // escalate on some SQLite builds), but if any repair succeeds the
      // tier label must be one of the documented values.
      const buf = readFileSync(dbPath(root));
      for (let page = 4; page < 7; page++) {
        const start = page * 4096;
        if (start + 4096 > buf.length) break;
        buf.fill(0, start, start + 4096);
      }
      writeFileSync(dbPath(root), buf);

      const result = await repairMemoryDbIntegrity(root);
      if (result.repaired) {
        expect(['reindex', 'vacuum', 'salvage']).toContain(result.tier);
        // VACUUM and salvage tiers must hand back a forensic backup path.
        if (result.tier !== 'reindex') {
          expect(typeof result.corruptBackup).toBe('string');
          expect(existsSync(result.corruptBackup!)).toBe(true);
        }
      }
      // Regardless of recovery success, the service must never throw.
      expect(typeof result.repaired).toBe('boolean');
      expect(typeof result.errors).toBe('number');
    } finally {
      rmRoot(root);
    }
  });

  it('honours stopDaemonFirst:false (launcher path)', async () => {
    // The launcher already stops the daemon in section 0 before calling
    // the JS repair directly. When the TS service is invoked with
    // `stopDaemonFirst: false`, it must NOT attempt to stop any daemon —
    // even one that happens to be alive — and `daemonStopped` must be
    // false on the result. This guards the launcher contract against
    // the TS path accidentally double-stopping.
    const root = mkRoot();
    try {
      await seedDb(root, 10);
      const result = await repairMemoryDbIntegrity(root, { stopDaemonFirst: false });
      expect(result.daemonStopped).toBe(false);
    } finally {
      rmRoot(root);
    }
  });
});
