/**
 * Whole-DB snapshot backup / restore for fast workspace hydration (#1244, epic #1231).
 *
 * Problem: the durable-slice sharing (#1232–#1234) deliberately shares only
 * `learnings`/`knowledge`, on the premise that structural namespaces "rebuild
 * cheaply from the indexers". That premise is FALSE on the cold first pass: an
 * empty `.moflo/moflo.db` gives session-start `index-all` nothing to hash-skip,
 * so it does the full expensive work — parse every file for `code-map` /
 * `patterns` / `tests`, chunk all `guidance`, AND run ONNX embedding generation
 * over all of it. On a large repo that is minutes, not "cheap".
 *
 * Solution: a one-time whole-DB SNAPSHOT restore that seeds a fresh/empty
 * workspace with a complete DB (structural + durable + embeddings), skipping
 * both the parse and the embed. This is NOT the forbidden whole-DB *live*
 * sharing (see `flo doctor -c shared-db`):
 *
 *   - **Live-sharing** one DB between two running daemons is unsafe — each
 *     daemon holds its own in-memory HNSW index; concurrent writes never
 *     propagate, so search silently goes stale.
 *   - **Snapshot-restore** is safe — after restore each workspace owns its OWN
 *     copy. There is no second concurrent daemon, so no index divergence, and
 *     branch drift self-heals via the existing incremental (hash-based) reindex.
 *
 * Composes with #1232–#1234: snapshot-restore gives fast cold-start; durable-
 * slice sharing keeps `learnings` continuously converged afterwards.
 *
 * Safety rails:
 *   - **No clobber.** Restore is a no-op when the local DB already has content,
 *     unless `force` is explicitly set. A freshly-hydrated workspace never
 *     overwrites an active one.
 *   - **Single clean file.** Backup uses `VACUUM INTO`, which writes a fully
 *     consistent standalone copy of the committed DB regardless of WAL state or
 *     a concurrent daemon — the snapshot is a self-contained single file with
 *     no `-wal`/`-shm` dependency, and there's no torn-read window.
 *   - **No stale sidecars.** Restore strips any leftover `-wal`/`-shm` on the
 *     local DB AFTER the swap so the restored bytes aren't shadowed by an old
 *     WAL (and the original's WAL frames aren't dropped on a mid-restore crash).
 *   - **No ephemeral leak.** After restore, ephemeral namespaces
 *     (`hive-mind`, epic-state, tasklist trim, …) are purged so a source
 *     workspace's run-state never bleeds into the hydrated one.
 *   - **Before the daemon.** {@link hydrateAtSessionStart} runs in the same
 *     session-start slot as the seed/cherry-pick blocks — before the daemon
 *     spawns — so there's no two-writer / stale-snapshot race.
 *
 * Cross-platform (Rule #1): all IO is `node:fs`; restore is read-bytes +
 * {@link atomicWriteFileSync} (temp-write → fsync → rename), never a shelled
 * `cp`. Backup's `VACUUM INTO` + atomic rename goes through node:sqlite.
 *
 * @module cli/services/snapshot-restore
 */

import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { findProjectRoot } from './project-root.js';
import { memoryDbPath } from './moflo-paths.js';
import { stableAbsolute, pickConfiguredPath } from './configured-path.js';
import { loadMofloConfig, type MofloConfig } from '../config/moflo-config.js';
import { openDaemonDatabase, type SqlJsLikeDatabase } from '../memory/daemon-backend.js';
import { atomicWriteFileSync } from '../shared/utils/atomic-file-write.js';
import { hasMemoryEntriesTable } from './cherry-pick-learnings.js';

/** WAL sidecar files SQLite keeps next to the main DB. */
function sidecarPaths(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`];
}

/** Remove `-wal`/`-shm` sidecars best-effort so they can't shadow new bytes. */
function removeSidecars(dbPath: string): void {
  for (const p of sidecarPaths(dbPath)) {
    try {
      if (fs.existsSync(p)) fs.rmSync(p);
    } catch {
      /* best-effort — a leftover empty sidecar is harmless on re-open */
    }
  }
}

/** A backup tmp older than this is certainly orphaned (a live vacuum is seconds). */
const STALE_SNAPSHOT_TMP_AGE_MS = 60_000;

/**
 * Best-effort sweep of orphaned `${target}.tmp.<pid>.<rand>` files left by a
 * backup whose process was SIGKILLed mid-`VACUUM INTO` (e.g. the auto-snapshot
 * ran inside a session-start hook that hit its timeout — see launcher §3e-1244b).
 * Only files older than {@link STALE_SNAPSHOT_TMP_AGE_MS} are removed, so a
 * concurrent in-flight backup's tmp on the same target is never deleted.
 */
function sweepStaleSnapshotTmp(target: string): void {
  try {
    const dir = path.dirname(target);
    const prefix = `${path.basename(target)}.tmp.`;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const p = path.join(dir, name);
      try {
        if (now - fs.statSync(p).mtimeMs > STALE_SNAPSHOT_TMP_AGE_MS) fs.rmSync(p);
      } catch {
        /* best-effort — racing another sweep or a live backup is harmless */
      }
    }
  } catch {
    /* dir missing / unreadable — nothing to sweep */
  }
}

/**
 * True when `file` is a SQLite DB carrying a `memory_entries` table. Opens
 * READ-ONLY on purpose: `openDaemonDatabase` forces `journal_mode=WAL`, which
 * would write the file's header and litter `-wal`/`-shm` next to a snapshot we
 * only want to inspect (and throw on read-only media). A read-only handle
 * validates without mutating. Returns false for a missing/unreadable/non-moflo
 * file rather than throwing.
 */
function fileHasMemoryEntries(file: string): boolean {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries' LIMIT 1`)
      .get();
    return Boolean(row);
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** Count rows in `memory_entries`, or `null` when the table/DB is absent. */
function countMemoryRows(db: SqlJsLikeDatabase): number | null {
  if (!hasMemoryEntriesTable(db)) return null;
  const rows = db.exec('SELECT COUNT(*) FROM memory_entries');
  const n = rows[0]?.values?.[0]?.[0];
  return typeof n === 'number' ? n : Number(n ?? 0);
}

/**
 * True when the local DB exists AND holds at least one `memory_entries` row.
 * A missing file, a schema-less file, or a zero-row DB all count as "empty" —
 * the only states where an unforced restore is allowed to seed.
 */
export function localDbHasContent(projectRoot: string = findProjectRoot()): boolean {
  const dbPath = memoryDbPath(projectRoot);
  if (!fs.existsSync(dbPath)) return false;
  let db: SqlJsLikeDatabase | null = null;
  try {
    db = openDaemonDatabase(dbPath);
    return (countMemoryRows(db) ?? 0) > 0;
  } catch {
    // Unreadable/corrupt local DB — treat as no usable content so a restore
    // can replace it (the no-clobber guard protects only *valid* content).
    return false;
  } finally {
    db?.close();
  }
}

export interface BackupSnapshotOptions {
  projectRoot?: string;
  /** Destination snapshot path. */
  toPath: string;
}

export interface BackupSnapshotResult {
  /** Resolved local DB the snapshot was taken from. */
  source: string;
  /** Resolved snapshot path written. */
  target: string;
  /** Snapshot size in bytes. */
  bytes: number;
}

/**
 * Take a consistent whole-DB snapshot of the local `.moflo/moflo.db`.
 *
 * Uses `VACUUM INTO` — SQLite generates a fully-consistent standalone copy of
 * the committed database into a fresh file, regardless of WAL state or a
 * concurrent daemon holding the WAL. This avoids the
 * checkpoint-then-`readFileSync` hazard (a `wal_checkpoint(TRUNCATE)` can come
 * back `busy` leaving data in the `-wal`, and a concurrent checkpoint can
 * rewrite the main file mid-read → torn copy). The vacuum lands on a
 * process-unique temp path, which is then atomically renamed onto `toPath`, so
 * a crash never leaves a half-written snapshot in place. The result is a
 * single self-contained file with no sidecar dependency.
 *
 * Throws when there is no local DB to back up, when `toPath` aliases the source
 * (symlink-aware), or when the produced snapshot fails validation.
 */
export function backupSnapshot(options: BackupSnapshotOptions): BackupSnapshotResult {
  const projectRoot = options.projectRoot ?? findProjectRoot();
  const source = path.resolve(memoryDbPath(projectRoot));
  const target = path.resolve(options.toPath);

  if (!fs.existsSync(source)) {
    throw new Error(`No local memory DB at ${source} — nothing to back up yet.`);
  }
  // Symlink-aware self-reference guard (Rule #1 / #1145) — a symlinked --to
  // must not resolve back onto the live DB and VACUUM INTO over it.
  if (stableAbsolute(target) === stableAbsolute(source)) {
    throw new Error('--to path is the local memory DB itself — choose a different snapshot path.');
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  sweepStaleSnapshotTmp(target);
  const tmp = `${target}.tmp.${process.pid}.${process.hrtime.bigint().toString(36)}`;
  try {
    if (fs.existsSync(tmp)) fs.rmSync(tmp);
    const db = openDaemonDatabase(source);
    try {
      // VACUUM INTO takes a SQL string literal, not a bound param — double any
      // single quote in the path so a quote in the dir name can't break out.
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
    // Guard against a torn/empty vacuum before we publish it.
    if (!fileHasMemoryEntries(tmp)) {
      throw new Error('snapshot validation failed — produced file has no memory_entries table.');
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }

  return { source, target, bytes: fs.statSync(target).size };
}

/** Why a restore did not seed the local DB. */
export const RESTORE_SKIP_REASONS = {
  NOT_CONFIGURED: 'not-configured',
  SNAPSHOT_MISSING: 'snapshot-missing',
  INVALID_SNAPSHOT: 'invalid-snapshot',
  LOCAL_NOT_EMPTY: 'local-not-empty',
  SELF_REFERENCE: 'self-reference',
} as const;
export type RestoreSkipReason = (typeof RESTORE_SKIP_REASONS)[keyof typeof RESTORE_SKIP_REASONS];

export interface RestoreSnapshotOptions {
  projectRoot?: string;
  /** Snapshot file to restore from. */
  fromPath: string;
  /** Overwrite even when the local DB already has content (default false). */
  force?: boolean;
}

export interface RestoreSnapshotResult {
  /** True when the local DB was replaced from the snapshot. */
  restored: boolean;
  /** Set when `restored` is false. */
  reason?: RestoreSkipReason;
  /** Resolved local DB path. */
  target: string;
  /** Snapshot size in bytes (when restored). */
  bytes?: number;
  /** Ephemeral rows purged from the restored DB. */
  purged?: number;
}

/**
 * Restore a whole-DB snapshot into the local `.moflo/moflo.db`, seeding a
 * fresh workspace with structural + durable + embedding data so its first
 * session is searchable without a cold reindex.
 *
 * No-clobber: returns `{ restored: false, reason: 'local-not-empty' }` when the
 * local DB already has rows, unless `force` is set. The snapshot is validated
 * (must carry `memory_entries`) before any local bytes are touched. After a
 * successful restore, ephemeral namespaces are purged so the source workspace's
 * run-state never leaks in.
 */
export async function restoreSnapshot(
  options: RestoreSnapshotOptions,
): Promise<RestoreSnapshotResult> {
  const projectRoot = options.projectRoot ?? findProjectRoot();
  const target = path.resolve(memoryDbPath(projectRoot));
  const from = path.resolve(options.fromPath);

  // Symlink-aware self-reference guard (Rule #1 / #1145).
  if (stableAbsolute(from) === stableAbsolute(target)) {
    return { restored: false, reason: RESTORE_SKIP_REASONS.SELF_REFERENCE, target };
  }
  if (!fs.existsSync(from)) {
    return { restored: false, reason: RESTORE_SKIP_REASONS.SNAPSHOT_MISSING, target };
  }
  if (!options.force && localDbHasContent(projectRoot)) {
    return { restored: false, reason: RESTORE_SKIP_REASONS.LOCAL_NOT_EMPTY, target };
  }

  // Validate the snapshot carries the durable schema BEFORE touching local
  // bytes — read-only so we never mutate (or sidecar-litter) the source.
  if (!fileHasMemoryEntries(from)) {
    return { restored: false, reason: RESTORE_SKIP_REASONS.INVALID_SNAPSHOT, target };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Atomic-swap the snapshot's bytes onto the local DB, THEN strip any stale
  // `-wal`/`-shm` so the old WAL can't be replayed onto the new file. (Removing
  // sidecars BEFORE the swap would, under --force, drop the original DB's
  // uncheckpointed WAL frames if the process died mid-restore.)
  const bytes = fs.readFileSync(from);
  atomicWriteFileSync(target, bytes);
  removeSidecars(target);

  // Strip the source workspace's ephemeral run-state from the restored copy.
  let purged = 0;
  try {
    const { purgeEphemeralNamespaces } = await import('./ephemeral-namespace-purge.js');
    const result = await purgeEphemeralNamespaces({ dbPath: target });
    purged = (result?.purged ?? 0) + (result?.trimmed ?? 0);
  } catch {
    // Non-fatal — a leftover ephemeral row is harmless and the next session
    // start's standalone purge sweeps it.
  }

  return { restored: true, target, bytes: bytes.length, purged };
}

/**
 * Resolve the configured hydrate-from snapshot path, or `null` when the feature
 * is off. Precedence: `MOFLO_HYDRATE_FROM` env > `memory.hydrate_from`
 * (moflo.yaml). Relative values resolve against the project root.
 */
export function resolveHydratePath(
  projectRoot: string = findProjectRoot(),
  config?: MofloConfig,
): string | null {
  return pickConfiguredPath(
    process.env.MOFLO_HYDRATE_FROM,
    (config ?? loadMofloConfig(projectRoot)).memory.hydrate_from,
    projectRoot,
  );
}

/**
 * Session-start auto-hydrate: when `memory.hydrate_from` (or
 * `MOFLO_HYDRATE_FROM`) points at a snapshot AND the local DB is empty, restore
 * it. Runs BEFORE the daemon spawns (same slot as the durable-sync /
 * cherry-pick blocks) so the seeded rows are present when the daemon builds its
 * in-memory HNSW index. A no-op when unconfigured or the local DB already has
 * content. Best-effort: callers swallow throws so hydration never blocks start.
 */
export async function hydrateAtSessionStart(
  opts: { projectRoot?: string; config?: MofloConfig } = {},
): Promise<RestoreSnapshotResult> {
  const projectRoot = opts.projectRoot ?? findProjectRoot();
  const target = path.resolve(memoryDbPath(projectRoot));
  const from = resolveHydratePath(projectRoot, opts.config);
  if (!from) {
    return { restored: false, reason: RESTORE_SKIP_REASONS.NOT_CONFIGURED, target };
  }
  // force stays false — auto-hydrate must never clobber an active workspace.
  return restoreSnapshot({ projectRoot, fromPath: from });
}

// ── Producer side: auto-snapshot (#1244) ────────────────────────────────────

/** Why an auto-snapshot did not produce a fresh seed. */
export const SNAPSHOT_SKIP_REASONS = {
  NOT_CONFIGURED: 'not-configured',
  LINKED_WORKTREE: 'linked-worktree',
  NO_LOCAL_DB: 'no-local-db',
  SELF_REFERENCE: 'self-reference',
  FRESH: 'fresh',
} as const;
export type SnapshotSkipReason = (typeof SNAPSHOT_SKIP_REASONS)[keyof typeof SNAPSHOT_SKIP_REASONS];

export interface AutoSnapshotResult {
  /** True when a fresh snapshot was written to the configured path. */
  snapshotted: boolean;
  /** Set when `snapshotted` is false. */
  reason?: SnapshotSkipReason;
  /** Resolved snapshot path (when configured). */
  target?: string;
  /** Snapshot size in bytes (when produced). */
  bytes?: number;
}

/**
 * Resolve the configured auto-snapshot destination, or `null` when off.
 * Precedence: `MOFLO_SNAPSHOT_TO` env > `memory.snapshot_to` (moflo.yaml).
 * Relative values resolve against the project root. Pure path work, no IO.
 */
export function resolveSnapshotToPath(
  projectRoot: string = findProjectRoot(),
  config?: MofloConfig,
): string | null {
  return pickConfiguredPath(
    process.env.MOFLO_SNAPSHOT_TO,
    (config ?? loadMofloConfig(projectRoot)).memory.snapshot_to,
    projectRoot,
  );
}

/**
 * True when `projectRoot` is a **linked** git worktree (a Conductor workspace),
 * as opposed to the primary working tree. A linked worktree's `.git` is a FILE
 * containing `gitdir: <common>/worktrees/<id>`; the primary's `.git` is a
 * DIRECTORY. A submodule's `.git` is also a file but points at `<super>/modules/
 * <name>` (no `worktrees` segment), so it reads as primary. A missing `.git`
 * (standalone project) also reads as primary. Pure `node:fs` — no git shell-out
 * (Rule #1). This is the gate that stops N Conductor workspaces from each
 * overwriting the shared seed with their own branch-drifted copy.
 */
export function isLinkedWorktree(projectRoot: string = findProjectRoot()): boolean {
  try {
    const dotgit = path.join(projectRoot, '.git');
    const st = fs.statSync(dotgit);
    if (!st.isFile()) return false; // directory (primary) or other → not linked
    const m = fs.readFileSync(dotgit, 'utf-8').match(/gitdir:\s*(.+)/);
    if (!m) return false;
    // Match a `worktrees` path segment on either separator (Rule #1).
    return /[\\/]worktrees[\\/]/.test(m[1].trim());
  } catch {
    return false; // no/unreadable .git → treat as primary (safe to produce)
  }
}

/** Newest mtime across the DB and its `-wal`/`-shm` sidecars (WAL writes don't
 * touch the main file's mtime, so the sidecars must be considered to tell
 * whether the DB has advanced). Returns 0 when none exist. */
function latestSourceMtimeMs(source: string): number {
  let latest = 0;
  for (const p of [source, ...sidecarPaths(source)]) {
    try {
      if (fs.existsSync(p)) latest = Math.max(latest, fs.statSync(p).mtimeMs);
    } catch {
      /* unreadable — ignore */
    }
  }
  return latest;
}

/**
 * True when the snapshot at `snapshot` is at least as new as the live DB
 * (including its WAL sidecars) — i.e. the DB has NOT advanced since the last
 * snapshot, so re-producing would be wasted work. A missing snapshot is never
 * fresh. mtime comparison only — no content hash, no arbitrary TTL.
 */
function isSnapshotFresh(snapshot: string, source: string): boolean {
  try {
    if (!fs.existsSync(snapshot)) return false;
    return fs.statSync(snapshot).mtimeMs >= latestSourceMtimeMs(source);
  } catch {
    return false; // can't tell → err toward producing
  }
}

/**
 * Session-start auto-snapshot: when `memory.snapshot_to` (or `MOFLO_SNAPSHOT_TO`)
 * is set, refresh that whole-DB snapshot so fresh worktrees hydrating via
 * {@link hydrateAtSessionStart} always seed from a current copy. The producer
 * side of {@link hydrateAtSessionStart}; set both to the same path for the
 * Conductor recipe.
 *
 * Gated, in order: unconfigured → no-op; a linked git worktree (Conductor
 * workspace) never produces (only the primary checkout does); no local DB →
 * nothing to snapshot; self-reference (path aliases the live DB, symlink-aware)
 * → skip; snapshot already current (DB hasn't advanced) → skip. Otherwise takes
 * a consistent {@link backupSnapshot}. Best-effort: callers swallow throws so a
 * backup failure never blocks session start.
 */
export async function autoSnapshotAtSessionStart(
  opts: { projectRoot?: string; config?: MofloConfig } = {},
): Promise<AutoSnapshotResult> {
  const projectRoot = opts.projectRoot ?? findProjectRoot();
  const to = resolveSnapshotToPath(projectRoot, opts.config);
  if (!to) return { snapshotted: false, reason: SNAPSHOT_SKIP_REASONS.NOT_CONFIGURED };
  if (isLinkedWorktree(projectRoot)) {
    return { snapshotted: false, reason: SNAPSHOT_SKIP_REASONS.LINKED_WORKTREE, target: to };
  }

  const source = path.resolve(memoryDbPath(projectRoot));
  if (!fs.existsSync(source)) {
    return { snapshotted: false, reason: SNAPSHOT_SKIP_REASONS.NO_LOCAL_DB, target: to };
  }
  // Never VACUUM INTO over the live DB itself (symlink-aware, Rule #1 / #1145).
  if (stableAbsolute(to) === stableAbsolute(source)) {
    return { snapshotted: false, reason: SNAPSHOT_SKIP_REASONS.SELF_REFERENCE, target: to };
  }
  if (isSnapshotFresh(to, source)) {
    return { snapshotted: false, reason: SNAPSHOT_SKIP_REASONS.FRESH, target: to };
  }

  const result = backupSnapshot({ projectRoot, toPath: to });
  return { snapshotted: true, target: result.target, bytes: result.bytes };
}
