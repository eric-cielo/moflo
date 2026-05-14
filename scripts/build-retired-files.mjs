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
 *     cap that left pre-cutoff consumer installs un-prunable (#1133).
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
  const existing = new Map(manifest.retired.map((e) => [e.path, e]));
  const deletionCommits = findDeletionCommits();
  let added = 0;
  let updated = 0;
  for (const { commit, deletedPaths } of deletionCommits) {
    const retiredIn = versionAtCommit(commit);
    const retiredBy = findRetirementPrFromCommitMessage(commit);
    for (const path of deletedPaths) {
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
  process.stdout.write(`retired-files.json: +${added} added, ${updated} updated, ${manifest.retired.length} total\n`);
}

function addOne(args) {
  const path = args.path;
  if (!path) throw new Error('--add requires <path>');
  if (!TARGET_PREFIXES.some((p) => path.startsWith(p))) {
    throw new Error(`--add <path> must start with one of: ${TARGET_PREFIXES.join(', ')}`);
  }
  const manifest = loadManifest();
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
 */
function rebuild() {
  const manifest = loadManifest();
  let updated = 0;
  let unchanged = 0;
  let orphaned = 0;
  let totalHashesBefore = 0;
  let totalHashesAfter = 0;
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
    `${manifest.retired.length} total entries; hashes ${totalHashesBefore} → ${totalHashesAfter}\n`,
  );
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

// Exports kept narrow — tests need to exercise hash walking and the rebuild
// loop, but seed()/addOne() drive end-user side effects (writing the manifest)
// that tests cover via subprocess spawn rather than direct call.
export { hashesForPath, sha256, loadManifest, manifestPath, repoRoot };

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
