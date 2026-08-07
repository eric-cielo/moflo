#!/usr/bin/env node
/**
 * Build / regenerate `retired-files.json` from git history.
 *
 * Three modes:
 *
 *   --seed
 *     Walk git log for every commit that deleted a `.claude/agents/**\/*.md`
 *     or `.claude/skills/**\/*.md` file, and emit one entry per deleted path
 *     with every unique content hash from the path's pre-deletion history.
 *     Used once to bootstrap the file from the `#932` and `#945` retirements
 *     called out in issue #948, plus older retirements still on consumer disk.
 *
 *   --add <path> --retired-by <#nnn> [--retired-in <ver>]
 *     Append (or update) one entry. Used by `flo retire`. Resolves the
 *     `retiredIn` from the current `package.json` version when not provided.
 *
 *   --rebuild-hashes
 *     Re-derive `knownContentHashes[]` for every existing entry from full
 *     git history. Used to backfill entries written under the legacy 3-hash
 *     cap that left pre-cutoff consumer installs un-prunable (#1133), and to
 *     drop entries whose path has since been restored to the tree (#1414).
 *
 * Every mode upholds one invariant: an entry may never name a path moflo still
 * ships. Such an entry can only resolve to "customized, retained" on every
 * consumer forever, because its hashes predate the content the package now
 * installs. `tests/guards/retired-manifest-shipped-path-guard.test.ts` enforces
 * it at build time; `bin/lib/retired-files.mjs` skips violators at run time.
 *
 * The `version: 1` schema lives at the moflo package root and ships to
 * consumers via package.json `files`. Launcher reads it on every upgrade
 * and prunes only paths whose on-disk content hash matches a known-shipped
 * value (see bin/lib/retired-files.mjs).
 *
 * @module scripts/build-retired-files
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const manifestPath = resolve(repoRoot, 'retired-files.json');

const TARGET_PREFIXES = ['.claude/agents/', '.claude/skills/', '.claude/commands/'];

function gitOk(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
}
function gitOkOrEmpty(args) {
  // Pipe stderr to /dev/null equivalent — `git show <sha>:<path>` and
  // `git log <range> -- <path>` both write "fatal: ..." to stderr when the
  // path didn't exist at that ancestor, which is the *expected* signal
  // (older commits predate the file). Surfacing it would drown the
  // success summary in a few hundred lines of noise.
  try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
}

function sha256(buf) {
  return 'sha256:' + createHash('sha256').update(buf).digest('hex');
}

/**
 * Set-union of two ordered hash lists, preserving the first occurrence of
 * each hash (so the caller can put newly-discovered hashes first). Used in
 * every merge site so the de-dup invariant lives in one place.
 */
function unionHashes(a, b) {
  return Array.from(new Set([...a, ...b]));
}

/**
 * Paths git tracks, `/`-separated exactly as git reports them. Computed once —
 * every caller below asks the same question of the same tree.
 *
 * `-z` because git quote-escapes non-ASCII paths under the default
 * `core.quotePath`, and a mangled entry would silently read as "not tracked".
 */
let trackedPathsCache = null;
function trackedPaths() {
  if (trackedPathsCache) return trackedPathsCache;
  const NUL = String.fromCharCode(0);
  trackedPathsCache = new Set(gitOk(['ls-files', '-z']).split(NUL).filter(Boolean));
  return trackedPathsCache;
}

/**
 * True when moflo ships `path` again under the same name — deleted at some
 * point, but back in the tree. See the module header for why such an entry can
 * never be correct.
 *
 * Gate on the TRACKED tree, not `existsSync`. Dropping an entry is destructive
 * and irreversible, and an untracked stray under `.claude/agents/` — precisely
 * what Mechanism A leaves behind when dogfooding — would otherwise make
 * `--rebuild-hashes` delete a legitimate retirement. Tracked is also what the
 * npm tarball ships and what `tests/guards/retired-manifest-shipped-path-guard.test.ts`
 * asserts, so the author-time and build-time predicates cannot disagree.
 */
function isResurrected(path) {
  return trackedPaths().has(path.replace(/\\/g, '/'));
}

/**
 * Remove every entry whose path is back in the tree, returning the dropped
 * paths. Shared by `--seed` and `--rebuild-hashes` so neither can leave a
 * contradiction the other would have cleaned.
 */
function dropResurrected(manifest) {
  const dropped = [];
  manifest.retired = manifest.retired.filter((entry) => {
    if (!isResurrected(entry.path)) return true;
    dropped.push(entry.path);
    return false;
  });
  return dropped;
}

/**
 * Most recent commit that DELETED `path`, or `null` if the path is still
 * tracked. Returned as a raw commit sha — callers fall back to `HEAD` when
 * preparing an entry for a file that hasn't been committed-deleted yet.
 */
function findDeletionCommit(path) {
  const log = gitOkOrEmpty(['log', '--diff-filter=D', '--pretty=format:%H', '-n', '1', '--', path]);
  return log.trim() || null;
}

/**
 * Load existing manifest, or return a fresh one. Validates shape so a
 * hand-edit doesn't get silently corrupted on the next regen.
 */
function loadManifest() {
  if (!existsSync(manifestPath)) return { version: 1, retired: [] };
  const raw = readFileSync(manifestPath, 'utf-8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) {
    throw new Error(`retired-files.json is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.retired)) {
    throw new Error('retired-files.json missing required `retired: []` field');
  }
  return parsed;
}

function writeManifest(manifest) {
  // Stable ordering: sort by path so diffs in PRs are reviewable.
  manifest.retired.sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

/**
 * Find every commit that DELETED a file under one of TARGET_PREFIXES.
 * Returns `[{ commit, deletedPaths: [...] }]` newest-first.
 */
function findDeletionCommits() {
  const log = gitOk(['log', '--diff-filter=D', '--name-only', '--pretty=format:::COMMIT::%H']);
  const commits = [];
  let current = null;
  for (const line of log.split('\n')) {
    if (line.startsWith('::COMMIT::')) {
      if (current) commits.push(current);
      current = { commit: line.slice('::COMMIT::'.length), deletedPaths: [] };
      continue;
    }
    if (!line.trim()) continue;
    if (TARGET_PREFIXES.some((p) => line.startsWith(p))) {
      if (line.endsWith('.md')) current?.deletedPaths.push(line);
    }
  }
  if (current) commits.push(current);
  return commits.filter((c) => c.deletedPaths.length > 0);
}

/**
 * Get every unique content hash for `path` reachable from `sinceRef`, newest
 * first. No commit cap — narrow hash windows produced silent prune-misses on
 * consumers whose installed moflo predated the cap (#1133). Pass the deletion
 * commit when the path is gone, or `HEAD` when it still exists.
 *
 * Commits where the file was deleted (or did not yet exist) raise `git show`
 * errors that we swallow — `gitOkOrEmpty` already routes those to /dev/null.
 */
function hashesForPath(path, sinceRef) {
  const log = gitOkOrEmpty(['log', '--pretty=format:%H', sinceRef, '--', path]);
  const commits = log.split('\n').map((c) => c.trim()).filter(Boolean);
  const hashes = [];
  const seen = new Set();
  for (const commit of commits) {
    let content;
    try {
      content = execFileSync(
        'git',
        ['show', `${commit}:${path}`],
        { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch { continue; }
    const h = sha256(content);
    if (seen.has(h)) continue;
    seen.add(h);
    hashes.push(h);
  }
  return hashes;
}

/**
 * Resolve a moflo version for a commit. Reads package.json at that commit
 * (or its parent if the deletion commit itself bumped the version).
 */
function versionAtCommit(commit) {
  const pkgRaw = gitOkOrEmpty(['show', `${commit}:package.json`]);
  if (!pkgRaw) return null;
  try { return JSON.parse(pkgRaw).version || null; } catch { return null; }
}

function findRetirementPrFromCommitMessage(commit) {
  const msg = gitOkOrEmpty(['log', '-1', '--pretty=format:%s%n%b', commit]);
  const m = msg.match(/(?:fix|chore|feat|refactor)\((#\d+)\)/i)
    || msg.match(/\((#\d+)\)/);
  return m ? m[1] : null;
}

function seed() {
  const manifest = loadManifest();
  // Clean before walking. Skipping resurrected paths during the walk stops new
  // contradictions entering, but says nothing about ones already recorded — a
  // seed that reported "10 skipped" while leaving all 10 in place would read as
  // handled when nothing had been fixed.
  const dropped = dropResurrected(manifest);
  const existing = new Map(manifest.retired.map((e) => [e.path, e]));
  const deletionCommits = findDeletionCommits();
  let added = 0;
  let updated = 0;
  const skipped = new Set();
  for (const { commit, deletedPaths } of deletionCommits) {
    const retiredIn = versionAtCommit(commit);
    const retiredBy = findRetirementPrFromCommitMessage(commit);
    for (const path of deletedPaths) {
      // The path was deleted here but is back in the tree — moflo ships it
      // again, so it is not retired and must not enter the manifest (#1414).
      // Counted in a Set: a delete → restore → delete path appears in several
      // deletion commits and would otherwise inflate the tally.
      if (isResurrected(path)) { skipped.add(path); continue; }
      // Walk from the deletion commit itself — `git show <deletion>:<path>`
      // raises (path absent at deletion) and is skipped, while every prior
      // touch of the file is enumerated. Full history, no cap (#1133).
      const hashes = hashesForPath(path, commit);
      if (hashes.length === 0) continue;
      const prior = existing.get(path);
      if (prior) {
        // Merge: keep newly-discovered hashes (newest-first) and union with
        // anything prior runs recorded that this walk didn't surface.
        const merged = unionHashes(hashes, prior.knownContentHashes);
        const sameAsPrior = merged.length === prior.knownContentHashes.length &&
          merged.every((h, i) => h === prior.knownContentHashes[i]);
        if (!sameAsPrior) {
          prior.knownContentHashes = merged;
          updated++;
        }
        continue;
      }
      const entry = { path, knownContentHashes: hashes };
      if (retiredIn) entry.retiredIn = retiredIn;
      if (retiredBy) entry.retiredBy = retiredBy;
      manifest.retired.push(entry);
      existing.set(path, entry);
      added++;
    }
  }
  writeManifest(manifest);
  process.stdout.write(
    `retired-files.json: +${added} added, ${updated} updated, ${skipped.size} skipped and ` +
    `${dropped.length} dropped (path restored), ${manifest.retired.length} total\n`,
  );
  for (const path of dropped) {
    process.stdout.write(`  dropped ${path} — still shipped, so not retired\n`);
  }
}

function addOne(args) {
  const path = args.path;
  if (!path) throw new Error('--add requires <path>');
  if (!TARGET_PREFIXES.some((p) => path.startsWith(p))) {
    throw new Error(`--add <path> must start with one of: ${TARGET_PREFIXES.join(', ')}`);
  }
  const manifest = loadManifest();
  // git still tracks the path, so the deletion has not been staged yet. That is
  // legitimate mid-PR — `flo retire` is meant to be usable before the deletion
  // is committed — but it is also exactly how a still-shipped path lands in the
  // manifest (#1414), and nothing here can tell the two apart until CI sees the
  // merged tree. Warn rather than refuse, and name the guard that decides.
  if (isResurrected(path)) {
    process.stderr.write(
      `warning: ${path} is still tracked by git — the deletion is not staged.\n` +
      `  Retiring a path moflo still ships produces a permanent "customized retired file"\n` +
      `  notice in every consumer. Make sure the deletion lands in this PR —\n` +
      `  tests/guards/retired-manifest-shipped-path-guard.test.ts fails the build otherwise.\n`,
    );
  }
  // Walk from the deletion commit (the file is gone) or from HEAD (file
  // still tracked because the user is preparing the entry on a branch where
  // the deletion isn't committed yet).
  const sinceRef = findDeletionCommit(path) || 'HEAD';
  // Full reachable history of the path — every unique content hash that
  // ever shipped, not a 3-deep window that misses pre-cutoff installs (#1133).
  const hashes = hashesForPath(path, sinceRef);
  if (hashes.length === 0 && sinceRef === 'HEAD') {
    // Working-tree fallback for the brand-new-uncommitted-file case: file
    // exists on disk but `git log HEAD -- <path>` returned nothing (path was
    // never committed). Keeps `flo retire` usable on an in-progress branch
    // where creation and retirement land in the same PR.
    const abs = resolve(repoRoot, path);
    if (existsSync(abs)) hashes.push(sha256(readFileSync(abs)));
  }
  if (hashes.length === 0) {
    throw new Error(`no content hashes resolvable for ${path}`);
  }
  const retiredIn = args['retired-in'] || (() => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'));
    return pkg.version;
  })();
  const retiredBy = args['retired-by'] || null;
  const existing = manifest.retired.find((e) => e.path === path);
  if (existing) {
    // Union with prior — keep newly-discovered hashes newest-first, then
    // anything the prior run recorded that this walk didn't surface.
    existing.knownContentHashes = unionHashes(hashes, existing.knownContentHashes);
    if (retiredBy) existing.retiredBy = retiredBy;
    if (retiredIn) existing.retiredIn = retiredIn;
  } else {
    const entry = { path, knownContentHashes: hashes };
    if (retiredIn) entry.retiredIn = retiredIn;
    if (retiredBy) entry.retiredBy = retiredBy;
    manifest.retired.push(entry);
  }
  writeManifest(manifest);
  process.stdout.write(`retired-files.json: ${existing ? 'updated' : 'added'} ${path} (${hashes.length} hash${hashes.length === 1 ? '' : 'es'})\n`);
}

/**
 * Recompute `knownContentHashes[]` for every existing entry from full git
 * history. Used once to backfill entries written under the legacy 3-hash cap
 * that left pre-cutoff consumer installs un-prunable (#1133).
 *
 * Entries with no resolvable git history are reported but left alone — the
 * existing hashes may still be load-bearing for some consumer.
 *
 * Entries whose path is back in the tree ARE dropped (#1414). Re-deriving
 * hashes for a path moflo still ships cannot make the entry correct — the
 * consumer's copy is the current shipped content by construction, so the entry
 * can only ever resolve to "customized, retained". This is the heal command the
 * build-time guard points at.
 */
function rebuild() {
  const manifest = loadManifest();
  let updated = 0;
  let unchanged = 0;
  let orphaned = 0;
  let totalHashesBefore = 0;
  let totalHashesAfter = 0;
  const dropped = dropResurrected(manifest);
  for (const entry of manifest.retired) {
    const prior = entry.knownContentHashes || [];
    totalHashesBefore += prior.length;
    const sinceRef = findDeletionCommit(entry.path) || 'HEAD';
    const fresh = hashesForPath(entry.path, sinceRef);
    // Union: never narrow the set — a prior-recorded hash might pre-date a
    // history rewrite (shallow clone, filter-branch) we can't replay here.
    const merged = unionHashes(fresh, prior);
    totalHashesAfter += merged.length;
    if (merged.length === 0) {
      orphaned++;
      continue;
    }
    const sameAsPrior = merged.length === prior.length &&
      merged.every((h, i) => h === prior[i]);
    if (sameAsPrior) {
      unchanged++;
      continue;
    }
    entry.knownContentHashes = merged;
    updated++;
  }
  writeManifest(manifest);
  process.stdout.write(
    `retired-files.json: ${updated} updated, ${unchanged} unchanged, ${orphaned} no-resolvable-history, ` +
    `${dropped.length} dropped (path restored), ` +
    `${manifest.retired.length} total entries; hashes ${totalHashesBefore} → ${totalHashesAfter}\n`,
  );
  for (const path of dropped) {
    process.stdout.write(`  dropped ${path} — still shipped, so not retired\n`);
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// Exports kept narrow — tests need to exercise hash walking, the resurrection
// predicate, and the deletion walk, but seed()/addOne()/rebuild() drive
// end-user side effects (rewriting the tracked manifest) that a test must not
// trigger: the guard suite reads retired-files.json concurrently.
export { hashesForPath, sha256, loadManifest, manifestPath, repoRoot, isResurrected, findDeletionCommits };

// CLI dispatch fires only when invoked directly, not when imported by tests.
// Empty argv[1] (no script path on the command line — e.g. `node -e ...`)
// must NOT match: `pathToFileURL('')` resolves to the cwd URL, which would
// false-positive in some embed paths. Guard explicitly.
const isMain = !!process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.seed) {
    seed();
  } else if (args.add) {
    addOne({ path: args.add, ...args });
  } else if (args['rebuild-hashes']) {
    rebuild();
  } else {
    process.stderr.write(
      'Usage:\n' +
      '  node scripts/build-retired-files.mjs --seed\n' +
      '  node scripts/build-retired-files.mjs --add <path> --retired-by <#nnn> [--retired-in <ver>]\n' +
      '  node scripts/build-retired-files.mjs --rebuild-hashes\n',
    );
    process.exit(1);
  }
}
