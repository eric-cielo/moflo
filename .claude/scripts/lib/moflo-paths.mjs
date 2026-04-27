/**
 * Pure-JS counterpart to src/cli/services/moflo-paths.ts (#699).
 *
 * Lives in bin/lib because session-start-launcher.mjs and other bin/ scripts
 * run before any TS compilation has happened — they can't import the .ts
 * source. The TS version is the canonical programmatic API; this version
 * mirrors the same algorithm so migration also runs from the consumer
 * launcher path. Algorithm parity is enforced by the parity case in
 * src/cli/__tests__/services/moflo-paths-migration.test.ts.
 */
import { existsSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

export const MOFLO_DIR = '.moflo';
export const LEGACY_CLAUDE_FLOW_DIR = '.claude-flow';

export function mofloDir(projectRoot) {
  return join(projectRoot, MOFLO_DIR);
}

export function legacyClaudeFlowDir(projectRoot) {
  return join(projectRoot, LEGACY_CLAUDE_FLOW_DIR);
}

/**
 * One-time migration of `.claude-flow/` → `.moflo/`. Idempotent — safe to call
 * on every session start. See moflo-paths.ts for the full contract.
 *
 * Returns `{ migrated, reason? }`.
 */
export function migrateClaudeFlowToMoflo(projectRoot) {
  const legacy = legacyClaudeFlowDir(projectRoot);
  const target = mofloDir(projectRoot);

  if (!existsSync(legacy)) return { migrated: false, reason: 'no-legacy' };

  if (!existsSync(target)) {
    renameSync(legacy, target);
    return { migrated: true };
  }

  let entries;
  try {
    entries = readdirSync(legacy);
  } catch {
    return { migrated: false, reason: 'legacy-unreadable' };
  }

  let moved = 0;
  for (const name of entries) {
    const dst = join(target, name);
    if (existsSync(dst)) continue;
    try {
      renameSync(join(legacy, name), dst);
      moved++;
    } catch {
      // Best-effort — single failed move shouldn't abort the rest.
    }
  }

  try {
    if (readdirSync(legacy).length === 0) rmdirSync(legacy);
  } catch {
    // Non-fatal — leftover legacy dir means migration runs next time.
  }

  return moved > 0 ? { migrated: true } : { migrated: false, reason: 'merged-nothing' };
}
