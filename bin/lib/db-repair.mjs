/**
 * Memory-DB integrity check + auto-REINDEX (story #743).
 *
 * The `.moflo/moflo.db` SQLite file routinely accumulates index corruption of
 * the form `row N missing from index sqlite_autoindex_memory_entries_1` —
 * the row data is intact, only the unique-key index has drifted. The most
 * common trigger is sql.js's whole-file dump-on-flush behaviour racing with
 * concurrent writes (see `feedback_sqljs_writeback_clobber.md` and #714).
 *
 * Symptoms when uncorrected:
 *  - `index-guidance.mjs` and `index-patterns.mjs` fail mid-write with
 *    `database disk image is malformed`, leaving partial state.
 *  - The ephemeral-namespace purge (#729) fails silently, so hive-mind /
 *    tasklist / epic-state / test-bridge-fix rows accumulate.
 *  - Vector counts in the statusline stay inflated (observed: 4415 with
 *    1025 unpurged ephemeral rows).
 *
 * Fix shape: REINDEX rebuilds indexes from the canonical row data — much less
 * destructive than a full rebuild and works for the typical drift mode. If
 * REINDEX itself fails to restore integrity we leave the file alone and
 * report; manual `flo memory rebuild-index` is the fallback.
 *
 * MUST run BEFORE any long-lived sql.js consumer (MCP server, daemon) opens
 * the DB and BEFORE the embeddings migration / soft-delete purge / ephemeral
 * purge — those all swallow corruption errors and silently no-op.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { memoryDbPath } from './moflo-paths.mjs';

let _initSqlJs = null;

async function loadSqlJs() {
  if (_initSqlJs) return _initSqlJs;
  // sql.js is a hard dependency of moflo (see top-level package.json);
  // resolving it from the consumer's node_modules works because the launcher
  // runs from the consumer cwd.
  const mod = await import('sql.js');
  _initSqlJs = mod.default || mod;
  return _initSqlJs;
}

function isOk(execResult) {
  const rows = execResult?.[0]?.values ?? [];
  return rows.length === 1 && rows[0]?.[0] === 'ok';
}

function corruptionCount(execResult) {
  return execResult?.[0]?.values?.length ?? 0;
}

/**
 * Probe the memory DB for index corruption and run REINDEX in place if
 * found. Returns `{ repaired, errors, persistent }`:
 *  - `repaired: true` and `errors > 0` when REINDEX restored integrity.
 *  - `repaired: false, errors: 0` when the DB is healthy or absent.
 *  - `repaired: false, errors > 0, persistent: true` when corruption survives
 *    REINDEX (caller should surface to the user — manual rebuild needed).
 *
 * Never throws; any internal failure becomes `{ repaired: false, errors: 0 }`
 * so a probe failure cannot block session start.
 */
export async function repairMemoryDbIfCorrupt(projectRoot) {
  const dbPath = memoryDbPath(projectRoot);
  if (!existsSync(dbPath)) return { repaired: false, errors: 0 };

  let initSql;
  try {
    initSql = await loadSqlJs();
  } catch {
    return { repaired: false, errors: 0 };
  }

  let db = null;
  try {
    const SQL = await initSql();
    const data = readFileSync(dbPath);
    db = new SQL.Database(data);

    const before = db.exec('PRAGMA integrity_check');
    if (isOk(before)) {
      return { repaired: false, errors: 0 };
    }

    const errors = corruptionCount(before);
    db.run('REINDEX');

    const after = db.exec('PRAGMA integrity_check');
    if (!isOk(after)) {
      return { repaired: false, errors, persistent: true };
    }

    const out = Buffer.from(db.export());
    writeFileSync(dbPath, out);
    return { repaired: true, errors };
  } catch {
    return { repaired: false, errors: 0 };
  } finally {
    if (db) try { db.close(); } catch { /* non-fatal */ }
  }
}
