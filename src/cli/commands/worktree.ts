/**
 * MoFlo Worktree Command — #1481.
 *
 * Lifecycle + provisioning for git worktrees, so `/flo -wt` produces a RUNNABLE
 * workspace instead of a bare checkout. This file owns git invocation and output
 * formatting only; every platform-sensitive filesystem decision lives in
 * `../services/worktree-provision.ts` where a unit test can reach it (Rule #1).
 *
 * Usage:
 *   flo worktree add <branch> [--from <ref>] [--no-provision] [--json]
 *   flo worktree list [--json]
 *   flo worktree remove <branch|path> [--force] [--json]
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { findProjectRoot } from '../services/project-root.js';
import { loadMofloConfig } from '../config/moflo-config.js';
import {
  type ProvisionStep,
  type WorktreeConfig,
  type WorktreeState,
  WORKTREE_STATE_FILE_POSIX,
  allocateIndex,
  computeWorktreePath,
  isInside,
  resolveForCompare,
  provisionWorktree,
  readWorktreeState,
  writeWorktreeState,
} from '../services/worktree-provision.js';

interface WorktreeEntry {
  path: string;
  branch: string | null;
  /** moflo state, or null for a worktree moflo did not create. */
  state: WorktreeState | null;
  /** True for the primary working tree (the one that is not a linked worktree). */
  primary: boolean;
}

/**
 * Run a git command. Never `shell: true` — args are passed as an array so a
 * branch name containing shell metacharacters cannot be reinterpreted, and so
 * the same call works identically on all three platforms.
 */
function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    ok: !result.error && result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? result.error?.message ?? '').trim(),
  };
}

/**
 * Parse `git worktree list --porcelain`. The first record is always the primary
 * working tree; linked worktrees follow. Records are blank-line separated, and
 * `branch` is a full ref (`refs/heads/x`) or absent when detached.
 */
function listWorktrees(repoRoot: string): WorktreeEntry[] {
  const result = git(['worktree', 'list', '--porcelain'], repoRoot);
  if (!result.ok) return [];
  const entries: WorktreeEntry[] = [];
  let current: { path?: string; branch?: string } = {};
  const flush = (): void => {
    if (!current.path) return;
    entries.push({
      path: current.path,
      branch: current.branch ? current.branch.replace(/^refs\/heads\//, '') : null,
      state: readWorktreeState(current.path),
      primary: entries.length === 0,
    });
    current = {};
  };
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      flush();
      current.path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim();
    }
  }
  flush();
  return entries;
}

/**
 * The ref a new worktree branches from when `--from` is not given.
 *
 * `origin/HEAD` is the authoritative answer but is not always configured in a
 * fresh clone, so fall back to `gh` (which the rest of this repo's tooling
 * already assumes) and finally to whichever of `origin/main`/`origin/master`
 * exists. Returns null when none resolve — better a clear error than silently
 * branching off the wrong ref.
 *
 * Deliberately NOT shared with `getDefaultBranch` in `commands/github.ts`: that
 * one returns a bare branch name and falls back to the literal `'main'`, which
 * is right for generating a CI workflow and wrong here — silently branching a
 * user's work off a guessed ref is the failure this returns null to avoid. It
 * also tries `gh` first, where this prefers git (faster, and works offline).
 */
function resolveDefaultBase(repoRoot: string): string | null {
  const head = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repoRoot);
  if (head.ok && head.stdout) return head.stdout.replace(/^refs\/remotes\//, '');

  const gh = spawnSync('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (!gh.error && gh.status === 0) {
    const name = (gh.stdout ?? '').trim();
    if (name) return `origin/${name}`;
  }

  for (const candidate of ['origin/main', 'origin/master']) {
    if (git(['rev-parse', '--verify', '--quiet', candidate], repoRoot).ok) return candidate;
  }
  return null;
}

function renderSteps(steps: readonly ProvisionStep[]): string {
  return steps
    .map(step => {
      const mark = step.status === 'done' ? '✓' : step.status === 'skipped' ? '·' : '✗';
      const detail = step.detail ? ` (${step.detail})` : '';
      return `  ${mark} ${step.kind} ${step.target}${detail}`;
    })
    .join('\n');
}

// =============================================================================
// add
// =============================================================================

async function cmdAdd(ctx: CommandContext): Promise<CommandResult> {
  const branch = ctx.args?.[1];
  const json = ctx.flags.json === true;
  if (!branch) {
    return { success: false, message: 'Usage: flo worktree add <branch> [--from <ref>]', exitCode: 1 };
  }

  const repoRoot = findProjectRoot({ cwd: ctx.cwd });
  const config = loadMofloConfig(repoRoot);
  const worktreeConfig = config.worktree;
  const target = computeWorktreePath(repoRoot, branch, worktreeConfig?.dir);

  const existing = listWorktrees(repoRoot);
  // Resolve the needle once, then compare resolved strings — realpathing both
  // sides inside the scan costs 4 walks per worktree for the same answer.
  const resolvedTarget = resolveForCompare(target);
  const alreadyRegistered = existing.find(entry => resolveForCompare(entry.path) === resolvedTarget);

  // Reuse rather than recreate: a prior run may have left work in this tree, and
  // deleting a directory we did not just create is never this command's call.
  if (!alreadyRegistered) {
    if (existsSync(target)) {
      return {
        success: false,
        message: `Path already exists but is not a registered worktree: ${target}\nRemove it by hand, or pass a different branch name.`,
        exitCode: 1,
      };
    }
    const explicitFrom = typeof ctx.flags.from === 'string';
    const base = explicitFrom ? (ctx.flags.from as string) : resolveDefaultBase(repoRoot);
    if (!base) {
      return {
        success: false,
        message: 'Could not resolve a default base ref (no origin/HEAD, no gh, no origin/main or origin/master). Pass --from <ref>.',
        exitCode: 1,
      };
    }
    // Fetch so the DEFAULT base is current — branching a ticket off a stale
    // origin/main is the failure this guards. An explicit `--from` that already
    // resolves locally (a tag, another branch) is the user naming a specific
    // commit, so skip the network round trip there. A fetch failure is never
    // fatal: an offline machine should still get its worktree.
    const baseIsLocal = git(['rev-parse', '--verify', '--quiet', base], repoRoot).ok;
    if (!(explicitFrom && baseIsLocal)) git(['fetch', 'origin'], repoRoot);
    const created = git(['worktree', 'add', '-b', branch, target, base], repoRoot);
    if (!created.ok) {
      return { success: false, message: `git worktree add failed: ${created.stderr}`, exitCode: 1 };
    }
  }

  // Re-adding an existing worktree MUST keep its index. `existing` includes that
  // worktree, so allocating afresh would hand it a new number and rewrite
  // worktree.json — silently shifting every port a consumer derived from
  // MOFLO_WORKTREE_INDEX in a tree they are already working in.
  const index =
    alreadyRegistered?.state?.index ??
    allocateIndex(
      existing.map(entry => entry.state?.index).filter((n): n is number => typeof n === 'number'),
    );

  let provisioned = true;
  // Distinct from `!provisioned`: skipping provisioning by request is not a
  // failure, so it must not colour the exit code.
  let provisionFailed = false;
  let steps: readonly ProvisionStep[] = [];
  // Positive name, negative read (#1474): the parser turns `--no-provision`
  // into `flags.provision = false`; an option DECLARED `no-provision` would be
  // an unreachable no-op.
  if (ctx.flags.provision === false) {
    // Still record state so `list` reports the tree as moflo-created and the
    // index stays allocated against it.
    writeWorktreeState(target, { branch, index, primaryRoot: repoRoot, provisioned: false });
    provisioned = false;
  } else {
    const result = provisionWorktree({
      primaryRoot: repoRoot,
      worktreePath: target,
      branch,
      index,
      config: worktreeConfig,
      jsonMode: json,
    });
    provisioned = result.provisioned;
    provisionFailed = !result.provisioned;
    steps = result.steps;
  }

  if (json) {
    console.log(JSON.stringify({ path: target, branch, index, provisioned, steps }));
    return { success: !provisionFailed, exitCode: provisionFailed ? 1 : 0 };
  }

  const lines = [`Worktree: ${target}`, `Branch:   ${branch}`, `Index:    ${index}`];
  if (steps.length > 0) lines.push('Provisioning:', renderSteps(steps));
  else if (ctx.flags.provision === false) lines.push('Provisioning: skipped (--no-provision)');
  else if (!worktreeConfig) {
    lines.push('Provisioning: none configured (add a `worktree:` block to moflo.yaml)');
  }
  lines.push(`Remove with: flo worktree remove ${branch}`);
  console.log(lines.join('\n'));
  return { success: !provisionFailed, exitCode: provisionFailed ? 1 : 0 };
}

// =============================================================================
// list
// =============================================================================

async function cmdList(ctx: CommandContext): Promise<CommandResult> {
  const repoRoot = findProjectRoot({ cwd: ctx.cwd });
  const entries = listWorktrees(repoRoot);

  if (ctx.flags.json === true) {
    console.log(
      JSON.stringify(
        entries.map(entry => ({
          path: entry.path,
          branch: entry.branch,
          primary: entry.primary,
          provisioned: entry.state?.provisioned ?? false,
          managed: entry.state !== null,
          index: entry.state?.index ?? null,
        })),
      ),
    );
    return { success: true, exitCode: 0 };
  }

  if (entries.length === 0) {
    console.log('No worktrees.');
    return { success: true, exitCode: 0 };
  }
  const lines = entries.map(entry => {
    const tag = entry.primary
      ? 'primary'
      : entry.state === null
        ? 'unmanaged'
        : entry.state.provisioned
          ? `provisioned #${entry.state.index}`
          : `unprovisioned #${entry.state.index}`;
    return `  ${entry.branch ?? '(detached)'}  [${tag}]\n    ${entry.path}`;
  });
  console.log(lines.join('\n'));
  return { success: true, exitCode: 0 };
}

// =============================================================================
// remove
// =============================================================================

/**
 * Porcelain status lines that represent the USER's work.
 *
 * `flo worktree add` writes `.moflo/worktree.json` into the tree it creates, and
 * `.moflo/` is not gitignored in every project — so a freshly created, untouched
 * worktree reports as dirty. Counting moflo's own bookkeeping as user work would
 * make `remove` demand `--force` on every worktree this command produced, which
 * trains the user to always pass it and defeats the guard entirely.
 *
 * Only that ONE file is excused, never the whole `.moflo/` directory: a worktree
 * may also hold un-pushed SDD specs and plans under `.moflo/specs/`, and those
 * are user-authored work that must still block removal. Reaching that precision
 * requires `-uall` at the call site — porcelain otherwise collapses an untracked
 * directory to a single `?? .moflo/` line, which cannot be told apart from spec
 * work living inside it.
 *
 * Each line is `XY <path>`; a rename is `XY <old> -> <new>`, and a path with
 * unusual characters is quoted with C-style escapes. Only the leading two
 * status columns are fixed width, so the path starts at index 3. A filename
 * containing a literal ` -> ` inside quotes would mis-split — harmless, because
 * the mis-split value simply fails to equal the state file and the line counts
 * as user work, which is the safe direction (refuse removal, never delete).
 */
function userChanges(porcelain: string): string[] {
  const stateFile = WORKTREE_STATE_FILE_POSIX;
  return porcelain
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .filter(line => {
      const entry = line.slice(3).trim();
      const target = (entry.includes(' -> ') ? entry.split(' -> ')[1] : entry).replace(/^"|"$/g, '');
      return target !== stateFile;
    });
}


/**
 * Gitignored paths in the worktree that `remove` is about to destroy and that
 * provisioning did not put there.
 *
 * `git status --porcelain` never lists ignored files, so the dirty gate above
 * cannot see them — yet removing the worktree deletes them (stock
 * `git worktree remove` does the same; this is inherent to worktree removal,
 * not something --force introduces). Anything `copy:` or `link:` created is
 * excluded: it either still exists in the primary checkout or is a symlink
 * whose target is untouched, so naming it would be noise on every removal.
 *
 * Warns; never blocks. A project whose `setup:` ran `npm ci` has a legitimate
 * `node_modules` here on every single removal, and blocking on that would just
 * teach the user to always pass --force.
 */
function unprovisionedIgnoredPaths(worktreePath: string, config?: WorktreeConfig): string[] {
  const status = git(['status', '--porcelain', '--ignored=matching', '-uall'], worktreePath);
  if (!status.ok) return [];
  const provisioned = [...(config?.copy ?? []), ...(config?.link ?? [])].map(entry =>
    entry.split(/[\\/]/).filter(Boolean).join('/'),
  );
  return status.stdout
    .split(/\r?\n/)
    .filter(line => line.startsWith('!! '))
    .map(line => line.slice(3).trim().replace(/^"|"$/g, ''))
    .filter(target => target !== WORKTREE_STATE_FILE_POSIX)
    .filter(target => !provisioned.some(p => target === p || target.startsWith(`${p}/`)));
}

async function cmdRemove(ctx: CommandContext): Promise<CommandResult> {
  const which = ctx.args?.[1];
  const force = ctx.flags.force === true;
  if (!which) {
    return { success: false, message: 'Usage: flo worktree remove <branch|path> [--force]', exitCode: 1 };
  }

  const repoRoot = findProjectRoot({ cwd: ctx.cwd });
  const entries = listWorktrees(repoRoot);
  // Match by branch first, then by path. The path comparison is realpath-based,
  // so a symlinked tempdir on macOS still matches; the needle resolves once.
  const resolvedCandidate = resolveForCompare(path.resolve(ctx.cwd, which));
  const match = entries.find(
    entry => entry.branch === which || resolveForCompare(entry.path) === resolvedCandidate,
  );
  if (!match) {
    return { success: false, message: `Not a registered worktree of this repo: ${which}`, exitCode: 1 };
  }
  if (match.primary) {
    return { success: false, message: 'Refusing to remove the primary working tree.', exitCode: 1 };
  }

  if (!force) {
    // `-uall` so an untracked directory is not collapsed to one line — see userChanges().
    const status = git(['status', '--porcelain', '-uall'], match.path);
    const dirty = status.ok ? userChanges(status.stdout) : [];
    if (dirty.length > 0) {
      return {
        success: false,
        message: `Worktree has uncommitted changes: ${match.path}\n  ${dirty.slice(0, 5).join('\n  ')}\nCommit them, or re-run with --force.`,
        exitCode: 1,
      };
    }
  }

  // Always `--force` at the git layer. `userChanges()` above is the real gate and
  // has already refused anything the user would miss; git's own check cannot tell
  // moflo's untracked `.moflo/worktree.json` from user work, so without this every
  // worktree this command created would be unremovable without `--force`.
  const doomed = unprovisionedIgnoredPaths(match.path, loadMofloConfig(repoRoot).worktree);
  const removed = git(['worktree', 'remove', '--force', match.path], repoRoot);
  if (!removed.ok) {
    return { success: false, message: `git worktree remove failed: ${removed.stderr}`, exitCode: 1 };
  }

  if (ctx.flags.json === true) {
    console.log(JSON.stringify({ removed: match.path, branch: match.branch, discardedIgnored: doomed }));
    return { success: true, exitCode: 0 };
  }
  console.log(`Removed worktree: ${match.path}`);
  if (doomed.length > 0) {
    console.log(
      `  also discarded ${doomed.length} gitignored path(s) that were not provisioned: ` +
        `${doomed.slice(0, 5).join(', ')}${doomed.length > 5 ? ', …' : ''}`,
    );
  }
  return { success: true, exitCode: 0 };
}

// =============================================================================
// Command definition
// =============================================================================

const HELP = `Usage: flo worktree <command>

Git worktrees as provisioned workspaces (moflo.yaml \`worktree:\` block):
  add <branch> [--from <ref>] [--no-provision] [--json]
                           Create a worktree at <repo-parent>/<repo>-worktrees/<branch>
                           and provision it (copy / link / setup)
  list [--json]            List this repo's worktrees and their provisioning state
  remove <branch|path> [--force] [--json]
                           Remove a worktree (refuses a dirty tree without --force)

With no \`worktree:\` block in moflo.yaml, \`add\` creates the worktree and
provisions nothing.`;

const worktreeCommand: Command = {
  name: 'worktree',
  description: 'Create, list, and remove provisioned git worktrees',
  aliases: ['wt'],
  options: [
    { name: 'from', description: 'Base ref for the new branch (default: origin/HEAD)', type: 'string' },
    {
      name: 'provision',
      description: 'Run copy/link/setup after creating the worktree (--no-provision to skip)',
      type: 'boolean',
      default: true,
    },
    { name: 'force', description: 'Remove even with uncommitted changes', type: 'boolean' },
    { name: 'json', description: 'Emit machine-readable JSON', type: 'boolean' },
  ],
  examples: [
    { command: 'flo worktree add feature/1481-provisioning', description: 'Create + provision a worktree' },
    { command: 'flo worktree list', description: 'Show every worktree and its state' },
    { command: 'flo worktree remove feature/1481-provisioning', description: 'Clean up when the PR is merged' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const sub = ctx.args?.[0];
    switch (sub) {
      case 'add':
        return cmdAdd(ctx);
      case 'list':
        return cmdList(ctx);
      case 'remove':
        return cmdRemove(ctx);
      default:
        console.log(HELP);
        return { success: !sub, exitCode: sub ? 1 : 0 };
    }
  },
};

export default worktreeCommand;
export { worktreeCommand };
