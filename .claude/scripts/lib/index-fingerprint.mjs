/**
 * Fingerprint gate for the session-start indexer chain.
 *
 * The chain `index-all.mjs` runs on every Claude Code session-start. Without
 * a gate it does full indexing + embedding + HNSW work even when nothing has
 * meaningfully changed — pegging the box for several minutes per session.
 *
 * This module computes a small "did anything that matters change" fingerprint
 * and persists it after each successful run. The chain skips entirely when
 * the current fingerprint matches the saved one.
 *
 * Inputs we consider "changes that warrant re-indexing":
 *   - `.moflo/moflo.db` mtime          → memory writes (new entries, deletes)
 *   - `node_modules/moflo/package.json` mtime → moflo upgrade
 *   - `moflo.yaml` mtime               → config change (auto_index toggles)
 *   - `.claude/guidance/**` recursive newest-mtime → shipped or local guidance
 *     content changed (the launcher rewrites these on upgrade)
 *
 * Inputs we DON'T consider:
 *   - Source files (src/, app/, lib/, etc.) — individual indexers already
 *     have incremental detection, so re-running the chain on a source edit
 *     would be redundant. If a consumer reports stale codemap on edits,
 *     extend the fingerprint in a follow-up. Keeping the set small makes
 *     the gate cheap (no broad project tree walks at session-start).
 *
 * Override: set `FLO_FORCE_INDEX=1` in the environment to bypass the gate
 * (useful for `flo doctor --fix` or manual rebuilds).
 *
 * Failure posture:
 *   - Errors reading the fingerprint or computing inputs → return null,
 *     which forces the chain to run (safe fallback).
 *   - Errors saving the fingerprint → don't fail the run; the next run will
 *     also recompute and run, no correctness hazard.
 */

import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const FINGERPRINT_FILE_REL = '.moflo/index-all-fingerprint.json';
export const FINGERPRINT_VERSION = 1;
export const FORCE_ENV = 'FLO_FORCE_INDEX';

function safeMtime(path) {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

/**
 * Newest mtime across all files under `dir`, recursive. Skips dot-dirs and
 * `node_modules` to avoid walking irrelevant trees.
 *
 * Capped depth keeps the cost bounded (.claude/guidance/ has ~2 levels in
 * the wild; cap at 6 for safety).
 */
function newestMtimeRecursive(dir, depth = 6) {
  if (depth <= 0) return 0;
  let max = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const m = newestMtimeRecursive(full, depth - 1);
        if (m > max) max = m;
      } else if (entry.isFile()) {
        const m = safeMtime(full);
        if (m > max) max = m;
      }
    }
  } catch {
    // Unreadable dir — return 0; caller will compare equality and fall through.
  }
  return max;
}

/**
 * Compute the current fingerprint for `projectRoot`. Cheap (a handful of
 * stat() calls + one bounded recursive walk over .claude/guidance/).
 *
 * Returns a flat object of { input → mtimeMs }. Missing files contribute 0,
 * which still produces a stable fingerprint as long as their absence is
 * stable.
 */
export function computeFingerprint(projectRoot) {
  return {
    memoryDb: safeMtime(resolve(projectRoot, '.moflo/moflo.db')),
    mofloPkg: safeMtime(resolve(projectRoot, 'node_modules/moflo/package.json')),
    mofloYaml: safeMtime(resolve(projectRoot, 'moflo.yaml')),
    guidance: newestMtimeRecursive(resolve(projectRoot, '.claude/guidance')),
  };
}

/**
 * Compare two fingerprints by exact equality on every recorded key. Either
 * side being null/undefined returns false — forces a run when the saved
 * record is missing or unparseable.
 */
export function fingerprintsEqual(a, b) {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * Read the saved fingerprint payload from disk. Returns the bare fingerprint
 * object (not the wrapper), or null if missing/corrupt/version-mismatched.
 */
export function readSavedFingerprint(projectRoot) {
  const path = resolve(projectRoot, FINGERPRINT_FILE_REL);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || data.version !== FINGERPRINT_VERSION) return null;
    return data.fingerprint || null;
  } catch {
    return null;
  }
}

/**
 * Persist the fingerprint after a successful run. Wrapper carries a version
 * and timestamp so a future schema change can invalidate gracefully.
 *
 * Returns true on success; false on write failure (caller should not fail
 * the run on this).
 */
export function saveFingerprint(projectRoot, fp) {
  const path = resolve(projectRoot, FINGERPRINT_FILE_REL);
  const payload = {
    version: FINGERPRINT_VERSION,
    savedAt: new Date().toISOString(),
    fingerprint: fp,
  };
  try {
    writeFileSync(path, JSON.stringify(payload, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * High-level gate decision. Returns one of:
 *   { skip: true,  reason: 'unchanged' }
 *   { skip: false, reason: 'forced' | 'no-saved-fingerprint' | 'inputs-changed', current }
 *
 * `current` is included on the run path so the caller can save it after a
 * successful run without recomputing.
 */
export function decideIndexGate(projectRoot, env = process.env) {
  if (env[FORCE_ENV]) {
    return { skip: false, reason: 'forced', current: computeFingerprint(projectRoot) };
  }
  const current = computeFingerprint(projectRoot);
  const saved = readSavedFingerprint(projectRoot);
  if (!saved) return { skip: false, reason: 'no-saved-fingerprint', current };
  if (fingerprintsEqual(current, saved)) return { skip: true, reason: 'unchanged' };
  return { skip: false, reason: 'inputs-changed', current };
}
