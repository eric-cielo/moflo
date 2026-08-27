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
  type WorktreeState,
  allocateIndex,
  computeWorktreePath,
  isInside,
  provisionWorktree,
  readWorktreeState,
  writeWorktreeState,
} from '../services/worktree-provision.js';

/** moflo's own per-worktree bookkeeping directory, as git reports it. */
const MOFLO_DIR = '.moflo';

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
  const alreadyRegistered = existing.find(entry => isInside(entry.path, target) && isInside(target, entry.path));

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
    const base = typeof ctx.flags.from === 'string' ? ctx.flags.from : resolveDefaultBase(repoRoot);
    if (!base) {
      return {
        success: false,
        message: 'Could not resolve a default base ref (no origin/HEAD, no gh, no origin/main or origin/master). Pass --from <ref>.',
        exitCode: 1,
      };
    }
    // Fetch so the base ref is current; a failure here is not fatal (the ref may
    // already be local, and an offline machine should still get its worktree).
    git(['fetch', 'origin'], repoRoot);
    const created = git(['worktree', 'add', '-b', branch, target, base], repoRoot);
    if (!created.ok) {
      return { success: false, message: `git worktree add failed: ${created.stderr}`, exitCode: 1 };
    }
  }

  const index = allocateIndex(
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
 * Each line is `XY <path>`; a rename is `XY <old> -> <new>`, and a path with
 * unusual characters is quoted. Only the leading two status columns are fixed
 * width, so the path starts at index 3.
 */
function userChanges(porcelain: string): string[] {
  const mofloPrefix = `${MOFLO_DIR}/`;
  return porcelain
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .filter(line => {
      const entry = line.slice(3).trim();
      const target = (entry.includes(' -> ') ? entry.split(' -> ')[1] : entry).replace(/^"|"$/g, '');
      // git always reports forward slashes here, on every platform.
      return target !== MOFLO_DIR && target !== mofloPrefix && !target.startsWith(mofloPrefix);
    });
}


async function cmdRemove(ctx: CommandContext): Promise<CommandResult> {
  const which = ctx.args?.[1];
  const force = ctx.flags.force === true;
  if (!which) {
    return { success: false, message: 'Usage: flo worktree remove <branch|path> [--force]', exitCode: 1 };
  }

  const repoRoot = findProjectRoot({ cwd: ctx.cwd });
  const entries = listWorktrees(repoRoot);
  const candidate = path.resolve(ctx.cwd, which);

  // Match by branch first, then by path. The path comparison realpaths both
  // sides (inside `isInside`), so a symlinked tempdir on macOS still matches.
  const match = entries.find(
    entry => entry.branch === which || (isInside(entry.path, candidate) && isInside(candidate, entry.path)),
  );
  if (!match) {
    return { success: false, message: `Not a registered worktree of this repo: ${which}`, exitCode: 1 };
  }
  if (match.primary) {
    return { success: false, message: 'Refusing to remove the primary working tree.', exitCode: 1 };
  }

  if (!force) {
    const status = git(['status', '--porcelain'], match.path);
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
  const removed = git(['worktree', 'remove', '--force', match.path], repoRoot);
  if (!removed.ok) {
    return { success: false, message: `git worktree remove failed: ${removed.stderr}`, exitCode: 1 };
  }

  if (ctx.flags.json === true) {
    console.log(JSON.stringify({ removed: match.path, branch: match.branch }));
    return { success: true, exitCode: 0 };
  }
  console.log(`Removed worktree: ${match.path}`);
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
