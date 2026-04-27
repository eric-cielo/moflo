/**
 * MoFlo runtime state directory constants + legacy migration (#699).
 *
 * MoFlo owns its state under `.moflo/` at the project root. The upstream Ruflo
 * fork used `.claude-flow/`; consumers upgrading from older moflo builds (which
 * inherited that path) get a one-time auto-migration so they don't lose claim
 * files, daemon state, metrics, etc.
 *
 * Anything that touches a runtime state path under the project root must
 * compose it from `MOFLO_DIR`. Plain string literals like `'.moflo'` are
 * tolerated where a constant import is awkward (shell templates, tests) but
 * production code is checked by `published-package-drift-guard.test.ts`.
 *
 * The pure-JS twin at `bin/lib/moflo-paths.mjs` mirrors the algorithm so
 * `bin/session-start-launcher.mjs` can run the migration before any TS has
 * been compiled. The parity test in moflo-paths-migration.test.ts catches
 * algorithm divergence between the two.
 */
import { existsSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

export const MOFLO_DIR = '.moflo';

/**
 * Legacy runtime directory inherited from upstream Ruflo. Only referenced from
 * migration code paths — production code should use {@link MOFLO_DIR}.
 */
export const LEGACY_CLAUDE_FLOW_DIR = '.claude-flow';

export function mofloDir(projectRoot: string): string {
  return join(projectRoot, MOFLO_DIR);
}

export function legacyClaudeFlowDir(projectRoot: string): string {
  return join(projectRoot, LEGACY_CLAUDE_FLOW_DIR);
}

export interface MigrationResult {
  migrated: boolean;
  /** Diagnostic string for "why didn't this migrate" — `no-legacy`, `legacy-unreadable`, `merged-nothing`. Absent on success. */
  reason?: string;
}

/**
 * One-time migration of `.claude-flow/` → `.moflo/`.
 *
 * - Legacy missing → no-op (the steady state after first run).
 * - Legacy present + target missing → atomic rename (preserves mtimes).
 * - Both present → merge: target wins on collision, leaving the colliding
 *   entry behind in legacy/ so a future run can retry. Drops the legacy dir
 *   if everything moved cleanly.
 *
 * Idempotent and safe to call from session start.
 */
export function migrateClaudeFlowToMoflo(projectRoot: string): MigrationResult {
  const legacy = legacyClaudeFlowDir(projectRoot);
  const target = mofloDir(projectRoot);

  if (!existsSync(legacy)) return { migrated: false, reason: 'no-legacy' };

  if (!existsSync(target)) {
    renameSync(legacy, target);
    return { migrated: true };
  }

  let entries: string[];
  try {
    entries = readdirSync(legacy);
  } catch {
    return { migrated: false, reason: 'legacy-unreadable' };
  }

  let moved = 0;
  for (const name of entries) {
    const dst = join(target, name);
    if (existsSync(dst)) continue; // target wins — newer state preferred
    try {
      renameSync(join(legacy, name), dst);
      moved++;
    } catch {
      // Best-effort merge — a failed move on one entry shouldn't abort the rest.
    }
  }

  // Drop empty legacy dir so future runs short-circuit at existsSync(legacy).
  try {
    if (readdirSync(legacy).length === 0) rmdirSync(legacy);
  } catch {
    // Non-fatal — leftover legacy dir just means migration runs next time.
  }

  return moved > 0 ? { migrated: true } : { migrated: false, reason: 'merged-nothing' };
}
