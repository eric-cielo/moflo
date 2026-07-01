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

import * as path from 'path';
import * as fs from 'fs';
import { findProjectRoot } from './project-root.js';
import { stableAbsolute, pickConfiguredPath } from './configured-path.js';
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
  /**
   * True when the durable store was auto-derived from the git worktree layout
   * (no explicit `durable_path` / env), rather than user-configured. Lets the
   * launcher explain the first-time convergence to the user.
   */
  autoWorktree?: boolean;
}

/**
 * Resolve the git *common* directory for `projectRoot` — the shared `.git` that
 * every linked worktree of a repo points at — using filesystem reads only (no
 * `git` subprocess, so it's PATH-independent and cross-platform, Rule #1).
 *
 * - Primary checkout: `<root>/.git` is a directory → that IS the common dir.
 * - Linked worktree:  `<root>/.git` is a FILE (`gitdir: <main>/.git/worktrees/<id>`);
 *   the `commondir` file inside that gitdir points back to the shared `.git`.
 *
 * Returns `null` when `projectRoot` isn't a git repo root (or `.git` is
 * unreadable). The primary tree and all its worktrees resolve to the SAME path,
 * which is what lets an auto-derived shared store converge with zero config.
 */
export function resolveGitCommonDir(projectRoot: string): string | null {
  try {
    const dotgit = path.join(projectRoot, '.git');
    const st = fs.statSync(dotgit);
    if (st.isDirectory()) return dotgit;
    if (!st.isFile()) return null;
    const m = fs.readFileSync(dotgit, 'utf-8').match(/gitdir:\s*(.+)/);
    if (!m) return null;
    let gitdir = m[1].trim();
    if (!path.isAbsolute(gitdir)) gitdir = path.resolve(projectRoot, gitdir);
    // `<gitdir>/commondir` holds the (usually relative) path back to the shared
    // `.git`; git writes it for every linked worktree.
    const commondirFile = path.join(gitdir, 'commondir');
    if (fs.existsSync(commondirFile)) {
      let cd = fs.readFileSync(commondirFile, 'utf-8').trim();
      if (!path.isAbsolute(cd)) cd = path.resolve(gitdir, cd);
      return path.resolve(cd);
    }
    // Fallback for the standard `<main>/.git/worktrees/<id>` layout.
    return path.resolve(gitdir, '..', '..');
  } catch {
    return null;
  }
}

/**
 * Decide whether to AUTO-enable durable sharing for `projectRoot`, returning the
 * shared `.git` common dir to derive the store under — or `null` to stay off.
 *
 * Activates ONLY when git worktrees are actually in play, so a plain single
 * checkout writes nothing and behaves byte-identically to before. "In play" =
 * this checkout is itself a linked worktree, OR the shared `.git` has a
 * non-empty `worktrees/` registry (a sibling worktree exists).
 */
export function detectWorktreeCommonDir(projectRoot: string): string | null {
  const commonDir = resolveGitCommonDir(projectRoot);
  if (!commonDir) return null;
  let linkedHere = false;
  try {
    linkedHere = fs.statSync(path.join(projectRoot, '.git')).isFile();
  } catch {
    /* handled by resolveGitCommonDir returning null above */
  }
  if (linkedHere) return commonDir;
  try {
    const wt = path.join(commonDir, 'worktrees');
    if (fs.existsSync(wt) && fs.readdirSync(wt).length > 0) return commonDir;
  } catch {
    /* unreadable registry — treat as no worktrees */
  }
  return null;
}

/**
 * Resolve the durable-store path to an absolute path, or `null` when there's
 * nothing to sync.
 *
 * Precedence:
 *   1. Explicit config — `MOFLO_DURABLE_PATH` env > `memory.durable_path`
 *      (moflo.yaml). Relative values resolve against the project root.
 *   2. Auto worktree sharing — when NOTHING is explicitly configured, moflo's
 *      multi-worktree competency kicks in: if this checkout is part of a repo
 *      with git worktrees in play, derive a shared store at
 *      `<git-common-dir>/moflo/durable.db`. Every worktree of the repo resolves
 *      to the same path, so their learnings converge with zero config. Opt out
 *      with `memory.worktree_sharing: false`. A single checkout (no worktrees)
 *      derives nothing and stays byte-identical to before.
 *
 * A store that aliases this project's own local DB is rejected (syncing a DB
 * with itself is a no-op). Path-pick + symlink-stable identity live in
 * {@link pickConfiguredPath}/{@link stableAbsolute}.
 */
export function resolveDurablePath(
  projectRoot: string = findProjectRoot(),
  config?: MofloConfig,
): { path: string | null; skipped?: DurableSyncReport['skipped']; autoWorktree?: boolean } {
  const cfg = config ?? loadMofloConfig(projectRoot);
  const local = () => stableAbsolute(memoryDbPath(projectRoot));

  const abs = pickConfiguredPath(process.env.MOFLO_DURABLE_PATH, cfg.memory.durable_path, projectRoot);
  if (abs) {
    // Self-reference guard — never let the shared store alias the local DB.
    if (stableAbsolute(abs) === local()) {
      return { path: null, skipped: 'same-as-local' };
    }
    return { path: abs };
  }

  // No explicit config → auto-share across git worktrees unless opted out.
  if (cfg.memory.worktree_sharing !== false) {
    const commonDir = detectWorktreeCommonDir(projectRoot);
    if (commonDir) {
      const derived = path.join(commonDir, 'moflo', 'durable.db');
      // Paranoia guard — a derived path should never alias the local DB, but a
      // pathological `.git` layout shouldn't turn into a self-sync.
      if (stableAbsolute(derived) !== local()) {
        return { path: derived, autoWorktree: true };
      }
    }
  }
  return { path: null, skipped: 'not-configured' };
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
  // Ensure the parent dir exists — auto-derived worktree stores live under
  // `<git-common-dir>/moflo/`, which won't exist on the very first flush.
  try {
    fs.mkdirSync(path.dirname(durablePath), { recursive: true });
  } catch {
    /* a real open failure surfaces from cherry-pick below */
  }
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
  const { path: durablePath, skipped, autoWorktree } = resolveDurablePath(projectRoot, opts.config);
  if (!durablePath) {
    return { durablePath: null, skipped, flushedToShared: 0, seededToLocal: 0 };
  }

  // Flush first so this worktree's existing learnings land in the shared store
  // before we seed — keeps the very first opt-in symmetric across workspaces.
  const flush = await flushDurableToShared(projectRoot, durablePath);
  const seed = await seedDurableFromShared(projectRoot, durablePath);
  return {
    durablePath,
    autoWorktree: autoWorktree ?? false,
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
  try {
    // Everything after the cheap namespace check is inside the guard: a throw
    // from findProjectRoot / loadMofloConfig (inside resolveDurablePath) / the
    // flush must NEVER fail the caller's write, which has already persisted.
    // Write-through is advisory — the next session-start flush reconciles.
    const projectRoot = opts.projectRoot ?? findProjectRoot();
    const { path: durablePath } = resolveDurablePath(projectRoot, opts.config);
    if (!durablePath) return;
    await flushDurableToShared(projectRoot, durablePath);
  } catch {
    // Swallow entirely — see the rationale above.
  }
}
