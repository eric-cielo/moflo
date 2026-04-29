/**
 * Lightweight migration tracker.
 *
 * Records which one-time migrations have already run for a given project so
 * we can run them idempotently on every session start without thrashing.
 *
 * Manifest lives at `<.moflo>/migrations.json` and looks like:
 *
 *   {
 *     "knowledge-to-learnings": {
 *       "ranAt": "2026-04-28T19:05:00.000Z",
 *       "version": "4.9.0-rc.7",
 *       "details": { "rowsMigrated": 18 }
 *     }
 *   }
 *
 * Single canonical file beats one stamp per migration — easier to audit,
 * easier to reset, and keeps `.moflo/` from accumulating sentinel-file noise
 * as more migrations land (DB relocation, schema bumps, etc.).
 *
 * @module bin/lib/migrations
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { MOFLO_DIR } from './moflo-paths.mjs';

function manifestPath(projectRoot) {
  return resolve(projectRoot, MOFLO_DIR, 'migrations.json');
}

function readManifest(projectRoot) {
  const path = manifestPath(projectRoot);
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return (data && typeof data === 'object') ? data : {};
  } catch {
    // Malformed manifest — treat as empty so a corrupt file doesn't block
    // session start. The next markMigrationDone() rewrites it cleanly.
    return {};
  }
}

function writeManifest(projectRoot, manifest) {
  const path = manifestPath(projectRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(manifest, null, 2));
  } catch {
    // Non-fatal — migrations re-run is acceptable; blocking session start isn't.
  }
}

/**
 * @param {string} projectRoot
 * @param {string} name - migration identifier (e.g., 'knowledge-to-learnings')
 * @returns {boolean}
 */
export function hasMigrationRun(projectRoot, name) {
  const manifest = readManifest(projectRoot);
  return Boolean(manifest[name]?.ranAt);
}

/**
 * @param {string} projectRoot
 * @param {string} name
 * @param {object} [details] - arbitrary JSON-serialisable payload (row counts, etc.)
 */
export function markMigrationDone(projectRoot, name, details = {}) {
  const manifest = readManifest(projectRoot);
  let version = null;
  try {
    const pkgPath = resolve(projectRoot, 'node_modules/moflo/package.json');
    if (existsSync(pkgPath)) version = JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? null;
  } catch {
    // version is best-effort metadata; absence isn't load-bearing
  }
  manifest[name] = {
    ranAt: new Date().toISOString(),
    version,
    details,
  };
  writeManifest(projectRoot, manifest);
}

/**
 * Forget a migration so it runs again next session. For dev/test resets.
 * @param {string} projectRoot
 * @param {string} name
 */
export function clearMigration(projectRoot, name) {
  const manifest = readManifest(projectRoot);
  if (name in manifest) {
    delete manifest[name];
    writeManifest(projectRoot, manifest);
  }
}

/**
 * @param {string} projectRoot
 * @returns {Record<string, {ranAt:string, version:string|null, details:object}>}
 */
export function listMigrations(projectRoot) {
  return readManifest(projectRoot);
}
