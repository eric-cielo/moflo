/**
 * The filesystem half of the dead-path pass (#1479).
 *
 * `memory/learnings-dead-paths.ts` decides what counts as a dead path and never
 * touches a disk; this decides what "resolves" means against a real checkout.
 * Kept out of the command so the split the audit is built on — pure judgement,
 * injected I/O — survives having a second kind of I/O in it.
 *
 * Cross-platform (Rule #1): a cited path arrives in the forward-slash form
 * entries are authored with on every platform and is re-joined with `path.join`,
 * so the only string that reaches the filesystem carries the host separator.
 *
 * @module memory/learnings-tree
 */

import * as fs from 'fs';
import * as pathModule from 'path';

import { COMMON_WALK_SKIP_NAMES } from '../services/moflo-paths.js';

/**
 * Directories never offered as a workspace prefix.
 *
 * `COMMON_WALK_SKIP_NAMES` is exactly the right list and is shared rather than
 * restated so a second copy cannot drift from it: `node_modules` is skipped for
 * the same reason a `node_modules/` path is never scored — whether it resolves
 * is a fact about the checkout, not the entry — and every build or vendor output
 * in it (`dist`, `build`, `target`, `.next`, `vendor`, …) is skipped because a
 * stale one would resolve a path whose source has been deleted, which is the one
 * answer a dead-path pass must never give.
 *
 * Matched case-insensitively, as every other call site does: NTFS and APFS are
 * case-insensitive by default, so `Dist/` is the same directory (Rule #1).
 */
const PREFIX_SCAN_SKIP = COMMON_WALK_SKIP_NAMES;

/**
 * How deep below the project root a prefix may reach.
 *
 * One level is not enough in practice. Measured against moflo's own store, a
 * top-level-only retry left five of twelve nominations citing paths that plainly
 * exist — `commands/index.ts` for `src/cli/commands/index.ts`, `fl/phases.md`
 * for `.claude/skills/fl/phases.md` — because the source root a learning writes
 * relative to is `src/cli`, not `src`. Two levels reaches those; a third starts
 * resolving paths by coincidence rather than by layout, which costs real
 * findings.
 */
const MAX_PREFIX_DEPTH = 2;

/**
 * The widest a directory may be and still be descended into.
 *
 * This is what makes depth 2 affordable AND useful, and it is a statement about
 * layout rather than a budget. A directory holding one or two entries —
 * `src/` over `cli/`, `packages/` over its packages — is a container, and the
 * thing learnings write relative to is inside it. A directory holding thirty is
 * already the source root, and its children are ordinary code directories that
 * no one writes paths relative to.
 *
 * Without it, one wide scratch directory starves the whole prefix budget:
 * measured on this repo, a `tmp/` full of test fixtures took every slot after
 * the top level.
 */
const MAX_CHILDREN_TO_DESCEND = 12;

/**
 * Cap on workspace prefixes.
 *
 * Every unresolved path costs one `existsSync` per prefix. The list is built
 * most-specific-first — declared workspaces, then depth 1, then depth 2 — so the
 * cap truncates the least valuable end rather than an arbitrary one, and
 * truncating only ever costs extra nominations, never a wrong archive.
 */
export const MAX_WORKSPACE_PREFIXES = 80;

/** Immediate subdirectories of `dir`, sorted; unreadable reads as none. */
function subdirectoryNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !PREFIX_SCAN_SKIP.has(e.name.toLowerCase()))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Workspace directories an unresolved path is retried under.
 *
 * Learnings are authored from inside a workspace and routinely cite
 * `src/routes/foo.ts` meaning `packages/api/src/routes/foo.ts`. Declared
 * workspaces come first because `packages/api` is a more specific answer than
 * the bare `packages` a directory walk offers; the walk then covers the flat
 * repo, which has no manifest entry to read, and goes {@link MAX_PREFIX_DEPTH}
 * deep because the directory a learning writes relative to is usually a source
 * root nested inside a top-level one.
 *
 * Dot directories are included: `.claude/` and `.github/` hold files learnings
 * cite constantly, and the only one worth skipping is named in
 * {@link PREFIX_SCAN_SKIP}.
 *
 * Returned in forward-slash form: this is the wire format
 * `memory/learnings-dead-paths.ts` composes with, not a host path.
 */
export function listWorkspacePrefixes(projectRoot: string): string[] {
  const prefixes: string[] = [];
  const add = (value: string): void => {
    const clean = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (clean && !prefixes.includes(clean)) prefixes.push(clean);
  };

  try {
    const manifest = JSON.parse(fs.readFileSync(pathModule.join(projectRoot, 'package.json'), 'utf-8'));
    const declared: unknown = Array.isArray(manifest?.workspaces)
      ? manifest.workspaces
      : manifest?.workspaces?.packages;
    for (const glob of Array.isArray(declared) ? declared : []) {
      // `**` is left to the directory walk: expanding it means walking the whole
      // tree, and the one level `*` covers is the shape every workspace uses.
      if (typeof glob !== 'string' || glob.includes('**')) continue;
      const star = glob.indexOf('*');
      if (star === -1) {
        add(glob);
        continue;
      }
      const base = glob.slice(0, star).replace(/\/+$/, '');
      const baseDir = pathModule.join(projectRoot, ...base.split('/').filter(Boolean));
      for (const child of subdirectoryNames(baseDir)) add(base ? pathModule.posix.join(base, child) : child);
    }
  } catch {
    /* No manifest, or not JSON. The directory walk below still applies. */
  }

  // Breadth-first, so every depth-1 prefix is in the list before any depth-2 one
  // and the cap below never trades a shallower prefix for a deeper one.
  let frontier = subdirectoryNames(projectRoot);
  for (const name of frontier) add(name);

  for (let depth = 2; depth <= MAX_PREFIX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const parent of frontier) {
      // Every descent past the cap costs a `readdirSync` for a prefix the slice
      // below is about to discard.
      if (prefixes.length >= MAX_WORKSPACE_PREFIXES) break;
      const children = subdirectoryNames(pathModule.join(projectRoot, ...parent.split('/')));
      if (children.length > MAX_CHILDREN_TO_DESCEND) continue;
      for (const child of children) {
        const nested = pathModule.posix.join(parent, child);
        next.push(nested);
        add(nested);
      }
    }
    frontier = next;
  }

  return prefixes.slice(0, MAX_WORKSPACE_PREFIXES);
}

/**
 * Existence check for one repo-relative path cited by a learning.
 *
 * Rule #1: the path arrives in the forward-slash form entries are authored with
 * on every platform, is split on that, and is re-joined with `path.join`, so the
 * string reaching the filesystem carries the host separator and this file never
 * writes one. A file OR a directory counts — a moved directory is the same
 * finding as a moved file.
 *
 * Existence is the host's own answer, case-folding included, so a citation that
 * differs from the real file only in case reads as alive on NTFS/APFS and dead
 * on a case-sensitive filesystem. That is deliberate: matching the platform is
 * the only defensible definition of "still in the tree", and the divergence can
 * only change whether an entry is NOMINATED — never whether one is archived,
 * which takes a model verdict either way.
 */
export function makeTreeResolver(projectRoot: string): (relativePath: string) => boolean {
  return (relativePath: string): boolean => {
    const segments = relativePath.split('/').filter((s) => s.length > 0 && s !== '.');
    // A traversal segment would resolve outside the project entirely, so it can
    // say nothing about whether the repo still contains the cited file.
    if (segments.length === 0 || segments.includes('..')) return false;
    try {
      return fs.existsSync(pathModule.join(projectRoot, ...segments));
    } catch {
      return false;
    }
  };
}
