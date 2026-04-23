#!/usr/bin/env node
/**
 * Postinstall native-binary pruner for consumer moflo installs.
 *
 * Trims `onnxruntime-node`'s multi-platform binary bundle under
 * `bin/napi-v3/<platform>/<arch>/` down to just the current combination,
 * reclaiming ~150 MB per install. `fastembed` pulls the full bundle by
 * default.
 *
 * Escape hatches:
 *   - `MOFLO_NO_PRUNE=1`             → skip entirely
 *   - script is inside moflo source  → skip (dev/CI needs the full set)
 *   - no `node_modules/` (Yarn PnP)  → skip with info log
 *   - no onnxruntime-node installed  → no-op
 *
 * Failure posture: a consumer install must NEVER fail because of this
 * script. All errors are logged and swallowed; exit is always 0.
 *
 * Pure Node — no shell invocations, no dependencies. Must work during
 * `npm install` before any of moflo's own compiled code exists on disk.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const BYTES_PER_MB = 1024 * 1024;
const NODE_MODULES_SEGMENT = `${sep}node_modules${sep}`;

function info(msg) { console.log(`moflo:prune ${msg}`); }
function warn(msg) { console.warn(`moflo:prune warn: ${msg}`); }

/**
 * True only when the script is running from within the moflo source repo
 * itself — detected by absence of any `node_modules/` segment in the path
 * AND a nearest-ancestor `package.json` with `"name": "moflo"`. Any other
 * weird state (no package.json found, unreadable, different name) returns
 * `false` so `run()` falls through to the normal consumer-root path and
 * skips with a clear reason. This avoids silently disabling prune in
 * unusual-but-real consumer layouts.
 */
export function isSourceRepo(scriptPath) {
  if (scriptPath.includes(NODE_MODULES_SEGMENT)) return false;
  let dir = dirname(scriptPath);
  while (true) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        return pkg?.name === 'moflo';
      } catch {
        return false;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Extract the consumer project root from the script path. When installed as a
 * dep the script lives at `<consumerRoot>/node_modules/moflo/scripts/…`.
 * Uses the outermost `node_modules/` segment so nested npm installs still
 * resolve to the consumer's real project root (not an intermediate package).
 */
export function findConsumerRoot(scriptPath) {
  const idx = scriptPath.indexOf(NODE_MODULES_SEGMENT);
  if (idx === -1) return null;
  return scriptPath.slice(0, idx);
}

/**
 * Collect every `onnxruntime-node` directory under `nodeModulesDir`. Checks
 * the two common layouts first (hoisted + nested under fastembed) to avoid
 * walking a large consumer `node_modules/` tree in the common case, and
 * falls back to a bounded recursive walk for non-standard layouts.
 */
export function findOrtPackages(nodeModulesDir, maxDepth = 10) {
  const fast = [
    join(nodeModulesDir, 'fastembed', 'node_modules', 'onnxruntime-node'),
    join(nodeModulesDir, 'onnxruntime-node'),
  ].filter(existsSync);
  if (fast.length > 0) return fast;

  const hits = [];

  function scanNodeModules(nmDir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(nmDir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const pkgDir = join(nmDir, ent.name);
      if (ent.name === 'onnxruntime-node') { hits.push(pkgDir); continue; }
      if (ent.name.startsWith('@')) { scanScope(pkgDir, depth + 1); continue; }
      scanNodeModules(join(pkgDir, 'node_modules'), depth + 1);
    }
  }

  function scanScope(scopeDir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(scopeDir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const pkgDir = join(scopeDir, ent.name);
      if (ent.name === 'onnxruntime-node') hits.push(pkgDir);
      scanNodeModules(join(pkgDir, 'node_modules'), depth + 1);
    }
  }

  scanNodeModules(nodeModulesDir, 0);
  return hits;
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      const full = join(d, ent.name);
      if (ent.isDirectory()) { stack.push(full); continue; }
      try { total += statSync(full).size; } catch { /* ignore */ }
    }
  }
  return total;
}

/**
 * Remove a directory, tolerating one `EBUSY` retry (Windows file-locking).
 * When `measure` is true, walks the tree first to compute reclaimed bytes —
 * otherwise returns 0 and skips the extra walk entirely. Returns 0 on any
 * failure; the script never fails the install.
 */
export function removeDir(dir, { rm = rmSync, measure = false } = {}) {
  const size = measure ? dirSize(dir) : 0;
  try {
    rm(dir, { recursive: true, force: true, maxRetries: 1, retryDelay: 250 });
    return size;
  } catch (err) {
    warn(`could not remove ${dir}: ${err.code || err.message} (leaving in place)`);
    return 0;
  }
}

/**
 * Prune `bin/napi-v3/<platform>/<arch>/` from one onnxruntime-node package,
 * keeping only the current combination.
 */
export function pruneOrtPackage(ortDir, {
  keepPlatform = process.platform,
  keepArch = process.arch,
  rm = rmSync,
  measure = false,
} = {}) {
  const napiDir = join(ortDir, 'bin', 'napi-v3');
  let platforms;
  try { platforms = readdirSync(napiDir, { withFileTypes: true }); }
  catch { return 0; }

  let bytes = 0;
  for (const p of platforms) {
    if (!p.isDirectory()) continue;
    const pDir = join(napiDir, p.name);
    if (p.name !== keepPlatform) {
      bytes += removeDir(pDir, { rm, measure });
      continue;
    }
    let archs;
    try { archs = readdirSync(pDir, { withFileTypes: true }); }
    catch (err) { warn(`cannot read ${pDir}: ${err.message}`); continue; }
    for (const a of archs) {
      if (!a.isDirectory() || a.name === keepArch) continue;
      bytes += removeDir(join(pDir, a.name), { rm, measure });
    }
  }
  return bytes;
}

/**
 * Whole-run entry point. Returns `{ code, bytesReclaimed, packagesPruned, reason }`.
 * Never throws — all errors are caught and downgraded to `warn`.
 */
export function run({
  scriptPath = SCRIPT_PATH,
  env = process.env,
  verbose = false,
} = {}) {
  if (env.MOFLO_NO_PRUNE === '1') {
    info('MOFLO_NO_PRUNE=1 set — skipping native-binary prune');
    return { code: 0, bytesReclaimed: 0, packagesPruned: 0, reason: 'opt-out' };
  }

  if (isSourceRepo(scriptPath)) {
    if (verbose) info('running inside moflo source repo — skipping prune');
    return { code: 0, bytesReclaimed: 0, packagesPruned: 0, reason: 'source-repo' };
  }

  const consumerRoot = findConsumerRoot(scriptPath);
  if (!consumerRoot) {
    info('could not resolve consumer root — skipping prune');
    return { code: 0, bytesReclaimed: 0, packagesPruned: 0, reason: 'no-root' };
  }

  const nmDir = join(consumerRoot, 'node_modules');
  if (!existsSync(nmDir)) {
    info('no node_modules/ (Yarn PnP or pre-install) — skipping prune');
    return { code: 0, bytesReclaimed: 0, packagesPruned: 0, reason: 'no-node-modules' };
  }

  const ortPkgs = findOrtPackages(nmDir);
  if (ortPkgs.length === 0) {
    if (verbose) info('no onnxruntime-node installs found — nothing to prune');
    return { code: 0, bytesReclaimed: 0, packagesPruned: 0, reason: 'no-ort' };
  }

  let totalBytes = 0;
  for (const pkg of ortPkgs) {
    totalBytes += pruneOrtPackage(pkg, { measure: verbose });
  }

  if (verbose) {
    const mb = (totalBytes / BYTES_PER_MB).toFixed(1);
    info(`pruned ${ortPkgs.length} onnxruntime-node install(s), reclaimed ${mb} MB`);
  }

  return {
    code: 0,
    bytesReclaimed: totalBytes,
    packagesPruned: ortPkgs.length,
    reason: 'pruned',
  };
}

// Auto-run when executed directly (project convention: URL-normalized compare
// for Windows drive-letter/case safety — see scripts/clean-dist.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const verbose = process.argv.includes('--verbose') || process.env.MOFLO_PRUNE_VERBOSE === '1';
    const result = run({ verbose });
    process.exit(result.code);
  } catch (err) {
    warn(`unexpected error: ${err?.stack || err?.message || err}`);
    process.exit(0);
  }
}
