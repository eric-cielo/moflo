#!/usr/bin/env node
/**
 * Migration runner — consults the per-project manifest and runs only
 * migrations that haven't already been recorded. Fast-paths to a no-op when
 * nothing is unmet (cost = node startup + ESM graph; sub-100ms on warm fs),
 * so it's safe to fire on every session start.
 *
 * Migrations live under `bin/migrations/` and each module exports:
 *   export const name = '<unique-id>';
 *   export async function run(projectRoot): Promise<{...details}>
 *
 * Manifest at `<.moflo>/migrations.json` records what's already done so we
 * don't re-run on every session — that's the whole point.
 *
 * Usage:
 *   node node_modules/moflo/bin/run-migrations.mjs                  # consult manifest, run unmet
 *   node node_modules/moflo/bin/run-migrations.mjs --verbose
 *   node node_modules/moflo/bin/run-migrations.mjs --force <name>   # force re-run a specific migration
 *   node node_modules/moflo/bin/run-migrations.mjs --list            # print manifest and exit
 */

import { existsSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { hasMigrationRun, markMigrationDone, listMigrations, clearMigration } from './lib/migrations.mjs';
import { findProjectRoot } from './lib/moflo-paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const projectRoot = findProjectRoot();
const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const list = args.includes('--list');
const forceIdx = args.indexOf('--force');
const forceName = forceIdx >= 0 ? args[forceIdx + 1] : null;

function log(msg) { console.log(`[migrations] ${msg}`); }
function debug(msg) { if (verbose) console.log(`[migrations]   ${msg}`); }

if (list) {
  const manifest = listMigrations(projectRoot);
  const keys = Object.keys(manifest);
  if (keys.length === 0) {
    console.log('(no migrations recorded)');
  } else {
    for (const key of keys) {
      const m = manifest[key];
      console.log(`${key}: ranAt=${m.ranAt} version=${m.version ?? '?'} details=${JSON.stringify(m.details ?? {})}`);
    }
  }
  process.exit(0);
}

async function loadMigrations() {
  const dir = resolve(__dirname, 'migrations');
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  const loaded = [];
  for (const f of entries) {
    const url = pathToFileURL(resolve(dir, f)).href;
    try {
      const mod = await import(url);
      if (mod && typeof mod.run === 'function' && typeof mod.name === 'string') {
        loaded.push(mod);
      } else {
        debug(`SKIP ${f} — missing { name, run } exports`);
      }
    } catch (err) {
      debug(`SKIP ${f} — load error: ${err.message}`);
    }
  }
  // Stable order: by `order` (default 0) ascending, then by `name`. A
  // migration that depends on another should `export const order = N` with N
  // larger than the dep's. readdirSync is filesystem-dependent across OSes,
  // so explicit ordering is the only portable way to express dependencies.
  loaded.sort((a, b) => {
    const ao = typeof a.order === 'number' ? a.order : 0;
    const bo = typeof b.order === 'number' ? b.order : 0;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  });
  return loaded;
}

async function main() {
  if (forceName) {
    clearMigration(projectRoot, forceName);
    log(`Forced re-run of "${forceName}" (manifest entry cleared)`);
  }

  const migrations = await loadMigrations();
  if (migrations.length === 0) {
    debug('No migrations registered');
    return;
  }

  const pending = migrations.filter((m) => !hasMigrationRun(projectRoot, m.name));
  if (pending.length === 0) {
    debug(`All ${migrations.length} migrations already recorded — nothing to do`);
    return;
  }

  for (const migration of pending) {
    try {
      const t0 = Date.now();
      const details = await migration.run(projectRoot);
      const dt = Date.now() - t0;
      markMigrationDone(projectRoot, migration.name, details ?? {});
      log(`${migration.name}: done in ${dt}ms ${details ? JSON.stringify(details) : ''}`);
    } catch (err) {
      // Don't block session start on a single bad migration. Leave it
      // unrecorded so the next session retries.
      console.error(`[migrations] ${migration.name} FAILED (will retry next session): ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(`[migrations] runner error (non-critical): ${err.message}`);
  process.exit(0);
});
