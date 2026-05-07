#!/usr/bin/env node
/**
 * Build / regenerate `retired-files.json` from git history.
 *
 * Two modes:
 *
 *   --seed
 *     Walk git log for every commit that deleted a `.claude/agents/**\/*.md`
 *     or `.claude/skills/**\/*.md` file, and emit one entry per deleted path
 *     with up to N content hashes from the immediate-pre-deletion versions.
 *     Used once to bootstrap the file from the `#932` and `#945` retirements
 *     called out in issue #948, plus older retirements still on consumer disk.
 *
 *   --add <path> --retired-by <#nnn> [--retired-in <ver>] [--hashes <n>]
 *     Append (or update) one entry. Used by `flo retire`. Resolves the
 *     `retiredIn` from the current `package.json` version when not provided.
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
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const manifestPath = resolve(repoRoot, 'retired-files.json');

const MAX_HASHES_DEFAULT = 3;
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
 * Get the last N unique content hashes for a path before its deletion at
 * `deletionCommit`. Walks commits-that-touched-the-file backwards from the
 * deletion's parent.
 */
function hashesForPath(path, deletionCommit, maxHashes) {
  const parent = `${deletionCommit}^`;
  // List up to 10 commits that touched the file, newest first
  const log = gitOkOrEmpty(['log', '--pretty=format:%H', '-n', '10', parent, '--', path]);
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
    if (hashes.length >= maxHashes) break;
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
      const hashes = hashesForPath(path, commit, MAX_HASHES_DEFAULT);
      if (hashes.length === 0) continue;
      const prior = existing.get(path);
      if (prior) {
        // Merge with newest-first ordering. The slice() cap at the end
        // discards the OLDEST hashes when the union exceeds the limit —
        // most consumers run a moflo within the last few releases of the
        // retirement, so the most-recent shipped versions are the most
        // useful matches. Putting `hashes` (this run's discoveries) first
        // ensures they win over prior cached hashes when the cap bites.
        const merged = Array.from(new Set([...hashes, ...prior.knownContentHashes]));
        const capped = merged.slice(0, MAX_HASHES_DEFAULT);
        // Bump `updated` only when the on-disk set actually changes —
        // a no-op merge (same hashes, same order) shouldn't lie to the
        // summary line.
        const sameAsPrior = capped.length === prior.knownContentHashes.length &&
          capped.every((h, i) => h === prior.knownContentHashes[i]);
        if (!sameAsPrior) {
          prior.knownContentHashes = capped;
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
  // Find the deletion commit (most recent commit that DELETED the path).
  // Falls back to HEAD if the path is still present (the user is preparing
  // the entry while the deletion is still uncommitted on a branch).
  const deletionLog = gitOkOrEmpty(['log', '--diff-filter=D', '--pretty=format:%H', '-n', '1', '--', path]);
  const deletionCommit = deletionLog.trim() || 'HEAD';
  const maxHashes = Number(args.hashes) > 0 ? Number(args.hashes) : MAX_HASHES_DEFAULT;
  let hashes;
  if (deletionCommit === 'HEAD') {
    // File still tracked — current content is the only known-shipped hash
    const abs = resolve(repoRoot, path);
    if (!existsSync(abs)) {
      throw new Error(`path not found and no deletion commit: ${path}`);
    }
    hashes = [sha256(readFileSync(abs))];
  } else {
    hashes = hashesForPath(path, deletionCommit, maxHashes);
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
    // Newest-first merge — see seed() for rationale.
    existing.knownContentHashes = Array.from(
      new Set([...hashes, ...existing.knownContentHashes]),
    ).slice(0, maxHashes);
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

const args = parseArgs(process.argv.slice(2));
if (args.seed) {
  seed();
} else if (args.add) {
  addOne({ path: args.add, ...args });
} else {
  process.stderr.write(
    'Usage:\n' +
    '  node scripts/build-retired-files.mjs --seed\n' +
    '  node scripts/build-retired-files.mjs --add <path> --retired-by <#nnn> [--retired-in <ver>] [--hashes <n>]\n',
  );
  process.exit(1);
}
