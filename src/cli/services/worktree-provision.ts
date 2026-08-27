/**
 * Worktree provisioning (#1481).
 *
 * `/flo -wt` and `flo worktree add` create a git worktree; on its own that is a
 * valid checkout and an unrunnable workspace — no `node_modules`, none of the
 * gitignored `.env` files, and no notion that a second worktree's dev servers
 * will collide with the first on fixed ports. This service closes that gap,
 * driven by the optional `worktree:` block in `moflo.yaml`.
 *
 * Every platform-sensitive decision lives here rather than in the command, so
 * the Windows-vs-POSIX branches are reachable from a unit test (Rule #1):
 *   - paths built with `path.*`, never separator concatenation
 *   - directory links are junctions on Windows (no admin/developer mode needed,
 *     and the target must be absolute), plain symlinks on POSIX
 *   - copies via `fs.cpSync`; no `cp`/`ln -s`/`mkdir -p`/`find` shell-outs
 *   - `setup` runs through a shell on both platforms (it is a user-authored
 *     command string, not an argv array) — see `runSetup`
 *   - containment checks realpath BOTH sides before comparing (#1145: macOS
 *     `/var/folders` vs `/private/var/folders` otherwise false-positives)
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../shared/utils/atomic-file-write.js';

/** The `worktree:` block from `moflo.yaml`. Every key optional. */
export interface WorktreeConfig {
  dir?: string;
  copy?: string[];
  link?: string[];
  setup?: string;
}

/** Contents of `.moflo/worktree.json` inside a moflo-created worktree. */
export interface WorktreeState {
  branch: string;
  index: number;
  primaryRoot: string;
  provisioned: boolean;
}

/** One thing provisioning did (or declined to do), for human + `--json` output. */
export interface ProvisionStep {
  kind: 'copy' | 'link' | 'setup';
  target: string;
  status: 'done' | 'skipped' | 'failed';
  detail?: string;
}

export interface ProvisionResult {
  provisioned: boolean;
  steps: ProvisionStep[];
}

/** Relative path of the per-worktree state file, from the worktree root. */
export const WORKTREE_STATE_FILE = path.join('.moflo', 'worktree.json');

/**
 * Turn a branch name into a single flat directory name. Both separators are
 * replaced: a branch is always `/`-delimited, but a caller may hand us a
 * Windows-style string, and `\` is invalid in an NTFS directory name anyway.
 */
export function slugifyBranch(branch: string): string {
  return branch.replace(/[\\/]/g, '-');
}

/**
 * Resolve where a worktree for `branch` belongs.
 *
 * Default: `<repo-parent>/<repo-basename>-worktrees/<slugged-branch>` — a
 * sibling of the checkout, so it is never inside the repo (and so never picked
 * up by the repo's own tooling). `configuredDir` overrides the parent directory
 * and is resolved relative to `repoRoot` when relative.
 */
export function computeWorktreePath(
  repoRoot: string,
  branch: string,
  configuredDir?: string,
): string {
  const parent = configuredDir
    ? path.resolve(repoRoot, configuredDir)
    : path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-worktrees`);
  return path.join(parent, slugifyBranch(branch));
}

/**
 * Smallest non-negative integer not already taken. Reusing a freed slot (rather
 * than incrementing a counter) keeps the index small and stable, which matters
 * because consumers offset fixed ports from it — an unbounded counter would
 * eventually push a derived port out of range.
 */
export function allocateIndex(existing: readonly number[]): number {
  const taken = new Set(existing.filter(n => Number.isInteger(n) && n >= 0));
  let candidate = 0;
  while (taken.has(candidate)) candidate++;
  return candidate;
}

/**
 * Resolve a path as far as it exists. `realpathSync` throws on a missing path,
 * but a containment check must still work for a destination that has not been
 * created yet — so walk up to the nearest existing ancestor, resolve that, and
 * re-append the remainder.
 */
function realpathBestEffort(target: string): string {
  let current = path.resolve(target);
  const trailing: string[] = [];
  // Bounded by the path depth: each iteration removes one segment, and
  // `path.dirname` is a fixed point at the filesystem root.
  for (;;) {
    if (existsSync(current)) return path.join(realpathSync(current), ...trailing.reverse());
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(target);
    trailing.push(path.basename(current));
    current = parent;
  }
}

/**
 * Is `candidate` inside `root`? Both sides are realpath'd first — the #1145
 * shape, where an unresolved `/var/folders/...` compared against a resolved
 * `/private/var/folders/...` on macOS made two identical paths look different.
 */
export function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = realpathBestEffort(root);
  const resolvedCandidate = realpathBestEffort(candidate);
  if (resolvedCandidate === resolvedRoot) return true;
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Expand one `copy:` entry against the primary checkout.
 *
 * Glob support is deliberately narrow — a single `*` in the final segment, so
 * `.env.*` works — because the alternative is either a shell-out (`find` does
 * not exist on Windows) or a full tree walk on a pattern the user thought was
 * cheap. A pattern needing more than this returns nothing rather than silently
 * matching a subset; the caller reports it as skipped.
 */
function expandCopyEntry(primaryRoot: string, entry: string): string[] {
  const normalized = entry.split(/[\\/]/).filter(Boolean);
  if (normalized.length === 0) return [];
  const last = normalized[normalized.length - 1];
  if (!last.includes('*')) {
    const full = path.join(primaryRoot, ...normalized);
    return existsSync(full) ? [full] : [];
  }
  const dir = path.join(primaryRoot, ...normalized.slice(0, -1));
  if (!existsSync(dir)) return [];
  // Anchor both ends so `.env.*` cannot match `my.env.backup`, and escape every
  // regex metacharacter except the `*` we are translating.
  const pattern = new RegExp(`^${last.split('*').map(escapeRegExp).join('[^\\\\/]*')}$`);
  return readdirSync(dir)
    .filter(name => pattern.test(name))
    .sort()
    .map(name => path.join(dir, name));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Copy the configured gitignored material into the new worktree.
 *
 * Sources are guarded on both ends: each must resolve inside the primary
 * checkout (so `../secrets` is rejected), and the destination is always the
 * worktree we just created. A missing source is skipped rather than fatal —
 * `.env.local` legitimately does not exist on every machine.
 */
function runCopy(
  primaryRoot: string,
  worktreePath: string,
  entries: readonly string[],
): ProvisionStep[] {
  const steps: ProvisionStep[] = [];
  for (const entry of entries) {
    if (!isInside(primaryRoot, path.resolve(primaryRoot, entry))) {
      steps.push({
        kind: 'copy',
        target: entry,
        status: 'failed',
        detail: 'resolves outside the primary checkout',
      });
      continue;
    }
    const matches = expandCopyEntry(primaryRoot, entry);
    if (matches.length === 0) {
      steps.push({ kind: 'copy', target: entry, status: 'skipped', detail: 'no match' });
      continue;
    }
    for (const source of matches) {
      const dest = path.join(worktreePath, path.relative(primaryRoot, source));
      try {
        mkdirSync(path.dirname(dest), { recursive: true });
        cpSync(source, dest, { recursive: true });
        steps.push({ kind: 'copy', target: path.relative(primaryRoot, source), status: 'done' });
      } catch (error) {
        steps.push({
          kind: 'copy',
          target: path.relative(primaryRoot, source),
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return steps;
}

/**
 * The `fs.symlinkSync` type argument for a directory link on this platform.
 *
 * Windows gets a junction: unlike a `'dir'` symlink it needs no admin rights or
 * developer mode. Exported and pure so the Windows branch is assertable from a
 * unit test on any host — the alternative, spying on an ESM `fs` export, is not
 * possible, and gating the assertion on a Windows runner would leave the branch
 * unverified on the two CI legs that run most often.
 */
export function linkTypeForPlatform(platform: NodeJS.Platform): 'junction' | undefined {
  return platform === 'win32' ? 'junction' : undefined;
}

/**
 * Link the configured paths from the primary checkout into the new worktree.
 * The target is resolved to an ABSOLUTE path before the call on every platform:
 * a relative target silently produces a broken junction on Windows.
 */
function runLink(
  primaryRoot: string,
  worktreePath: string,
  entries: readonly string[],
): ProvisionStep[] {
  const steps: ProvisionStep[] = [];
  const linkType = linkTypeForPlatform(process.platform);
  for (const entry of entries) {
    const source = path.resolve(primaryRoot, entry);
    const dest = path.join(worktreePath, entry);
    if (!existsSync(source)) {
      steps.push({ kind: 'link', target: entry, status: 'skipped', detail: 'no such path' });
      continue;
    }
    // lstat, not existsSync: a broken symlink left by an earlier run still
    // occupies the name, and clobbering it is not ours to decide.
    let occupied = false;
    try {
      lstatSync(dest);
      occupied = true;
    } catch {
      occupied = false;
    }
    if (occupied) {
      steps.push({ kind: 'link', target: entry, status: 'skipped', detail: 'already exists' });
      continue;
    }
    try {
      mkdirSync(path.dirname(dest), { recursive: true });
      symlinkSync(source, dest, linkType);
      steps.push({ kind: 'link', target: entry, status: 'done' });
    } catch (error) {
      steps.push({
        kind: 'link',
        target: entry,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return steps;
}

/**
 * Run the configured `setup` command inside the new worktree.
 *
 * `shell: true` on BOTH platforms, unlike the daemon-spawning code this repo
 * models elsewhere. That rule ("shell on Windows, detached on POSIX") is about
 * spawning a known binary with an argv array; `setup` is a user-authored shell
 * command *string* from `moflo.yaml` — `npm ci && npm run build` is a legitimate
 * value, and it needs `cmd.exe` or `/bin/sh` to mean anything. Running it
 * without a shell would exec a file literally named `npm ci && npm run build`.
 * On Windows a shell is required regardless, since `npm` there is `npm.cmd`.
 * Trust boundary: the same as a `package.json` script — the project's own config.
 *
 * `jsonMode` sends the child's stdout to our stderr so a `--json` caller still
 * gets parseable JSON on stdout.
 */
function runSetup(
  worktreePath: string,
  command: string,
  index: number,
  jsonMode: boolean,
): ProvisionStep {
  const result = spawnSync(command, {
    cwd: worktreePath,
    shell: true,
    stdio: jsonMode ? ['ignore', 2, 2] : 'inherit',
    env: { ...process.env, MOFLO_WORKTREE_INDEX: String(index) },
  });
  if (result.error) {
    return { kind: 'setup', target: command, status: 'failed', detail: result.error.message };
  }
  if (result.status !== 0) {
    return {
      kind: 'setup',
      target: command,
      status: 'failed',
      detail: `exited with code ${result.status ?? 'null'}`,
    };
  }
  return { kind: 'setup', target: command, status: 'done' };
}

/**
 * Provision a freshly created worktree: copy, then link, then setup.
 *
 * Order matters — `setup` (typically `npm ci`) may depend on the `.env` files
 * `copy` brings in, and must not race the `link` that would otherwise supply
 * `node_modules`. A failed step never unwinds the worktree: it is a valid
 * checkout either way, and deleting a tree the user may have started working in
 * is far worse than leaving it under-provisioned.
 */
export function provisionWorktree(opts: {
  primaryRoot: string;
  worktreePath: string;
  branch: string;
  index: number;
  config?: WorktreeConfig;
  /** Send `setup` output to stderr so stdout stays parseable JSON. */
  jsonMode?: boolean;
}): ProvisionResult {
  const { primaryRoot, worktreePath, branch, index, config, jsonMode = false } = opts;
  const steps: ProvisionStep[] = [];

  if (config?.copy?.length) steps.push(...runCopy(primaryRoot, worktreePath, config.copy));
  if (config?.link?.length) steps.push(...runLink(primaryRoot, worktreePath, config.link));
  if (config?.setup) steps.push(runSetup(worktreePath, config.setup, index, jsonMode));

  const provisioned = steps.every(step => step.status !== 'failed');
  writeWorktreeState(worktreePath, { branch, index, primaryRoot, provisioned });
  return { provisioned, steps };
}

/** Write `.moflo/worktree.json` into a worktree. Atomic — the daemon may read it. */
export function writeWorktreeState(worktreePath: string, state: WorktreeState): void {
  const statePath = path.join(worktreePath, WORKTREE_STATE_FILE);
  mkdirSync(path.dirname(statePath), { recursive: true });
  atomicWriteFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Read a worktree's moflo state. `null` means moflo did not create this tree —
 * which is exactly how `flo worktree list` reports an externally-created
 * worktree as unprovisioned, so a malformed file is treated the same as a
 * missing one rather than failing the listing.
 */
export function readWorktreeState(worktreePath: string): WorktreeState | null {
  const statePath = path.join(worktreePath, WORKTREE_STATE_FILE);
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<WorktreeState>;
    if (typeof parsed.branch !== 'string' || !Number.isInteger(parsed.index)) return null;
    return {
      branch: parsed.branch,
      index: parsed.index as number,
      primaryRoot: typeof parsed.primaryRoot === 'string' ? parsed.primaryRoot : '',
      provisioned: parsed.provisioned === true,
    };
  } catch {
    return null;
  }
}
