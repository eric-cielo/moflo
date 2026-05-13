/**
 * Memory-DB integrity check + tiered repair (#743, #1090-followup).
 *
 * The `.moflo/moflo.db` SQLite file picks up corruption in two distinct modes:
 *
 *  1. **Index drift** — `row N missing from sqlite_autoindex_memory_entries_1`.
 *     Row data is intact; only the unique-key b-tree is wrong. Trigger: sql.js's
 *     whole-file dump-on-flush racing with concurrent writes (#714, #743 —
 *     fixed for new installs by Phase 5 / #1084 which removed sql.js entirely).
 *     **REINDEX** rebuilds the index from canonical row data.
 *
 *  2. **Table b-tree corruption** — `Tree N page M cell K: Rowid X out of
 *     order`, where Tree N is a TABLE root page (not just an index). Row data
 *     is partly intact, but page ordering is broken. Triggers we've seen:
 *      - sql.js → node:sqlite migration: an old 4.9.x sql.js daemon flushes its
 *        full-file dump OVER a WAL frame that the new 4.10 backend has already
 *        written, leaving WAL referencing pages that no longer exist in main.
 *      - Concurrent multi-process writes when the daemon was disabled (#981).
 *     **REINDEX cannot fix this** — the table itself is broken. Recovery path:
 *      a) `VACUUM INTO` a fresh file (single-shot rebuild; fails fast if
 *         iteration hits an unreadable page),
 *      b) row-level salvage — chunked `SELECT rowid > ?` per table, catching
 *         per-chunk errors and skipping past corrupt page ranges,
 *      c) atomic swap with .corrupt.<TS> backup retained for forensics.
 *
 *  3. **Unrecoverable** — header damage, encrypted-by-malware, etc. We can't
 *     fix this; surface a clear failure and let the user decide between manual
 *     `flo memory rebuild-index` (destructive) and offline recovery tools.
 *
 * Symptoms when uncorrected:
 *  - `index-guidance.mjs` and `index-patterns.mjs` fail mid-write with
 *    `database disk image is malformed`, leaving partial state.
 *  - The ephemeral-namespace purge (#729) fails silently, so hive-mind /
 *    tasklist / epic-state / test-bridge-fix rows accumulate.
 *  - Vector counts in the statusline stay inflated.
 *  - Healer's deep checks throw with "database disk image is malformed",
 *    surfacing as the synthetic 'Check' failure (doctor.ts:214).
 *
 * MUST run BEFORE any long-lived consumer (MCP server, daemon) opens the DB
 * and BEFORE the embeddings migration / soft-delete purge / ephemeral purge —
 * those all swallow corruption errors and silently no-op.
 */
import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { memoryDbPath } from './moflo-paths.mjs';
import { openBackend } from './get-backend.mjs';
import './suppress-sqlite-warning.mjs';
// Resolve node:sqlite once at module load — get-backend.mjs has already
// loaded it by this point, so the dynamic import is a cache hit. Avoids
// three independent `await import('node:sqlite')` calls inside the repair
// functions (style cleanup; was producing no functional difference).
const { DatabaseSync } = await import('node:sqlite');

function isOk(execResult) {
  const rows = execResult?.[0]?.values ?? [];
  return rows.length === 1 && rows[0]?.[0] === 'ok';
}

function corruptionCount(execResult) {
  return execResult?.[0]?.values?.length ?? 0;
}

/**
 * Open `.moflo/moflo.db` raw via node:sqlite in readonly mode and run
 * `PRAGMA integrity_check`. Bypasses {@link openBackend} because that path
 * sets `journal_mode=WAL`, `busy_timeout`, and `synchronous=NORMAL` on every
 * non-readonly open — those PRAGMAs can themselves throw against a corrupt
 * file, and the pre-#1090 code path caught those throws and reported the DB
 * as healthy. Readonly + no PRAGMAs = the probe always reaches the
 * `integrity_check` call regardless of file health.
 *
 * Exported so the TS doctor check (`checkMemoryDbIntegrity` in
 * `src/cli/commands/doctor-checks-config.ts`) can call into the same
 * implementation instead of re-deriving the readonly-no-PRAGMAs probe.
 *
 * @param {string} dbPath
 * @returns {Promise<{ ok: boolean, errors: number, openFailed?: boolean }>}
 */
export async function probeIntegrityRaw(dbPath) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return { ok: false, errors: 0, openFailed: true };
  }
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    if (rows.length === 1 && String(rows[0]?.integrity_check ?? '').toLowerCase() === 'ok') {
      return { ok: true, errors: 0 };
    }
    return { ok: false, errors: rows.length };
  } catch {
    return { ok: false, errors: 0, openFailed: true };
  } finally {
    try { db.close(); } catch { /* already-dead handle */ }
  }
}

/**
 * Tier-2 recovery: `VACUUM INTO` a fresh file. Single SQLite call that
 * iterates every row of every table and writes them to a brand-new database
 * with rebuilt indexes. Fails fast if iteration hits an unreadable page —
 * caller falls back to row-level salvage.
 *
 * @param {string} srcPath
 * @param {string} dstPath
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function tryVacuumInto(srcPath, dstPath) {
  try { if (existsSync(dstPath)) unlinkSync(dstPath); } catch { /* best effort */ }
  let db;
  try {
    // Open writable (not readonly) — VACUUM needs to checkpoint WAL first.
    // Skip our standard WAL pragmas (they can throw on corrupt files); SQLite
    // applies its defaults which are sufficient for VACUUM INTO.
    db = new DatabaseSync(srcPath);
  } catch (err) {
    return { ok: false, error: err?.message ?? 'open failed' };
  }
  try {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* corrupt WAL ok */ }
    db.exec(`VACUUM INTO '${dstPath.replace(/'/g, "''")}'`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? 'vacuum failed' };
  } finally {
    try { db.close(); } catch { /* */ }
  }
}

/**
 * Tier-3 recovery: row-level salvage. Iterate each non-empty table in
 * `rowid > ?` chunks; on any chunk-read failure, skip past that chunk's
 * rowid range and continue. Per-table loss stats returned so the caller can
 * surface what was preserved vs lost.
 *
 * Schema is copied verbatim from `sqlite_master.sql` so triggers/indexes/views
 * are preserved alongside tables. `INSERT OR IGNORE` handles unique-key
 * collisions from any duplicate-rowid corruption mode.
 *
 * @param {string} srcPath
 * @param {string} dstPath
 * @returns {Promise<{
 *   ok: boolean,
 *   error?: string,
 *   lossStats?: Record<string, { read: number, written: number, errors: number }>,
 * }>}
 */
async function trySalvageRowByRow(srcPath, dstPath) {
  try { if (existsSync(dstPath)) unlinkSync(dstPath); } catch { /* */ }

  let src;
  try {
    src = new DatabaseSync(srcPath, { readOnly: true });
  } catch (err) {
    return { ok: false, error: err?.message ?? 'src open failed' };
  }

  // Open dst defensively. If this throws (e.g. permissions, dst path in a
  // dir we can't create, or a concurrent lock on dstPath), keep the
  // "never throws" contract by returning the failure shape — otherwise the
  // open exception would escape past `repairMemoryDbIfCorrupt` and block
  // session start, which is the failure mode this whole module exists to
  // prevent.
  let dst;
  try {
    dst = new DatabaseSync(dstPath);
  } catch (err) {
    try { src.close(); } catch { /* */ }
    return { ok: false, error: err?.message ?? 'dst open failed' };
  }

  const lossStats = {};
  const CHUNK = 500;

  try {
    // Copy schema. Order matters: tables first (else indexes/triggers/views
    // reference nonexistent tables), then everything else. sqlite_* objects
    // (sqlite_sequence, sqlite_autoindex_*) are created implicitly by SQLite.
    const schemaRows = src
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master " +
          "WHERE sql IS NOT NULL ORDER BY CASE type " +
          "WHEN 'table' THEN 1 WHEN 'index' THEN 2 WHEN 'view' THEN 3 ELSE 4 END",
      )
      .all();
    for (const s of schemaRows) {
      if (String(s.name).startsWith('sqlite_')) continue;
      try { dst.exec(s.sql + ';'); } catch { /* malformed schema row — skip */ }
    }

    // Salvage rows table-by-table.
    const tables = src
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all();

    for (const t of tables) {
      const name = String(t.name);
      lossStats[name] = { read: 0, written: 0, errors: 0 };

      const cols = src.prepare(`PRAGMA table_info('${name.replace(/'/g, "''")}')`).all();
      if (cols.length === 0) continue;
      const colList = cols.map((c) => '"' + String(c.name).replace(/"/g, '""') + '"').join(',');
      const placeholders = cols.map(() => '?').join(',');
      const insert = dst.prepare(
        `INSERT OR IGNORE INTO "${name.replace(/"/g, '""')}" (${colList}) VALUES (${placeholders})`,
      );

      let lastRowid = 0;
      let safetyCap = 0;
      const MAX_ITERATIONS = 100_000;

      while (safetyCap++ < MAX_ITERATIONS) {
        let rows;
        try {
          rows = src
            .prepare(
              `SELECT rowid as __rid, * FROM "${name.replace(/"/g, '""')}" ` +
                `WHERE rowid > ? ORDER BY rowid LIMIT ${CHUNK}`,
            )
            .all(lastRowid);
        } catch {
          lossStats[name].errors++;
          lastRowid += CHUNK;
          continue;
        }
        if (!rows || rows.length === 0) break;
        lossStats[name].read += rows.length;
        for (const r of rows) {
          try {
            insert.run(...cols.map((c) => r[c.name]));
            lossStats[name].written++;
          } catch {
            lossStats[name].errors++;
          }
          lastRowid = Number(r.__rid);
        }
        if (rows.length < CHUNK) break;
      }
    }

    // Verify the recovered file. If integrity_check still fails, the
    // salvage didn't actually produce a clean file — surface as failure
    // (caller will keep the corrupted original in place).
    const checkRows = dst.prepare('PRAGMA integrity_check').all();
    const recoveredOk =
      checkRows.length === 1 &&
      String(checkRows[0]?.integrity_check ?? '').toLowerCase() === 'ok';
    if (!recoveredOk) {
      return { ok: false, error: 'recovered file failed integrity_check', lossStats };
    }
    return { ok: true, lossStats };
  } catch (err) {
    return { ok: false, error: err?.message ?? 'salvage failed' };
  } finally {
    try { src.close(); } catch { /* */ }
    try { dst.close(); } catch { /* */ }
  }
}

/**
 * Atomically swap a freshly recovered DB into the canonical path, keeping the
 * corrupted original (+ its WAL/SHM sidecars if present) under `.corrupt.<TS>`
 * suffixes for forensics. Caller must guarantee no live writer holds the
 * canonical file open before invoking this — see `stopWritersBeforeRepair`
 * for the daemon-coordinated entry point.
 *
 * @param {string} canonicalPath
 * @param {string} recoveredPath
 * @returns {{ ok: boolean, error?: string, corruptSuffix: string }}
 */
function atomicSwap(canonicalPath, recoveredPath) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const corruptSuffix = `.corrupt.${ts}`;
  try {
    if (existsSync(canonicalPath)) {
      renameSync(canonicalPath, canonicalPath + corruptSuffix);
    }
    const walPath = canonicalPath + '-wal';
    const shmPath = canonicalPath + '-shm';
    if (existsSync(walPath)) {
      try { renameSync(walPath, walPath + corruptSuffix); } catch { /* not always present */ }
    }
    if (existsSync(shmPath)) {
      try { renameSync(shmPath, shmPath + corruptSuffix); } catch { /* not always present */ }
    }
    renameSync(recoveredPath, canonicalPath);
    return { ok: true, corruptSuffix };
  } catch (err) {
    return { ok: false, error: err?.message ?? 'swap failed', corruptSuffix };
  }
}

/**
 * Probe the memory DB for corruption and run a tiered repair if found:
 *
 *  - Tier 1: `REINDEX` in place (index-only corruption — #743).
 *  - Tier 2: `VACUUM INTO` fresh file + atomic swap (table b-tree corruption).
 *  - Tier 3: row-level salvage + atomic swap (deep corruption with partial
 *    row loss).
 *
 * Returns a structured result:
 *  - `{ repaired: false, errors: 0 }` — healthy or absent.
 *  - `{ repaired: true, errors: N, tier: 'reindex' }` — Tier 1 worked.
 *  - `{ repaired: true, errors: N, tier: 'vacuum', corruptBackup }` — Tier 2.
 *  - `{ repaired: true, errors: N, tier: 'salvage', corruptBackup, lossStats }`
 *    — Tier 3 (partial row loss possible; see `lossStats`).
 *  - `{ repaired: false, errors: N, persistent: true }` — nothing worked;
 *    manual recovery needed.
 *
 * Never throws; any internal failure becomes `{ repaired: false, errors: 0 }`
 * so a probe failure cannot block session start.
 *
 * @param {string} projectRoot
 * @returns {Promise<{
 *   repaired: boolean,
 *   errors: number,
 *   tier?: 'reindex' | 'vacuum' | 'salvage',
 *   persistent?: boolean,
 *   corruptBackup?: string,
 *   lossStats?: Record<string, { read: number, written: number, errors: number }>,
 * }>}
 */
export async function repairMemoryDbIfCorrupt(projectRoot) {
  const dbPath = memoryDbPath(projectRoot);
  if (!existsSync(dbPath)) return { repaired: false, errors: 0 };

  // Step 1 — defensive readonly probe (cannot throw on WAL-setup errors
  // against corrupt files). If the open itself fails, fall through to the
  // openBackend path which has retry semantics for transient lock issues;
  // truly unopenable files surface as persistent below.
  const probe = await probeIntegrityRaw(dbPath);
  if (probe.ok) return { repaired: false, errors: 0 };

  const errors = probe.errors;

  // Step 2 — Tier 1: REINDEX via the existing backend path. Fast for the
  // common index-drift mode and preserves the file in place.
  if (!probe.openFailed) {
    try {
      const db = await openBackend(projectRoot, { create: false });
      try {
        db.run('REINDEX');
        const after = db.exec('PRAGMA integrity_check');
        if (isOk(after)) {
          db.save();
          return { repaired: true, errors, tier: 'reindex' };
        }
      } finally {
        try { db.close(); } catch { /* */ }
      }
    } catch {
      // REINDEX path failed (often because openBackend's WAL pragmas throw
      // on a corrupt file). Fall through to deeper recovery.
    }
  }

  // Step 3 — Tier 2: VACUUM INTO a fresh file.
  const recoveredPath = dbPath + '.recovered';
  const vacuum = await tryVacuumInto(dbPath, recoveredPath);
  if (vacuum.ok) {
    const recoveredProbe = await probeIntegrityRaw(recoveredPath);
    if (recoveredProbe.ok) {
      const swap = atomicSwap(dbPath, recoveredPath);
      if (swap.ok) {
        return {
          repaired: true,
          errors: errors || corruptionCount(recoveredProbe),
          tier: 'vacuum',
          corruptBackup: dbPath + swap.corruptSuffix,
        };
      }
    }
    try { unlinkSync(recoveredPath); } catch { /* */ }
  }

  // Step 4 — Tier 3: row-level salvage.
  const salvage = await trySalvageRowByRow(dbPath, recoveredPath);
  if (salvage.ok) {
    const swap = atomicSwap(dbPath, recoveredPath);
    if (swap.ok) {
      return {
        repaired: true,
        errors,
        tier: 'salvage',
        corruptBackup: dbPath + swap.corruptSuffix,
        lossStats: salvage.lossStats,
      };
    }
    try { unlinkSync(recoveredPath); } catch { /* */ }
  } else {
    try { if (existsSync(recoveredPath)) unlinkSync(recoveredPath); } catch { /* */ }
  }

  // Step 5 — give up.
  return { repaired: false, errors, persistent: true };
}
