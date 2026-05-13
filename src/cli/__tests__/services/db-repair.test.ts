/**
 * Tests for bin/lib/db-repair.mjs (#743). Validates that the launcher's
 * pre-flight integrity check repairs the typical "row N missing from
 * sqlite_autoindex_memory_entries_1" corruption mode without throwing,
 * leaves healthy DBs alone, and is no-op when the DB file is absent.
 *
 * The repair helper lives in bin/lib/ rather than src/cli/services/ because
 * session-start-launcher.mjs runs before any TS compilation has happened —
 * see the same rationale in moflo-paths.mjs and its parity test.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// @ts-expect-error — pure JS module under bin/lib, no .d.ts emitted
import { repairMemoryDbIfCorrupt } from '../../../../bin/lib/db-repair.mjs';
import { openDaemonDatabase } from '../../memory/daemon-backend.js';

const MOFLO_DIR = '.moflo';
const DB_FILE = 'moflo.db';

function dbPath(root: string): string {
  return join(root, MOFLO_DIR, DB_FILE);
}

function mkRoot(): string {
  return mkdtempSync(join(tmpdir(), 'moflo-dbrepair-'));
}

/**
 * Windows cleanup helper. node:sqlite leaves brief OS-level locks on the
 * `.db-wal` / `.db-shm` sidecars after close; a naive `rmSync` races those
 * and trips `EPERM`. The launcher's own session-start sequence already
 * has plenty of slack for this; tests just need the retry loop.
 */
function rmRootWithRetries(root: string): void {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/**
 * Build a small SQLite DB with a unique-key index and seed it with rows.
 * Mirrors the memory_entries shape just enough that REINDEX has work to do.
 *
 * Phase 5 (#1084): seeds directly via the daemon-backend factory (node:sqlite
 * + WAL). close() triggers a passive checkpoint, so the data is in the main
 * file when corruptAutoIndexPages zeros pages 4-6.
 */
async function makeSeededDb(root: string, rowCount: number): Promise<void> {
  mkdirSync(join(root, MOFLO_DIR), { recursive: true });
  const db = openDaemonDatabase(dbPath(root));
  db.run(`CREATE TABLE memory_entries (id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT)`);
  const insert = db.prepare('INSERT INTO memory_entries (key, value) VALUES (?, ?)');
  for (let i = 0; i < rowCount; i++) {
    insert.run([`key-${i}`, `value-${i}`]);
  }
  insert.free();
  db.close();
}

/**
 * Corrupt the unique index by zeroing out a stretch of the file inside the
 * autoindex pages. SQLite reports this as "row N missing from index
 * sqlite_autoindex_memory_entries_1" — the exact mode we observed in
 * production (#743). Returns the modified bytes for sanity checking.
 */
function corruptAutoIndexPages(root: string): Buffer {
  const buf = readFileSync(dbPath(root));
  // SQLite default page size is 4096; pages 4–6 typically hold the autoindex
  // for a small DB. Zeroing them produces the "missing from index" mode
  // without breaking the row data on page 2.
  for (let page = 4; page < 7; page++) {
    const start = page * 4096;
    if (start + 4096 > buf.length) break;
    buf.fill(0, start, start + 4096);
  }
  writeFileSync(dbPath(root), buf);
  return buf;
}

describe('repairMemoryDbIfCorrupt (#743)', () => {
  it('returns repaired:false errors:0 when DB file is absent', async () => {
    const root = mkRoot();
    try {
      const result = await repairMemoryDbIfCorrupt(root);
      expect(result).toEqual({ repaired: false, errors: 0 });
    } finally {
      rmRootWithRetries(root);
    }
  });

  it('leaves a healthy DB untouched and reports no repair', async () => {
    const root = mkRoot();
    try {
      const rowCount = 50;
      await makeSeededDb(root, rowCount);
      const result = await repairMemoryDbIfCorrupt(root);
      expect(result).toEqual({ repaired: false, errors: 0 });

      // Phase 4 (#1083) flipped the SQLite engine to node:sqlite + WAL, so
      // opening the file (even just for an integrity probe) writes
      // journal-mode metadata and may produce .db-wal / .db-shm sidecars.
      // The byte-identical assertion this test used to make doesn't survive
      // that. What we actually care about: data round-trips intact through
      // the probe — re-open and verify the seeded rows are still there.
      const db = openDaemonDatabase(dbPath(root));
      try {
        const probe = db.exec('SELECT COUNT(*) FROM memory_entries');
        const count = Number(probe[0]?.values?.[0]?.[0] ?? 0);
        expect(count).toBe(rowCount);
      } finally {
        db.close();
      }
    } finally {
      rmRootWithRetries(root);
    }
  });

  it('handles a corrupt DB without throwing and reports the failure shape', { timeout: 15_000 }, async () => {
    // Synthesizing the exact "row N missing from autoindex" mode without
    // also breaking the b-tree parse is brittle and varies by sql.js build,
    // so this test asserts the SAFETY contract (no throw + accurate result
    // shape) rather than the success path. The production-side verification
    // for the REINDEX recovery is the live DB run captured in the #743
    // session log: corrupt → repair → integrity_check 'ok'.
    //
    // 15s timeout (default is 5s): post-#1090 the repair is a tiered cascade
    // (probe → REINDEX → VACUUM INTO → row-level salvage → atomic swap),
    // and `corruptAutoIndexPages` can produce corruption that forces the
    // full cascade to run. Under Linux CI parallel load that legitimately
    // takes >5s but stays well under 15s; locally it's <500ms. We're
    // testing the safety contract, not performance — the timeout exists
    // to catch a runaway (e.g. accidental infinite retry loop), not to
    // bound the cascade's normal cost. Tracked in `feedback_no_test_timeout_bumps`
    // — capped at 15s, well under the 30s redline; the slowness is
    // intrinsic to the cascade, not a fixable bug in the test.
    const root = mkRoot();
    try {
      await makeSeededDb(root, 200);
      corruptAutoIndexPages(root);

      const result = await repairMemoryDbIfCorrupt(root);

      // Post-#1090, the tiered repair has three valid success endpoints
      // (`tier: 'reindex' | 'vacuum' | 'salvage'`) plus the unrecoverable
      // case. Index-page corruption from `corruptAutoIndexPages` should
      // be reachable by REINDEX; VACUUM INTO and salvage are exercised
      // when corruption hits table b-trees, not the autoindex pages.
      expect(typeof result.repaired).toBe('boolean');
      expect(typeof result.errors).toBe('number');
      if (result.repaired === true) {
        expect(['reindex', 'vacuum', 'salvage']).toContain(result.tier);
        // VACUUM and salvage tiers keep a forensic copy of the corrupt
        // original under `.corrupt.<TS>` — the user can restore from it
        // if the recovered file turns out to have lost something valuable.
        if (result.tier !== 'reindex') {
          expect(typeof result.corruptBackup).toBe('string');
        }
      }
      if (result.repaired === false && result.errors > 0) {
        expect(result.persistent).toBe(true);
      }
    } finally {
      rmRootWithRetries(root);
    }
  });

  it('never throws when given a non-SQLite file', async () => {
    const root = mkRoot();
    try {
      mkdirSync(join(root, MOFLO_DIR), { recursive: true });
      writeFileSync(dbPath(root), Buffer.from('not a sqlite file'));
      const result = await repairMemoryDbIfCorrupt(root);
      // Either repaired:false errors:0 (open fails, swallowed) is acceptable
      // — what matters is no exception escapes.
      expect(result.repaired).toBe(false);
    } finally {
      rmRootWithRetries(root);
    }
  });
});
