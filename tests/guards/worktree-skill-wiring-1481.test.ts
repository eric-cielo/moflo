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

  it('reaches for the command BEFORE any raw git recipe', () => {
    // The command owns branch creation. A raw `git worktree add -b` is allowed
    // only as the documented fallback for a `flo` older than these skills — so
    // what matters is ordering: the command must be the primary path.
    const command = text.indexOf('flo worktree add');
    const raw = text.search(/git worktree add\s+-b/);
    expect(command).toBeGreaterThan(-1);
    if (raw !== -1) expect(command).toBeLessThan(raw);
  });

  it('confines any raw recipe to the fallback section', () => {
    const raw = text.search(/git worktree add\s+-b/);
    if (raw === -1) return;
    const fallback = text.indexOf('**Fallback');
    // A raw recipe outside the fallback is the regression this guards: it
    // bypasses provisioning and the tested path computation silently.
    expect(fallback).toBeGreaterThan(-1);
    expect(raw).toBeGreaterThan(fallback);
  });

  it('tells the agent the fallback leaves the tree unprovisioned', () => {
    // Without this the agent silently continues into a run whose tests fail for
    // want of node_modules, with no idea why.
    expect(text).toMatch(/Unknown command: worktree/);
    expect(text).toMatch(/no `node_modules`/);
  });

  it('binds the repo root to the worktree call itself', () => {
    // `flo worktree` resolves the repo from cwd. Run from the wrong directory
    // it targets a different repository entirely — and the cwd reset makes that
    // the DEFAULT outcome in Claude Code, not an edge case.
    expect(text).toMatch(/cd "<repo-root>" && flo worktree add/);
  });

  it('warns that a bare cd does not persist between Bash calls', () => {
    // Claude Code resets the Bash cwd to the project root after every call, so
    // `cd <path>` then `npm test` runs in the PRIMARY checkout and the run looks
    // green while producing an empty PR. The skill must bind the directory to
    // each command instead.
    expect(text).toMatch(/bare `cd` does not stick/i);
    expect(text).toMatch(/git -C/);
  });

  it('documents `flo worktree remove` as the cleanup path', () => {
    expect(text).toMatch(/flo worktree remove/);
  });

  it('tells the agent to read the JSON `path` rather than guess the location', () => {
    expect(text).toMatch(/flo worktree add[^\n]*--json/);
    expect(text).toMatch(/`path`/);
  });
});
