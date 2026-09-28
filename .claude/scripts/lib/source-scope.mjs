/**
 * Source-file scope shared by the code-map and patterns indexers (#1497).
 *
 * Both indexers used to enumerate the whole repository: code-map ran
 * `git ls-files` over every tracked file and applied `code_map.directories` /
 * `code_map.exclude` only in its filesystem fallback, and patterns walked the
 * raw filesystem with no `.gitignore` handling at all — so gitignored build
 * output (e.g. `cdk.out/asset.<hash>/index.mjs`) and every test file landed in
 * semantic search. One scope, applied on every enumeration path, keeps them in
 * step with each other and with what `moflo.yaml` says.
 *
 * Scope rules:
 *   - Only files under a configured `code_map.directories` entry (`.` = repo).
 *   - Never a gitignored file: enumeration is `git ls-files --cached --others
 *     --exclude-standard`, i.e. tracked files plus untracked-but-not-ignored.
 *   - Never a path matched by `code_map.exclude` — a bare name matches any
 *     path segment, a name containing `/` matches a repo-relative path prefix.
 *   - Never a test file — the `tests` namespace owns those.
 *
 * All returned paths are repo-relative with forward slashes on every platform.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Top-level directories never indexed, whatever the config says. Kept as
 * top-level prefixes (not segment matches) so a legitimate nested
 * `src/template/` is not swallowed by the `template` entry.
 */
export const BASELINE_EXCLUDE_DIRS = [
  'node_modules', 'dist', 'build', '.next', 'coverage',
  '.claude', '.swarm', '.moflo', '.git', 'template', 'back-office-template',
];

/** Same shapes `bin/index-tests.mjs` and `moflo.yaml tests.patterns` treat as tests. */
const TEST_FILE_PATTERNS = [/\.test\.\w+$/i, /\.spec\.\w+$/i, /\.test-\w+\.\w+$/i];

const DEFAULT_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', // JS/TS
  '.py', '.pyi',                                  // Python
  '.go',                                           // Go
  '.java', '.kt', '.kts',                         // JVM
  '.cs',                                           // C#
  '.rs',                                           // Rust
  '.rb',                                           // Ruby
  '.swift',                                        // Swift
  '.php',                                          // PHP
  '.c', '.h', '.cpp', '.hpp', '.cc',              // C/C++
];

/** Read the `code_map` block from moflo.yaml (directories, extensions, exclude). */
export function readCodeMapConfig(projectRoot) {
  // Unconfigured `directories` means the whole repo — the scope code-map's git
  // path and the patterns walk both had before #1497. A consumer whose
  // moflo.yaml predates `code_map` (or omits `directories`) must not silently
  // drop to `src/` only, or to nothing at all when there is no `src/` (Rule #2).
  const defaults = {
    directories: ['.'],
    extensions: [...DEFAULT_EXTENSIONS],
    exclude: [...BASELINE_EXCLUDE_DIRS],
  };
  try {
    const yamlPath = resolve(projectRoot, 'moflo.yaml');
    if (!existsSync(yamlPath)) return defaults;
    const content = readFileSync(yamlPath, 'utf-8');
    // Simple YAML parsing for code_map block
    // Indented `#` lines are allowed inside the block so a commented-out list
    // entry does not end it early and drop every entry after it.
    const block = content.match(/code_map:\s*\n((?:\s+\w+:.*\n?|\s+- .*\n?|[ \t]+#.*\n?)+)/);
    if (!block) return defaults;
    const lines = block[1].split('\n');
    let currentKey = null;
    const result = { ...defaults };
    for (const line of lines) {
      const keyMatch = line.match(/^\s+(\w+):/);
      const itemMatch = line.match(/^\s+- (.+)/);
      if (keyMatch) {
        currentKey = keyMatch[1];
        // Inline array: extensions: [".ts", ".tsx"]
        const inlineArray = line.match(/\[([^\]]+)\]/);
        if (inlineArray && (currentKey === 'extensions' || currentKey === 'exclude' || currentKey === 'directories')) {
          result[currentKey] = inlineArray[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
        } else if (currentKey === 'directories' || currentKey === 'exclude' || currentKey === 'extensions') {
          // Block list follows — start from empty rather than appending to the defaults.
          result[currentKey] = [];
        }
      } else if (itemMatch && currentKey) {
        if (!Array.isArray(result[currentKey])) result[currentKey] = [];
        result[currentKey].push(itemMatch[1].trim().replace(/^["']|["']$/g, ''));
      }
    }
    return result;
  } catch { return defaults; }
}

/** Normalise a config path to repo-relative forward-slash form ('' = repo root). */
function normRel(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '').replace(/^\.$/, '');
}

// Rule #1: NTFS and APFS are case-insensitive by default, so `Src/` in config
// must still match git's `src/...` there. Linux compares exactly.
const foldCase = process.platform === 'win32' || process.platform === 'darwin'
  ? (s) => s.toLowerCase()
  : (s) => s;

const underPrefix = (path, prefix) => prefix === '' || path === prefix || path.startsWith(prefix + '/');

export function isTestFile(relPath) {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  return TEST_FILE_PATTERNS.some(p => p.test(name));
}

/**
 * Build the in-scope predicate for a repo-relative forward-slash path.
 * Exported for tests; indexers should call {@link listScopedSourceFiles}.
 */
export function createScopeFilter(config) {
  const dirs = (config.directories || []).map(d => foldCase(normRel(d)));
  const exts = new Set((config.extensions || []).map(e => e.toLowerCase()));
  const excludeNames = new Set();
  const excludePrefixes = [];
  for (const raw of config.exclude || []) {
    const e = foldCase(normRel(raw));
    if (!e) continue;
    if (e.includes('/')) excludePrefixes.push(e);
    else excludeNames.add(e);
  }
  const baseline = BASELINE_EXCLUDE_DIRS.map(foldCase);

  return (relPath) => {
    const p = foldCase(relPath);
    if (!exts.has(extname(p).toLowerCase())) return false;
    if (!dirs.some(d => underPrefix(p, d))) return false;
    if (baseline.some(b => p.startsWith(b + '/'))) return false;
    if (excludePrefixes.some(e => underPrefix(p, e))) return false;
    const segments = p.split('/');
    if (segments.some(s => excludeNames.has(s))) return false;
    return !isTestFile(p);
  };
}

/**
 * Git enumeration: tracked files plus untracked-but-not-ignored files, so a
 * gitignored build artefact is never returned and a brand-new source file is.
 * Returns null when git is unavailable or this is not a work tree.
 */
function gitListFiles(projectRoot, extensions) {
  // `:(icase)` — git pathspec globs are case-sensitive regardless of
  // `core.ignorecase`, so a bare `*.mjs` would miss a committed `Foo.MJS` (#1337).
  const pathspecGlobs = extensions.map(ext => `:(icase)*${ext}`);
  try {
    const raw = execFileSync(
      'git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...pathspecGlobs],
      // stderr ignored: "not a git repository" is the expected fallback signal,
      // not something to print into a consumer's session-start output.
      {
        cwd: projectRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    if (!raw) return null;
    // --cached + --others can list a path twice (e.g. mid-merge); the caller dedupes.
    return raw.split('\n').map(f => f.replace(/\\/g, '/'));
  } catch {
    return null;
  }
}

/**
 * Filesystem fallback: walk each configured directory. Only the two trees that
 * are never source are pruned here (for speed); the scope filter decides the rest.
 */
const WALK_PRUNE = new Set(['node_modules', '.git']);

function walkFiles(projectRoot, rel, maxDepth = 8, depth = 0, out = []) {
  if (depth > maxDepth) return out;
  let entries;
  try {
    entries = readdirSync(resolve(projectRoot, rel || '.'), { withFileTypes: true });
  } catch { return out; }
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (WALK_PRUNE.has(entry.name)) continue;
      walkFiles(projectRoot, child, maxDepth, depth + 1, out);
    } else if (entry.isFile()) {
      out.push(child);
    }
  }
  return out;
}

/**
 * Every in-scope source file, repo-relative with forward slashes, sorted.
 *
 * @param {string} projectRoot
 * @param {{ extensions?: string[], config?: object, onFallback?: () => void }} [opts]
 *   `extensions` overrides `code_map.extensions` (patterns has its own list);
 *   `config` bypasses the moflo.yaml read (tests).
 */
export function listScopedSourceFiles(projectRoot, opts = {}) {
  const config = { ...(opts.config || readCodeMapConfig(projectRoot)) };
  if (opts.extensions) config.extensions = opts.extensions;
  const inScope = createScopeFilter(config);

  let candidates = gitListFiles(projectRoot, config.extensions);
  if (!candidates) {
    opts.onFallback?.();
    candidates = [];
    for (const dir of config.directories) {
      const rel = normRel(dir);
      if (existsSync(resolve(projectRoot, rel || '.'))) walkFiles(projectRoot, rel, 8, 0, candidates);
    }
  }
  return [...new Set(candidates.filter(inScope))].sort();
}
