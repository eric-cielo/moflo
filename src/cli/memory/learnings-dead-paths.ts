/**
 * Dead-path nomination for the learnings audit (#1479).
 *
 * The audit's other three passes read prose shape — how similar two entries
 * are, how long one has gone unused, whether it speaks a retired word. This one
 * reads ground truth: a repo-relative path an entry cites either resolves in the
 * tree or it does not. That also makes it the only pass that is portable across
 * consumers — it resolves against the consumer's own tree and carries no
 * project-specific data, unlike a vocabulary list.
 *
 * **It nominates, it never decides.** A dead path has four causes and only a
 * reader can tell them apart. See {@link findDeadPaths}.
 *
 * Pure by construction, like `learnings-audit.ts`: resolution is injected as a
 * predicate, so nothing here touches a disk. The filesystem half lives in
 * `memory/learnings-tree.ts`.
 *
 * @module memory/learnings-dead-paths
 */

// Pure string composition, no disk: `path.posix.join` puts a workspace prefix in
// front of a cited path. `posix` specifically, because the separator inside a
// learning is whatever its author typed — `/` on every platform in practice — so
// it is a wire format, not a host path. The host separator is applied once, at
// the filesystem boundary in `memory/learnings-tree.ts`, with `path.join` (Rule #1).
import { posix as posixPath } from 'path';

import type { AuditRow } from './learnings-audit.js';

/**
 * How many unresolved paths are recorded per entry.
 *
 * Evidence, not an inventory: an entry citing thirty dead paths is nominated by
 * the first few just as decisively, and the rest would only inflate the judge
 * prompt this whole design exists to keep bounded.
 */
export const DEFAULT_DEAD_PATHS_PER_ENTRY = 5;

/** A URL is not a tree path, and plenty of them end in `.json` or `.md`. */
const URL_LIKE = /\S+:\/\/\S+/g;

/** A glob is a pattern; there is nothing to look up. */
const GLOB_LIKE = /\S*\*\S*/g;

/**
 * A path-shaped token: two or more segments joined by a separator.
 *
 * Group 1 pins the character BEFORE the token and rejects the ones that mean
 * "not repo-relative" — a leading separator (`/tmp/x.log`), a home marker
 * (`~/.claude/settings.json`), a drive colon (`C:\Users\x\y.ts`), or a longer
 * path this token is merely the tail of. Backslashes are accepted on input and
 * normalised away, because a learning written on Windows says `src\cli\x.ts`.
 */
const PATH_TOKEN = /(^|[^A-Za-z0-9._~@+\-/\\:])([A-Za-z0-9._~@+-]+(?:[/\\][A-Za-z0-9._~@+-]+)+[/\\]?)/g;

/** Sentence punctuation that rides along on a path at the end of a clause. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"`]+$/;

/** A file extension, which is what separates `src/foo.ts` from `and/or`. */
const FILE_EXTENSION = /\.[A-Za-z0-9]{1,10}$/;

/**
 * An environment variable standing in for a path root —
 * `CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs`. The underscore is required, so
 * an ordinary shouted directory (`API/v1.json`, `README/notes.md`) is untouched.
 */
const ENV_VAR_SEGMENT = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/**
 * Normalise one matched token, or reject it as unscoreable.
 *
 * Rejections are the load-bearing half. A detector whose output is mostly false
 * positives gets ignored wholesale, so anything whose resolution would say
 * something about the environment rather than about the entry is dropped here:
 *
 * - `node_modules/...` resolves or not depending on whether anyone has run an
 *   install in this checkout. That is a fact about the checkout, not the entry.
 * - An absolute, home-relative, or parent-relative path is not repo-relative,
 *   so resolving it against the project root would be meaningless.
 * - A bare filename (`package.json`) and an extensionless pair (`and/or`,
 *   `KEEP/RETIRE`) are too ambiguous to score at all.
 * - A path rooted at an environment variable resolves to wherever that variable
 *   points, which is not this tree.
 */
function normalizeCandidate(raw: string): string | null {
  let candidate = raw.replace(TRAILING_PUNCTUATION, '').replace(/\\/g, '/');
  if (candidate.startsWith('./')) candidate = candidate.slice(2);
  if (!candidate || candidate.startsWith('/') || candidate.startsWith('~') || candidate.startsWith('../')) {
    return null;
  }
  if (candidate.includes('//')) return null;

  const lower = candidate.toLowerCase();
  if (lower.startsWith('node_modules/') || lower.includes('/node_modules/')) return null;

  if (ENV_VAR_SEGMENT.test(candidate.split('/')[0])) return null;

  const isDirectory = candidate.endsWith('/');
  const body = isDirectory ? candidate.slice(0, -1) : candidate;
  if (!body.includes('/')) return null;
  if (!isDirectory && !FILE_EXTENSION.test(body)) return null;
  return candidate;
}

/**
 * Pull the repo-relative paths an entry cites, deduplicated, in first-seen
 * order.
 *
 * Exported because it is where every false positive would come from: the rules
 * above are only checkable by driving prose at them directly.
 */
export function extractCandidatePaths(content: string): string[] {
  // Blank URLs and globs out of the text BEFORE tokenising. Filtering them
  // afterwards does not work — a URL's own path tail tokenises cleanly on its
  // own and would survive as `docs/spec.md`.
  const text = String(content ?? '').replace(URL_LIKE, ' ').replace(GLOB_LIKE, ' ');

  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(PATH_TOKEN)) {
    const candidate = normalizeCandidate(match[2]);
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

/** Filesystem access for the dead-path pass, injected so this module stays pure. */
export interface DeadPathScanOptions {
  /**
   * Does this repo-relative, forward-slash path resolve to anything in the
   * tree? File or directory — a moved file and a moved directory are the same
   * finding.
   */
  resolves: (relativePath: string) => boolean;
  /**
   * Workspace directories to retry an unresolved path under, e.g.
   * `['packages/api', 'apps/web']`. See {@link resolvesInTree} for why this is
   * not optional in practice.
   */
  workspacePrefixes?: readonly string[];
  /** Per-entry evidence cap. Defaults to {@link DEFAULT_DEAD_PATHS_PER_ENTRY}. */
  maxPathsPerEntry?: number;
}

/**
 * Resolve a cited path as written, then under each workspace prefix.
 *
 * The second pass is what makes the detector usable rather than noise. A
 * learning is authored from inside a workspace and routinely cites
 * `src/routes/foo.ts` meaning `packages/api/src/routes/foo.ts`; without the
 * retry every such citation reads as dead. The reference implementation this
 * pass is ported from measured that single omission taking its findings from
 * 103 entries to 261 — an auditor that is wrong more often than right gets
 * ignored wholesale, which costs the other three buckets their audience too.
 *
 * A prefix the path already carries is skipped: retrying `packages/api/x.ts`
 * under `packages/api` only ever asks about `packages/api/packages/api/x.ts`.
 */
export function resolvesInTree(
  relativePath: string,
  resolves: (relativePath: string) => boolean,
  workspacePrefixes: readonly string[] = [],
): boolean {
  return resolvesUnder(relativePath, resolves, normalizePrefixes(workspacePrefixes));
}

/**
 * Put a prefix list into the one form {@link resolvesUnder} can compose with.
 *
 * Hoisted out of the resolution loop deliberately: the prefix list is the same
 * for every candidate in the store, so normalising inside the loop would repeat
 * this work once per candidate per prefix for no answer that changes.
 */
function normalizePrefixes(workspacePrefixes: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of workspacePrefixes) {
    const prefix = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (prefix) out.push(prefix);
  }
  return out;
}

/** {@link resolvesInTree} over an already-normalised prefix list. */
function resolvesUnder(
  relativePath: string,
  resolves: (relativePath: string) => boolean,
  prefixes: readonly string[],
): boolean {
  if (resolves(relativePath)) return true;

  for (const prefix of prefixes) {
    if (relativePath === prefix || relativePath.startsWith(`${prefix}/`)) continue;
    if (resolves(posixPath.join(prefix, relativePath))) return true;
  }

  return false;
}

/**
 * Nominate entries citing paths that resolve nowhere.
 *
 * **This nominates, it never decides.** A dead path has four causes and only a
 * reader can tell them apart: the file moved and the lesson still holds, the
 * file was deleted and the lesson was about that code, the file was deleted but
 * the lesson generalises, or the entry is a historical record that is correct as
 * written. The move case is the common one, which is why reading "dead path" as
 * "retire" throws away lessons that are still entirely true. The verdict table
 * goes to the model in {@link buildJudgePrompt}.
 *
 * Resolution is memoised across the whole store, not per entry: the same file is
 * cited by many learnings, and every miss costs one lookup per workspace prefix.
 */
export function findDeadPaths(
  rows: readonly AuditRow[],
  options: DeadPathScanOptions,
): Array<{ row: AuditRow; deadPaths: string[] }> {
  const prefixes = normalizePrefixes(options.workspacePrefixes ?? []);
  const maxPerEntry = Math.max(1, options.maxPathsPerEntry ?? DEFAULT_DEAD_PATHS_PER_ENTRY);
  const resolved = new Map<string, boolean>();
  const found: Array<{ row: AuditRow; deadPaths: string[] }> = [];

  for (const row of rows) {
    const deadPaths: string[] = [];
    for (const candidate of extractCandidatePaths(row.content)) {
      let alive = resolved.get(candidate);
      if (alive === undefined) {
        alive = resolvesUnder(candidate, options.resolves, prefixes);
        resolved.set(candidate, alive);
      }
      if (alive) continue;
      deadPaths.push(candidate);
      if (deadPaths.length >= maxPerEntry) break;
    }
    if (deadPaths.length > 0) found.push({ row, deadPaths });
  }

  return found;
}
