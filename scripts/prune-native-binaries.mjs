#!/usr/bin/env node
/**
 * Postinstall native-binary pruner for consumer moflo installs.
 *
 * Trims `onnxruntime-node`'s multi-platform binary bundle under
 * `bin/napi-v3/<platform>/<arch>/` down to just the current combination,
 * and also strips GPU-only provider libraries (CUDA ~327 MB, TensorRT,
 * DirectML ~18 MB) that fastembed never loads. Reclaims ~340 MB per Linux
 * install and ~150 MB per Windows install.
 *
 * Ownership-scoped: only prunes `onnxruntime-node` copies that fastembed
 * owns via its dependency graph. Foreign sibling ORT installs (e.g. an
 * Electron cross-compile packager) are left alone. See `findOrtPackages`.
 *
 * Escape hatches:
 *   - `MOFLO_NO_PRUNE=1`             → skip entirely
 *   - script is inside moflo source  → skip (dev/CI needs the full set)
 *   - no `node_modules/` (Yarn PnP)  → skip with info log
 *   - no fastembed-owned ORT found   → no-op
 *
 * Failure posture: a consumer install must NEVER fail because of this
 * script. All errors are logged and swallowed; exit is always 0.
 *
 * Pure Node — no shell invocations, no dependencies. Must work during
 * `npm install` before any of moflo's own compiled code exists on disk.
 */

import {
  existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const BYTES_PER_MB = 1024 * 1024;
const NODE_MODULES_SEGMENT = `${sep}node_modules${sep}`;
const FASTEMBED_OWNER = 'fastembed';
const ORT_DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];
// GPU-only provider libraries that ship in onnxruntime-node's binary bundle but
// are never loaded by fastembed (CPU inference). Matches files like:
//   libonnxruntime_providers_cuda.so      (linux — 327 MB for ORT 1.21)
//   libonnxruntime_providers_tensorrt.so  (linux)
//   libonnxruntime_providers_shared.so    (linux — GPU-loader helper only)
//   onnxruntime_providers_*.dll           (windows variant, same role)
//   DirectML.dll                          (windows DirectX GPU — 18 MB)
// The CPU runtime (`libonnxruntime.so.1*`, `onnxruntime.dll`, `libonnxruntime.*.dylib`)
// and the Node binding (`onnxruntime_binding.node`) never match and are preserved.
// Other GPU providers (openvino, rocm, qnn) aren't shipped in ORT 1.21; revisit
// on version bumps if they appear.
const GPU_PROVIDER_FILE_PATTERN =
  /^(lib)?onnxruntime_providers_(cuda|tensorrt|shared)(\.|$)|^directml\.dll$/i;

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
 * Walk `nodeModulesDir` collecting every install whose basename matches one
 * of `ownerNames`. Bounded recursive walk — descends into each package's
 * nested `node_modules/` so non-hoisted copies are also found.
 *
 * Scoped owner names are not matched (fastembed isn't scoped); the walker
 * still descends through `@scope/<pkg>/node_modules/` to find nested owners.
 */
function findOwnerInstalls(nodeModulesDir, ownerNames, maxDepth) {
  const hits = [];
  const owners = new Set(ownerNames);

  function scanNodeModules(nmDir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(nmDir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const pkgDir = join(nmDir, ent.name);
      if (owners.has(ent.name)) { hits.push(pkgDir); continue; }
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
      scanNodeModules(join(scopeDir, ent.name, 'node_modules'), depth + 1);
    }
  }

  scanNodeModules(nodeModulesDir, 0);
  return hits;
}

/**
 * Mirror Node's `require.resolve` upward walk: from `startDir`, probe each
 * `<ancestor>/node_modules/onnxruntime-node` in turn and return the first
 * that exists. Skips `<dir>` when `dir` is itself a `node_modules` directory
 * to avoid the pathological `…/node_modules/node_modules/…` probe. Returns
 * `null` when no ancestor carries ORT.
 */
export function resolveOrtForOwner(startDir) {
  let dir = startDir;
  while (true) {
    if (basename(dir) !== 'node_modules') {
      const candidate = join(dir, 'node_modules', 'onnxruntime-node');
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Return the set of top-level package names (excluding `fastembed`) that
 * declare `onnxruntime-node` in any dep field. A non-empty set means the
 * hoisted ORT is shared — pruning its non-current binaries could strand
 * another consumer (e.g. an Electron packager cross-compiling). Only scans
 * direct `<nm>/<pkg>` and `<nm>/@scope/<pkg>` — packages that keep their own
 * ORT nested under their own `node_modules/` don't share the hoisted copy.
 */
export function collectOtherOrtDeclarers(nodeModulesDir) {
  const declarers = new Set();

  function record(pkgDir, name) {
    try {
      const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
      for (const kind of ORT_DEP_FIELDS) {
        if (pkg?.[kind]?.['onnxruntime-node']) { declarers.add(name); return; }
      }
    } catch { /* missing or unreadable package.json — ignore */ }
  }

  let entries;
  try { entries = readdirSync(nodeModulesDir, { withFileTypes: true }); }
  catch { return declarers; }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === 'onnxruntime-node' || ent.name === FASTEMBED_OWNER) continue;
    const pkgDir = join(nodeModulesDir, ent.name);
    if (ent.name.startsWith('@')) {
      let scopeEntries;
      try { scopeEntries = readdirSync(pkgDir, { withFileTypes: true }); }
      catch { continue; }
      for (const s of scopeEntries) {
        if (!s.isDirectory()) continue;
        record(join(pkgDir, s.name), `${ent.name}/${s.name}`);
      }
      continue;
    }
    record(pkgDir, ent.name);
  }
  return declarers;
}

function isNestedUnderFastembed(ortDir) {
  // Path structurally ends in `<…>/fastembed/node_modules/onnxruntime-node`.
  return basename(dirname(dirname(ortDir))) === FASTEMBED_OWNER;
}

/**
 * Collect every `onnxruntime-node` directory that moflo owns via its
 * dependency graph. Ownership rules:
 *   - Find every `fastembed` install; resolve its ORT by the Node algorithm.
 *   - ORT strictly nested under `fastembed/node_modules/` is always pruned
 *     (private to fastembed, cannot be shared).
 *   - A hoisted ORT resolved by fastembed is pruned only when no other
 *     top-level package declares `onnxruntime-node` — otherwise the copy is
 *     shared (Electron cross-compile packager, sibling ORT consumer) and we
 *     leave all of its platform binaries intact.
 *
 * Returns deduped absolute paths.
 */
export function findOrtPackages(nodeModulesDir, maxDepth = 10) {
  // Fast path: fastembed is almost always hoisted to `<nm>/fastembed` — skip
  // the full walk when we can see it there. Falls through to the recursive
  // walker when fastembed is non-hoisted (version conflict) or absent.
  const hoisted = join(nodeModulesDir, FASTEMBED_OWNER);
  const owners = existsSync(hoisted)
    ? [hoisted]
    : findOwnerInstalls(nodeModulesDir, [FASTEMBED_OWNER], maxDepth);
  if (owners.length === 0) return [];

  const ortPaths = new Set();
  // Lazily computed: we only need the declarer scan if at least one owner
  // resolves to a hoisted ORT. Skipped entirely when every fastembed carries
  // its own nested copy.
  let otherDeclarers = null;

  for (const owner of owners) {
    const ort = resolveOrtForOwner(owner);
    if (!ort) continue;

    if (isNestedUnderFastembed(ort)) {
      ortPaths.add(ort);
      continue;
    }
    if (otherDeclarers === null) otherDeclarers = collectOtherOrtDeclarers(nodeModulesDir);
    if (otherDeclarers.size === 0) ortPaths.add(ort);
    // else: hoisted copy is shared with another consumer — untouched.
  }

  return [...ortPaths];
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
 * Plant a zero-byte `libonnxruntime_providers_cuda.so` stub in the linux/x64
 * arch dir. `onnxruntime-node@1.21`'s own postinstall downloads a 327 MB CUDA
 * provider tarball *after* moflo's postinstall runs (npm orders file:-tarball
 * roots before their deps). The download is gated on `!CUDA_DLL_EXISTS`, so
 * pre-creating the path as an empty file short-circuits the fetch entirely.
 * No-op when the user opts in to CUDA via `ONNXRUNTIME_NODE_INSTALL_CUDA=true`
 * or when the stub already exists. See `node_modules/onnxruntime-node/script/install.js`
 * for the upstream check.
 */
export function plantCudaStub(archDir, { keepPlatform, keepArch, env = process.env }) {
  if (keepPlatform !== 'linux' || keepArch !== 'x64') return false;
  if (env.ONNXRUNTIME_NODE_INSTALL_CUDA === 'true') return false;
  const stubPath = join(archDir, 'libonnxruntime_providers_cuda.so');
  if (existsSync(stubPath)) return false;
  try {
    writeFileSync(stubPath, '');
    return true;
  } catch (err) {
    warn(`could not plant CUDA stub at ${stubPath}: ${err.code || err.message}`);
    return false;
  }
}

/**
 * Remove GPU-only ORT provider libraries from a kept `<platform>/<arch>/`
 * directory. Matches `GPU_PROVIDER_FILE_PATTERN`; leaves everything else
 * (CPU runtime, Node bindings, manifests) untouched.
 */
export function pruneGpuProviders(archDir, { rm = rmSync, measure = false } = {}) {
  let entries;
  try { entries = readdirSync(archDir, { withFileTypes: true }); }
  catch { return 0; }

  let bytes = 0;
  for (const ent of entries) {
    if (!ent.isFile() || !GPU_PROVIDER_FILE_PATTERN.test(ent.name)) continue;
    const full = join(archDir, ent.name);
    let size = 0;
    if (measure) {
      try { size = statSync(full).size; } catch { /* ignore */ }
    }
    try {
      rm(full, { force: true, maxRetries: 1, retryDelay: 250 });
      bytes += size;
    } catch (err) {
      warn(`could not remove ${full}: ${err.code || err.message} (leaving in place)`);
    }
  }
  return bytes;
}

/**
 * Prune `bin/napi-v3/<platform>/<arch>/` from one onnxruntime-node package,
 * keeping only the current combination. Also strips GPU-only provider
 * libraries (`libonnxruntime_providers_{cuda,tensorrt,shared}.*`, `DirectML.dll`)
 * from the kept arch dir — fastembed runs on the CPU provider only, so these
 * are dead weight on every host (ORT 1.21 ships a 327 MB CUDA provider on
 * linux/x64 that nothing in our graph loads).
 */
export function pruneOrtPackage(ortDir, {
  keepPlatform = process.platform,
  keepArch = process.arch,
  rm = rmSync,
  measure = false,
  env = process.env,
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
      if (!a.isDirectory()) continue;
      if (a.name === keepArch) {
        const archDir = join(pDir, a.name);
        bytes += pruneGpuProviders(archDir, { rm, measure });
        // Plant stub AFTER prune so the upstream ORT postinstall (which runs
        // later on linux/x64) sees `CUDA_DLL_EXISTS` and skips the fetch.
        plantCudaStub(archDir, { keepPlatform, keepArch, env });
        continue;
      }
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
    totalBytes += pruneOrtPackage(pkg, { measure: verbose, env });
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
