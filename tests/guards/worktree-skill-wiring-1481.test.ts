/**
 * Guard: the `/flo -wt` skill drives `flo worktree add`, not a hand-rolled
 * `git worktree add` (#1481).
 *
 * `.claude/skills/fl/phases.md` ships to every consumer (`.claude/skills/**` is
 * in the package `files` list, and `fl` is in `ALWAYS_INSTALLED_SKILLS`), so the
 * recipe it carries runs on Linux, macOS and Windows dev boxes alike. The inline
 * version it replaced computed the worktree path with an embedded `node -e` one-
 * liner and shelled `git worktree add` — unlinted, untypechecked, untestable
 * string logic on the exact axis Rule #1 governs, and it provisioned nothing, so
 * the resulting tree had no `node_modules` and none of the gitignored `.env`
 * files.
 *
 * Reverting to the inline form would be invisible in review (the markdown reads
 * plausibly either way) and would silently drop provisioning for every consumer.
 * This guard makes that regression loud.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PHASES = join(process.cwd(), '.claude', 'skills', 'fl', 'phases.md');

describe('#1481 /flo -wt drives the worktree command', () => {
  const text = readFileSync(PHASES, 'utf8');

  it('instructs the agent to run `flo worktree add`', () => {
    expect(text).toMatch(/flo worktree add/);
  });

  it('carries no raw `git worktree add -b` recipe', () => {
    // The command owns branch creation now; a raw recipe here bypasses
    // provisioning and the tested path computation.
    expect(text).not.toMatch(/git worktree add\s+-b/);
  });

  it('computes no worktree path inline', () => {
    // The `-worktrees` sibling-directory convention lives in
    // computeWorktreePath(); a second copy in markdown will drift from it.
    expect(text).not.toMatch(/node -e[^\n]*worktrees/);
  });

  it('documents `flo worktree remove` as the cleanup path', () => {
    expect(text).toMatch(/flo worktree remove/);
  });

  it('tells the agent to read the JSON `path` rather than guess the location', () => {
    expect(text).toMatch(/flo worktree add[^\n]*--json/);
    expect(text).toMatch(/`path`/);
  });
});
