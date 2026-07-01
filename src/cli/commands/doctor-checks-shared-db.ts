/**
 * Doctor check: shared full-`moflo.db` detection (#1235, epic #1231).
 *
 * Cross-installation learning-sharing is SAFE when only the durable slice
 * (`learnings`, `knowledge`) travels — via `memory.durable_path` (#1232),
 * `flo memory sync` (#1233), or the git-tracked team artifact (#1234). It is
 * UNSAFE to share the *whole* `moflo.db` between two installs (two git
 * worktrees, two Conductor workspaces, a symlinked `.moflo/`): node:sqlite+WAL
 * keeps concurrent writers from losing rows, but each daemon builds its own
 * in-memory HNSW index, so a write from install A never updates install B's
 * index — searches silently return stale results, and the structural namespaces
 * (`code-map`, guidance chunks) churn across branches.
 *
 * This check warns when the project is *configured toward* a shared full DB and
 * blesses the durable-only setup (no warning). It is pure `fs` (realpath +
 * lstat) — no shelling to `grep`/`ps` (Rule #1).
 *
 * @module cli/commands/doctor-checks-shared-db
 */

import * as fs from 'fs';
import * as path from 'path';
import { memoryDbPath } from '../services/moflo-paths.js';
import { findProjectRoot } from '../services/project-root.js';
import { loadMofloConfig, type MofloConfig } from '../config/moflo-config.js';
import { resolveDurablePath } from '../services/durable-sync.js';
import { errorDetail } from '../shared/utils/error-detail.js';
import type { HealthCheck } from './doctor-types.js';

const NAME = 'Shared Full DB';

/**
 * Resolve a path through symlinks for identity comparison. Realpaths BOTH sides
 * of any later `===` (macOS `/var`→`/private/var`, Windows case-fold) per Rule #1;
 * falls back to the absolute literal when the target doesn't exist yet.
 */
function realOrAbs(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * True when `p` resolves to a full `moflo.db`. Compared case-insensitively —
 * Windows + macOS filesystems are case-insensitive, so a `durable_path` of
 * `MOFLO.DB` is still a full DB (Rule #1). Any path ending in `.../moflo.db`
 * has basename `moflo.db`, so basename alone covers the nested case too.
 */
function looksLikeFullDb(absPath: string): boolean {
  return path.basename(absPath).toLowerCase() === 'moflo.db';
}

export async function checkSharedFullDb(deps?: {
  root?: string;
  config?: MofloConfig;
}): Promise<HealthCheck> {
  try {
    const root = deps?.root ?? findProjectRoot();
    const localDb = memoryDbPath(root);
    const config = deps?.config ?? loadMofloConfig(root);
    // `durable_path` ships in #1232 and may not exist in the config type on a
    // branch without it — read defensively so this check stands alone.
    const mem = config.memory as { durable_path?: string };
    const durableRaw = typeof mem.durable_path === 'string' ? mem.durable_path.trim() : '';

    // 1. A symlinked local moflo.db is the classic "two installs, one full DB"
    //    setup (a symlinked `.moflo/` across Conductor workspaces / worktrees).
    if (fs.existsSync(localDb)) {
      let isLink = false;
      try {
        isLink = fs.lstatSync(localDb).isSymbolicLink();
      } catch {
        /* lstat race / perms — treat as not-a-link */
      }
      if (isLink) {
        return {
          name: NAME,
          status: 'warn',
          message:
            `${localDb} is a symlink — sharing one full moflo.db across installs makes each daemon's ` +
            `in-memory HNSW index diverge, so search returns stale results (node:sqlite+WAL prevents row ` +
            `loss, not index drift). Keep a local DB and share only the durable slice via memory.durable_path.`,
          fix: 'Replace the symlinked moflo.db with a real local DB, then set memory.durable_path to a dedicated durable-only store.',
        };
      }
    }

    // 2. `durable_path` pointed at a FULL moflo.db (aliases the local DB, or is
    //    itself a canonical .moflo/moflo.db) — that shares the whole DB, the very
    //    thing durable-only sharing exists to avoid.
    if (durableRaw) {
      const absDurable = path.isAbsolute(durableRaw) ? path.resolve(durableRaw) : path.resolve(root, durableRaw);
      const aliasesLocal =
        fs.existsSync(absDurable) && fs.existsSync(localDb) && realOrAbs(absDurable) === realOrAbs(localDb);
      if (aliasesLocal || looksLikeFullDb(absDurable)) {
        return {
          name: NAME,
          status: 'warn',
          message:
            `memory.durable_path (${durableRaw}) points at a full moflo.db — that shares the whole database, ` +
            `causing HNSW index divergence / stale search across installs. Point it at a dedicated durable-only ` +
            `store (a file NOT named moflo.db) so only learnings/knowledge travel.`,
          fix: 'Set memory.durable_path to a dedicated file such as <shared>/moflo-learnings.db (not a full moflo.db).',
        };
      }
      // Blessed: a dedicated durable-only store. Structural namespaces stay local.
      return {
        name: NAME,
        status: 'pass',
        message: `Durable-only shared store configured (${durableRaw}) — safe; structural namespaces stay local.`,
      };
    }

    // 3. No explicit durable_path — surface automatic worktree sharing when it's
    //    active, so the default-on behavior is visible (and reassuringly safe:
    //    the derived store is a dedicated durable.db, never a full moflo.db).
    const auto = resolveDurablePath(root, config);
    if (auto.autoWorktree && auto.path) {
      return {
        name: NAME,
        status: 'pass',
        message:
          `Automatic worktree learning sharing active (${auto.path}) — durable learnings converge across this ` +
          `repo's git worktrees; structural namespaces stay local. Set memory.worktree_sharing: false to disable.`,
      };
    }

    return {
      name: NAME,
      status: 'pass',
      message: 'No shared full moflo.db detected (local DB is not symlinked; no durable_path override).',
    };
  } catch (e) {
    return {
      name: NAME,
      status: 'warn',
      message: `Unable to check shared-DB config: ${errorDetail(e, { firstLineOnly: true })}`,
    };
  }
}
