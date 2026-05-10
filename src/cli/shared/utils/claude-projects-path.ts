/**
 * Encode a working directory the same way Claude Code does for its
 * `~/.claude/projects/<dir>/` transcript & memory store.
 *
 * Claude Code replaces *every* non-alphanumeric character in the absolute
 * path with `-`. Earlier moflo versions used a narrower class (`/[\\/:]/g`,
 * or split-and-rejoin variants) which agreed with Claude Code only for
 * paths whose every other character was alphanumeric — issue #1048.
 *
 * Centralised here so the stats aggregator and the auto-memory bridge
 * cannot drift apart.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Encode a CWD to the form Claude Code uses as a `~/.claude/projects/`
 * subdirectory name. Replaces every non-alphanumeric character with `-`.
 *
 * @example
 *   encodeCwdForClaudeProjects('C:\\Users\\me\\some_project')
 *     → 'C--Users-me-some-project'
 *   encodeCwdForClaudeProjects('/Users/me/dev/some_project')
 *     → '-Users-me-dev-some-project'
 */
export function encodeCwdForClaudeProjects(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** Absolute path to `~/.claude/projects/<encoded-cwd>` for the given CWD. */
export function claudeProjectDirFor(cwd: string): string {
  return join(homedir(), '.claude', 'projects', encodeCwdForClaudeProjects(cwd));
}
