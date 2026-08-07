/**
 * Shared `git ls-files` walk for the guard suite.
 *
 * Extracted because two guards (client-name leak, issue attribution) had grown
 * byte-identical copies of this listing, and the next guard would have pasted a
 * third. The subtleties below are the reason it is worth centralizing — each one
 * is a way a guard can silently scan *less* than it claims to, which is the one
 * failure mode a guard must not have.
 *
 *   - `execFileSync` with array args: no shell, so Windows quoting/escaping cannot
 *     mangle a path and behaviour is identical on all three platforms.
 *   - `-z` (NUL-delimited): git quote-escapes non-ASCII paths under the default
 *     `core.quotePath`, and those entries would then fail to read and be skipped
 *     without a trace. NUL output is also immune to newlines in filenames.
 *   - explicit `maxBuffer`: the default is 1 MB and this listing is ~60 KB today,
 *     but a silent ENOBUFS as the repo grows would read as a guard bug rather than
 *     an outgrown buffer.
 *
 * git always reports `/`-separated paths regardless of platform, so callers may
 * compare and prefix-test the returned paths without normalizing.
 */

import { execFileSync } from 'node:child_process';

import { REPO_ROOT } from './eslint-harness.js';

/** NUL via char code — a literal control byte in source would make the file binary. */
const NUL = String.fromCharCode(0);

export interface TrackedFilesOptions {
  /** Limit the listing to these repo-relative directories. Omit to list the whole tree. */
  dirs?: readonly string[];
  /** Repo-relative paths to drop, `/`-separated exactly as git reports them. */
  skip?: ReadonlySet<string>;
  /** Keep only paths for which this returns true. */
  filter?: (rel: string) => boolean;
}

/** Repo-relative paths of tracked files, newest listing on every call. */
export function trackedFiles(options: TrackedFilesOptions = {}): string[] {
  const { dirs, skip, filter } = options;

  const args = ['ls-files', '-z', ...(dirs && dirs.length > 0 ? ['--', ...dirs] : [])];

  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split(NUL)
    .filter(Boolean)
    .filter((rel) => !skip?.has(rel))
    .filter((rel) => (filter ? filter(rel) : true));
}
