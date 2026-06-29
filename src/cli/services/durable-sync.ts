/**
 * Cross-installation durable-memory sharing (#1232, epic #1231).
 *
 * Problem: `.moflo/` is gitignored, so every git worktree / Conductor
 * workspace of the same project starts with an empty `learnings` namespace —
 * durable knowledge is lost when a workspace rotates.
 *
 * Solution: an optional **durable-only** shared SQLite store (configured via
 * `memory.durable_path` in moflo.yaml or the `MOFLO_DURABLE_PATH` env). It
 * holds ONLY the durable namespaces ({@link DURABLE_NAMESPACES} — `learnings`,
 * `knowledge`). Each install keeps its own local `.moflo/moflo.db` for
 * structural + ephemeral namespaces (which are branch-specific and cheaply
 * re-indexable, so sharing them would churn/stale). Two flows keep the
 * durable slice in sync:
 *
 *   - **seed** (shared → local) on session-start, so a fresh workspace inherits
 *     accumulated learnings.
 *   - **flush / write-through** (local → shared) on session-start and after
 *     every durable write, so a new learning propagates to sibling workspaces
 *     by their next session-start.
 *
 * Both directions are a single call to {@link cherryPickLearningsFromLegacy}
 * with source/target swapped — it already copies durable rows with
 * `INSERT OR IGNORE` on `UNIQUE(namespace, key)` (conflict-free, idempotent,
 * embeddings carried forward verbatim). No new SQL lives here.
 *
 * Safety: the shared store is a plain transfer DB — moflo never *searches* it
 * directly, so it has no HNSW sidecar and no index-divergence concern. Row
 * writes are append-mostly and low-frequency (only `/meditate`, "remember
 * this", and auto-meditate write durable rows), and node:sqlite + WAL
 * serialises concurrent writers without the sql.js whole-file clobber that
 * older builds risked (see `cross-process-writer-race-1061.test.ts`).
 *
 * @module cli/services/durable-sync
 */

import * as fs from 'fs';
import * as path from 'path';
import { findProjectRoot } from './project-root.js';
import { normalizeProjectRoot } from './daemon-port.js';
import { memoryDbPath } from './moflo-paths.js';
import { loadMofloConfig, type MofloConfig } from '../config/moflo-config.js';
import {
  cherryPickLearningsFromLegacy,
  DURABLE_NAMESPACES,
  isDurableNamespace,
  type CherryPickResult,
} from './cherry-pick-learnings.js';

export { isDurableNamespace };

/** Per-direction outcome for {@link syncDurableAtSessionStart}. */
export interface DurableSyncReport {
  /** Resolved absolute durable-store path, or `null` when the feature is off. */
  durablePath: string | null;
  /** Reason the sync was a no-op, when `durablePath` is null. */
  skipped?: 'not-configured' | 'same-as-local';
  /** Rows copied local → shared (flush direction). */
  flushedToShared: number;
  /** Rows copied shared → local (seed direction). */
  seededToLocal: number;
}

/**
 * Resolve a path that may not exist yet to a stable absolute form for identity
 * comparison. Reuses {@link normalizeProjectRoot} (the #1145 reference impl) so
 * both sides of any comparison fold identically: it realpath's symlinks (macOS
 * `/var/folders` → `/private/var/folders`) and lowercases on Windows (NTFS is
 * case-insensitive). When the target doesn't exist yet — the common first-flush
 * case — we realpath the nearest existing parent and rejoin the tail so a
 * symlinked parent dir still normalises identically (Rule #1).
 */
function stableAbsolute(p: string): string {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) return normalizeProjectRoot(abs);
  return normalizeProjectRoot(path.join(normalizeProjectRoot(path.dirname(abs)), path.basename(abs)));
}

/**
 * Resolve the configured durable-store path to an absolute path, or `null`
 * when the feature is off (no env, no `memory.durable_path`) or misconfigured
 * (points at this project's own local DB — syncing a DB with itself is a
 * no-op, so we disable rather than thrash).
 *
 * Precedence: `MOFLO_DURABLE_PATH` env > `memory.durable_path` (moflo.yaml).
 * Relative values resolve against the project root.
 */
export function resolveDurablePath(
  projectRoot: string = findProjectRoot(),
  config?: MofloConfig,
): { path: string | null; skipped?: DurableSyncReport['skipped'] } {
  const envRaw = process.env.MOFLO_DURABLE_PATH?.trim();
  const cfgRaw = (config ?? loadMofloConfig(projectRoot)).memory.durable_path?.trim();
  const raw = envRaw && envRaw.length > 0 ? envRaw : cfgRaw;
  if (!raw) return { path: null, skipped: 'not-configured' };

  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectRoot, raw);
  // Self-reference guard — never let the shared store alias the local DB.
  if (stableAbsolute(abs) === stableAbsolute(memoryDbPath(projectRoot))) {
    return { path: null, skipped: 'same-as-local' };
  }
  return { path: abs };
}

/**
 * Seed durable rows from the shared store into this project's local DB.
 * Shared is the source, local `.moflo/moflo.db` the target. No-op when the
 * shared store doesn't exist yet (nothing to seed).
 */
export async function seedDurableFromShared(
  projectRoot: string,
  durablePath: string,
): Promise<CherryPickResult> {
  return cherryPickLearningsFromLegacy({
    projectRoot,
    legacyPaths: [durablePath],
    toPath: memoryDbPath(projectRoot),
    namespaces: DURABLE_NAMESPACES,
  });
}

/**
 * Flush durable rows from this project's local DB into the shared store.
 * Local is the source, the shared store the target (created on first flush).
 */
export async function flushDurableToShared(
  projectRoot: string,
  durablePath: string,
): Promise<CherryPickResult> {
  return cherryPickLearningsFromLegacy({
    projectRoot,
    legacyPaths: [memoryDbPath(projectRoot)],
    toPath: durablePath,
    namespaces: DURABLE_NAMESPACES,
  });
}

/**
 * Bidirectional durable sync run once at session-start: flush local → shared
 * (bootstraps pre-existing local learnings into the shared store), then seed
 * shared → local (pulls in sibling workspaces' learnings). Both directions are
 * `INSERT OR IGNORE`, so the result is the union of durable rows on both sides
 * with no conflicts. Safe to call unconditionally — a no-op when unconfigured.
 *
 * Intended to run BEFORE the daemon starts so the freshly-seeded rows are
 * present when the daemon builds its in-memory HNSW index.
 */
export async function syncDurableAtSessionStart(
  opts: { projectRoot?: string; config?: MofloConfig } = {},
): Promise<DurableSyncReport> {
  const projectRoot = opts.projectRoot ?? findProjectRoot();
  const { path: durablePath, skipped } = resolveDurablePath(projectRoot, opts.config);
  if (!durablePath) {
    return { durablePath: null, skipped, flushedToShared: 0, seededToLocal: 0 };
  }

  // Flush first so this worktree's existing learnings land in the shared store
  // before we seed — keeps the very first opt-in symmetric across workspaces.
  const flush = await flushDurableToShared(projectRoot, durablePath);
  const seed = await seedDurableFromShared(projectRoot, durablePath);
  return {
    durablePath,
    flushedToShared: flush.copied,
    seededToLocal: seed.copied,
  };
}

/**
 * Write-through hook: after a durable-namespace write lands in the local DB,
 * propagate the durable slice to the shared store so sibling workspaces see it
 * on their next session-start (or sooner). Best-effort and fully guarded — a
 * misconfigured or unreachable shared store never fails the original write.
 *
 * No-op (returns immediately, zero IO) when the namespace isn't durable or the
 * feature is off, so consumers without `durable_path` see byte-identical
 * behaviour to today.
 */
export async function writeThroughDurable(
  namespace: string,
  opts: { projectRoot?: string; config?: MofloConfig } = {},
): Promise<void> {
  if (!isDurableNamespace(namespace)) return;
  const projectRoot = opts.projectRoot ?? findProjectRoot();
  const { path: durablePath } = resolveDurablePath(projectRoot, opts.config);
  if (!durablePath) return;
  try {
    await flushDurableToShared(projectRoot, durablePath);
  } catch {
    // Write-through is advisory; the local write already succeeded. The next
    // session-start flush will reconcile. Never surface this to the caller.
  }
}
