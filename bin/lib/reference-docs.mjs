/**
 * Pure helpers for the `reference` (library-docs grounding) indexer — issue #1184.
 *
 * Separated from `bin/index-reference.mjs` (the orchestrator) so the dependency
 * discovery, doc resolution, chunking, and entry-shaping logic is unit-testable
 * without a sql.js load or a background embedding spawn — same split as
 * `bin/lib/incremental-write.mjs` / `bin/lib/index-fingerprint.mjs`.
 *
 * Everything here is side-effect-free apart from `fs` READS rooted at an
 * explicit `projectRoot`, and cross-platform: `path.join` only, no shelling out.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

// Bounds — keep one mega-dependency from dominating the index or the embed cost.
// The byte caps are applied as a character budget (a coarse cost bound; exact
// byte counting isn't needed) and MAX_CHUNKS_PER_DOC is the hard upper limit.
export const MAX_README_BYTES = 128 * 1024;  // skip the rare giant README
export const MAX_DTS_BYTES = 256 * 1024;     // skip bundled mega-.d.ts (aws-sdk etc.)
export const MIN_CHUNK_SIZE = 50;            // drop trivial fragments
export const MAX_CHUNK_SIZE = 4000;          // fits embedding context comfortably
export const MAX_CHUNKS_PER_DOC = 40;        // hard cap per (package, docType)

// Conventional README filenames, checked in order at the package root.
export const README_NAMES = ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README'];

// Dependency fields scanned from the consumer's package.json. DIRECT deps only —
// indexing the transitive node_modules tree would be unbounded and noisy.
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * Direct dependency names from the root package.json (sorted, de-duped). Returns
 * [] when there's no package.json or it can't be parsed — never throws.
 *
 * @param {string} projectRoot
 * @returns {string[]}
 */
export function collectDependencyNames(projectRoot) {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return [];
  let pkg;
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')); } catch { return []; }
  const names = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field];
    if (deps && typeof deps === 'object') {
      for (const name of Object.keys(deps)) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Resolve an installed package to its on-disk docs. Returns null when the
 * package isn't installed (e.g. a skipped optional dep) or has no README and no
 * type defs — a missing dep is silently dropped, never an error. The version is
 * read from the installed `package.json`, which IS the resolved version on disk
 * (format-agnostic across npm/yarn/pnpm/bun — no lockfile parsing needed).
 *
 * @param {string} projectRoot
 * @param {string} name  bare or scoped package name (e.g. `@types/node`)
 * @returns {{name:string, version:string, dir:string, readmePath:string|null, typesPath:string|null}|null}
 */
export function resolvePackageDocs(projectRoot, name) {
  // Scoped names (@types/node) split into nested dirs; path.join handles the sep.
  const dir = join(projectRoot, 'node_modules', ...name.split('/'));
  const pkgJsonPath = join(dir, 'package.json');
  if (!existsSync(pkgJsonPath)) return null;
  let meta;
  try { meta = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')); } catch { return null; }
  const version = typeof meta.version === 'string' ? meta.version : '0.0.0';

  // README — first match from a small set of conventional names at the root.
  let readmePath = null;
  for (const candidate of README_NAMES) {
    const p = join(dir, candidate);
    if (existsSync(p)) { readmePath = p; break; }
  }

  // Entry .d.ts — the declared types entry, else a root index.d.ts. Only the
  // entry file: pulling the whole declaration graph is unbounded and noisy.
  let typesPath = null;
  const declared = meta.types || meta.typings;
  if (typeof declared === 'string') {
    const dirAbs = resolve(dir);
    const p = resolve(dir, ...declared.split('/'));
    // Contain within the package dir — a manifest `types` value that traverses
    // out (e.g. "../x.d.ts") must not pull in a file outside the package.
    if (p.endsWith('.d.ts') && (p === dirAbs || p.startsWith(dirAbs + sep)) && existsSync(p)) {
      typesPath = p;
    }
  }
  if (!typesPath) {
    const fallback = join(dir, 'index.d.ts');
    if (existsSync(fallback)) typesPath = fallback;
  }

  if (!readmePath && !typesPath) return null;
  return { name, version, dir, readmePath, typesPath };
}

/**
 * Split text into size-bounded, line-aware chunks. Prefers blank-line
 * boundaries so a chunk doesn't split mid-paragraph / mid-declaration; an
 * oversized single block (e.g. a long interface) is hard-split by lines.
 * Capped at MAX_CHUNKS_PER_DOC.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function chunkText(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.length <= MAX_CHUNK_SIZE) return [normalized];

  const chunks = [];
  const blocks = normalized.split(/\n\s*\n/); // paragraph / declaration blocks
  let current = '';
  const atCap = () => chunks.length >= MAX_CHUNKS_PER_DOC;
  const flush = () => {
    const trimmed = current.trim();
    current = '';
    if (trimmed.length >= MIN_CHUNK_SIZE && !atCap()) chunks.push(trimmed);
  };

  for (const block of blocks) {
    if (atCap()) break;
    if (block.length > MAX_CHUNK_SIZE) {
      flush();
      for (const line of block.split('\n')) {
        if (line.length > MAX_CHUNK_SIZE) {
          // A single line longer than the cap (e.g. a minified .d.ts line) —
          // hard-split into cap-sized slices so no chunk exceeds the bound.
          flush();
          for (let off = 0; off < line.length; off += MAX_CHUNK_SIZE) {
            current = line.slice(off, off + MAX_CHUNK_SIZE);
            flush();
          }
          continue;
        }
        if (current.length + line.length + 1 > MAX_CHUNK_SIZE && current.length > 0) flush();
        current += (current ? '\n' : '') + line;
      }
      flush();
      continue;
    }
    if (current.length + block.length + 2 > MAX_CHUNK_SIZE && current.length > 0) flush();
    current += (current ? '\n\n' : '') + block;
  }
  flush();
  return chunks;
}

/**
 * Build chunk entries for one (package, docType) document, wired with the
 * navigation metadata `memory_get_neighbors` reads (parentDoc, prev/next,
 * siblings) so reference chunks are first-class traversable entries. The chunk
 * key embeds `name@version` so a dependency bump orphans the old version's
 * chunks (swept by applyIncrementalChunks) and inserts the new ones.
 *
 * @param {{name:string, version:string}} pkg
 * @param {'readme'|'types'} docType
 * @param {string} rawText
 * @returns {Array<{key:string, content:string, tags:string[], metadata:object}>}
 */
export function buildDocEntries(pkg, docType, rawText) {
  const cap = docType === 'readme' ? MAX_README_BYTES : MAX_DTS_BYTES;
  const raw = String(rawText ?? '');
  const text = raw.length > cap ? raw.slice(0, cap) : raw;
  const pieces = chunkText(text);
  if (pieces.length === 0) return [];

  const pkgKey = `${pkg.name}@${pkg.version}`;
  const parentDoc = `${pkgKey} ${docType}`;
  const keys = pieces.map((_, i) => `reference:${pkgKey}:${docType}:${i}`);
  const label = docType === 'readme' ? 'README' : 'type definitions';

  return pieces.map((content, i) => ({
    key: keys[i],
    content: `# ${pkg.name}@${pkg.version} — ${label}${pieces.length > 1 ? ` (part ${i + 1}/${pieces.length})` : ''}\n\n${content}`,
    tags: ['reference', 'library-docs', docType, pkg.name],
    metadata: {
      type: 'chunk',
      source: 'node_modules',
      package: pkg.name,
      version: pkg.version,
      docType,
      parentDoc,
      chunkIndex: i,
      totalChunks: pieces.length,
      prevChunk: i > 0 ? keys[i - 1] : null,
      nextChunk: i < pieces.length - 1 ? keys[i + 1] : null,
      siblings: keys,
      chunkTitle: `${pkg.name} ${label}${pieces.length > 1 ? ` (part ${i + 1})` : ''}`,
    },
  }));
}

/**
 * Resolve every direct dependency's docs and collect the absolute doc-file paths
 * (for the content-hash gate). Packages without installed docs drop out.
 *
 * @param {string} projectRoot
 * @returns {{packages:Array<object>, docFiles:string[], depCount:number}}
 */
export function collectReferenceDocs(projectRoot) {
  const depNames = collectDependencyNames(projectRoot);
  const packages = [];
  const docFiles = [];
  for (const name of depNames) {
    const pkg = resolvePackageDocs(projectRoot, name);
    if (!pkg) continue;
    packages.push(pkg);
    if (pkg.readmePath) docFiles.push(pkg.readmePath);
    if (pkg.typesPath) docFiles.push(pkg.typesPath);
  }
  return { packages, docFiles, depCount: depNames.length };
}
