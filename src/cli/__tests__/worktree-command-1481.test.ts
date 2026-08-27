/**
 * Integration tests for `flo worktree` (#1481) — add / list / remove against a
 * real temporary git repository.
 *
 * These drive the command's `action` directly rather than spawning `flo`, so a
 * failure points at the handler instead of at CLI plumbing, and so the suite
 * stays fast enough to run in the default pass. Everything happens under
 * `os.tmpdir()`; nothing touches the developer's repo.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import worktreeCommand from '../commands/worktree.js';
import type { CommandContext, CommandResult } from '../types.js';
import { WORKTREE_STATE_FILE } from '../services/worktree-provision.js';

let root: string;
let repo: string;
let logs: string[];

function git(args: string[], cwd: string): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

/** Build a CommandContext the way the CLI parser would. */
function ctx(args: string[], flags: Record<string, unknown> = {}, cwd = repo): CommandContext {
  return { args, flags: { _: [], ...flags } as CommandContext['flags'], cwd, interactive: false };
}

const run = (c: CommandContext): Promise<CommandResult> =>
  worktreeCommand.action!(c) as Promise<CommandResult>;

/** The last JSON object printed to stdout by the command under test. */
function lastJson<T = Record<string, unknown>>(): T {
  return JSON.parse(logs[logs.length - 1]) as T;
}

beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    logs.push(parts.map(String).join(' '));
  });
  root = mkdtempSync(join(tmpdir(), 'moflo-wtcmd-'));
  repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main', '.'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'test'], repo);
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n.env\n');
  git(['add', '-A'], repo);
  git(['commit', '-qm', 'init'], repo);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const writeConfig = (yaml: string): void => {
  writeFileSync(join(repo, 'moflo.yaml'), yaml);
};

// ============================================================================
// AC1 — add
// ============================================================================

describe('#1481 flo worktree add (AC1)', () => {
  it('creates the worktree at the sibling path and reports it as JSON', async () => {
    const result = await run(ctx(['add', 'feature/1481-x'], { from: 'main', json: true }));
    expect(result.success).toBe(true);
    const out = lastJson<{ path: string; branch: string; index: number; provisioned: boolean }>();
    expect(out.path).toBe(join(root, 'repo-worktrees', 'feature-1481-x'));
    expect(out.branch).toBe('feature/1481-x');
    expect(out.index).toBe(0);
    expect(existsSync(join(out.path, 'README.md'))).toBe(true);
  });

  it('creates the branch, off the ref given by --from', async () => {
    await run(ctx(['add', 'feature/a'], { from: 'main', json: true }));
    const branches = spawnSync('git', ['branch', '--list', 'feature/a'], { cwd: repo, encoding: 'utf8' });
    expect(branches.stdout).toContain('feature/a');
  });

  it('requires a branch name', async () => {
    const result = await run(ctx(['add'], {}));
    expect(result.success).toBe(false);
    expect(result.message).toContain('Usage');
  });

  it('refuses a path that exists but is not a registered worktree', async () => {
    mkdirSync(join(root, 'repo-worktrees', 'feature-x'), { recursive: true });
    const result = await run(ctx(['add', 'feature/x'], { from: 'main' }));
    expect(result.success).toBe(false);
    expect(result.message).toContain('not a registered worktree');
  });

  it('reuses an existing worktree for the same branch rather than recreating it', async () => {
    const first = await run(ctx(['add', 'feature/reuse'], { from: 'main', json: true }));
    expect(first.success).toBe(true);
    const path = lastJson<{ path: string }>().path;
    writeFileSync(join(path, 'in-progress.txt'), 'work');

    const second = await run(ctx(['add', 'feature/reuse'], { from: 'main', json: true }));
    expect(second.success).toBe(true);
    // A prior run may have left work here; deleting it is never this command's call.
    expect(readFileSync(join(path, 'in-progress.txt'), 'utf8')).toBe('work');
  });

  it('KEEPS the existing index when re-adding the same branch', async () => {
    // Regression: `existing` includes the already-registered worktree, so
    // allocating afresh handed a re-add a NEW index and rewrote worktree.json —
    // silently shifting every port a consumer derived from MOFLO_WORKTREE_INDEX
    // in a tree they were already working in.
    await run(ctx(['add', 'feature/first'], { from: 'main', json: true }));
    await run(ctx(['add', 'feature/second'], { from: 'main', json: true }));
    expect(lastJson<{ index: number }>().index).toBe(1);

    await run(ctx(['add', 'feature/first'], { from: 'main', json: true }));
    expect(lastJson<{ index: number }>().index).toBe(0);
    await run(ctx(['add', 'feature/second'], { from: 'main', json: true }));
    expect(lastJson<{ index: number }>().index).toBe(1);
  });
});

// ============================================================================
// AC5 — no-config parity (the consumer-upgrade case)
// ============================================================================

describe('#1481 no worktree: block (AC5)', () => {
  it('creates the worktree and provisions nothing', async () => {
    writeFileSync(join(repo, '.env'), 'SECRET=1');
    const result = await run(ctx(['add', 'feature/plain'], { from: 'main', json: true }));
    expect(result.success).toBe(true);
    const out = lastJson<{ path: string; steps: unknown[] }>();
    expect(out.steps).toEqual([]);
    // Behaviourally identical to the inline recipe this replaced.
    expect(existsSync(join(out.path, '.env'))).toBe(false);
    expect(existsSync(join(out.path, WORKTREE_STATE_FILE))).toBe(true);
  });

  it('exits 0 — nothing configured is not a failure', async () => {
    const result = await run(ctx(['add', 'feature/plain'], { from: 'main' }));
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================================
// AC4 — configured provisioning
// ============================================================================

describe('#1481 configured provisioning (AC4)', () => {
  it('copies, links and runs setup', async () => {
    writeFileSync(join(repo, '.env'), 'SECRET=1');
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
    writeConfig(
      'project:\n  name: t\nworktree:\n  copy: ".env"\n  link: "node_modules"\n' +
        `  setup: "node -e \\"require('fs').writeFileSync('idx.txt', process.env.MOFLO_WORKTREE_INDEX)\\""\n`,
    );
    const result = await run(ctx(['add', 'feature/full'], { from: 'main', json: true }));
    expect(result.success).toBe(true);
    const path = lastJson<{ path: string }>().path;
    // .env is gitignored, so the checkout cannot have supplied it.
    expect(readFileSync(join(path, '.env'), 'utf8')).toBe('SECRET=1');
    expect(existsSync(join(path, 'node_modules', 'pkg'))).toBe(true);
    expect(readFileSync(join(path, 'idx.txt'), 'utf8')).toBe('0');
  });

  it('exits non-zero and reports the step when provisioning fails', async () => {
    writeConfig('project:\n  name: t\nworktree:\n  setup: "node -e \\"process.exit(4)\\""\n');
    const result = await run(ctx(['add', 'feature/failing'], { from: 'main', json: true }));
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    const out = lastJson<{ path: string; provisioned: boolean; steps: Array<{ status: string }> }>();
    expect(out.provisioned).toBe(false);
    expect(out.steps[0].status).toBe('failed');
    // The worktree is a valid checkout either way — never unwound.
    expect(existsSync(out.path)).toBe(true);
  });

  it('honors a configured dir', async () => {
    writeConfig('project:\n  name: t\nworktree:\n  dir: ../trees\n');
    await run(ctx(['add', 'feature/d'], { from: 'main', json: true }));
    expect(lastJson<{ path: string }>().path).toBe(join(root, 'trees', 'feature-d'));
  });
});

// ============================================================================
// AC6 — index allocation across worktrees
// ============================================================================

describe('#1481 index allocation (AC6)', () => {
  it('gives successive worktrees distinct indices and reuses a freed one', async () => {
    await run(ctx(['add', 'feature/one'], { from: 'main', json: true }));
    expect(lastJson<{ index: number }>().index).toBe(0);
    await run(ctx(['add', 'feature/two'], { from: 'main', json: true }));
    expect(lastJson<{ index: number }>().index).toBe(1);

    await run(ctx(['remove', 'feature/one'], {}));
    await run(ctx(['add', 'feature/three'], { from: 'main', json: true }));
    // Reused, not incremented — consumers derive ports from this.
    expect(lastJson<{ index: number }>().index).toBe(0);
  });

  it('skips provisioning on --no-provision but still records state and exits 0', async () => {
    writeFileSync(join(repo, '.env'), 'SECRET=1');
    writeConfig('project:\n  name: t\nworktree:\n  copy: ".env"\n');
    // The parser turns `--no-provision` into `provision: false` (#1474).
    const result = await run(ctx(['add', 'feature/skip'], { from: 'main', json: true, provision: false }));
    expect(result.exitCode).toBe(0);
    const out = lastJson<{ path: string; steps: unknown[] }>();
    expect(out.steps).toEqual([]);
    expect(existsSync(join(out.path, '.env'))).toBe(false);
    expect(existsSync(join(out.path, WORKTREE_STATE_FILE))).toBe(true);
  });
});

// ============================================================================
// AC2 — list
// ============================================================================

describe('#1481 flo worktree list (AC2)', () => {
  it('marks a moflo-created worktree managed and an external one unmanaged', async () => {
    await run(ctx(['add', 'feature/managed'], { from: 'main', json: true }));
    git(['worktree', 'add', '-b', 'feature/external', join(root, 'external'), 'main'], repo);

    await run(ctx(['list'], { json: true }));
    const entries = lastJson<Array<{ branch: string; managed: boolean; primary: boolean; index: number | null }>>();
    const managed = entries.find(e => e.branch === 'feature/managed');
    const external = entries.find(e => e.branch === 'feature/external');
    expect(managed).toMatchObject({ managed: true, primary: false, index: 0 });
    expect(external).toMatchObject({ managed: false, primary: false, index: null });
  });

  it('flags the primary working tree', async () => {
    await run(ctx(['list'], { json: true }));
    const entries = lastJson<Array<{ branch: string; primary: boolean }>>();
    expect(entries[0]).toMatchObject({ branch: 'main', primary: true });
  });
});

// ============================================================================
// AC3 — remove
// ============================================================================

describe('#1481 flo worktree remove (AC3)', () => {
  it('removes by branch name', async () => {
    await run(ctx(['add', 'feature/gone'], { from: 'main', json: true }));
    const path = lastJson<{ path: string }>().path;
    const result = await run(ctx(['remove', 'feature/gone'], {}));
    expect(result.success).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('removes by path', async () => {
    await run(ctx(['add', 'feature/bypath'], { from: 'main', json: true }));
    const path = lastJson<{ path: string }>().path;
    const result = await run(ctx(['remove', path], {}));
    expect(result.success).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses a dirty worktree without --force, and removes it with', async () => {
    await run(ctx(['add', 'feature/dirty'], { from: 'main', json: true }));
    const path = lastJson<{ path: string }>().path;
    writeFileSync(join(path, 'README.md'), 'changed\n');

    const refused = await run(ctx(['remove', 'feature/dirty'], {}));
    expect(refused.success).toBe(false);
    expect(refused.message).toContain('uncommitted changes');
    expect(existsSync(path)).toBe(true);

    const forced = await run(ctx(['remove', 'feature/dirty'], { force: true }));
    expect(forced.success).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("removes a freshly created worktree without --force (moflo's own .moflo/ is not user work)", async () => {
    // Regression: `add` writes .moflo/worktree.json, which is untracked in a
    // project that does not gitignore `.moflo/`. Counting that as a user change
    // made every managed worktree unremovable without --force, which trains the
    // user to always pass it and defeats the dirty-tree guard entirely.
    await run(ctx(['add', 'feature/fresh'], { from: 'main', json: true }));
    const path = lastJson<{ path: string }>().path;
    expect(existsSync(join(path, WORKTREE_STATE_FILE))).toBe(true);
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: path, encoding: 'utf8' });
    expect(status.stdout).toContain('.moflo');

    const result = await run(ctx(['remove', 'feature/fresh'], {}));
    expect(result.success).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses when un-pushed SDD specs live in the worktree .moflo/ directory', async () => {
    // Only .moflo/worktree.json is excused — never the whole .moflo/ directory.
    // A worktree can hold un-pushed spec/plan work under .moflo/specs/, and
    // `remove` forces past git's own check, so missing this would delete it.
    await run(ctx(['add', 'feature/specs'], { from: 'main', json: true }));
    const path = lastJson<{ path: string }>().path;
    mkdirSync(join(path, '.moflo', 'specs', 'thing'), { recursive: true });
    writeFileSync(join(path, '.moflo', 'specs', 'thing', 'spec.md'), '# spec\n');

    const result = await run(ctx(['remove', 'feature/specs'], {}));
    expect(result.success).toBe(false);
    expect(result.message).toContain('spec.md');
    expect(existsSync(join(path, '.moflo', 'specs', 'thing', 'spec.md'))).toBe(true);
  });

  it('still refuses when user work sits alongside the moflo state file', async () => {
    await run(ctx(['add', 'feature/mixed'], { from: 'main', json: true }));
    const path = lastJson<{ path: string }>().path;
    writeFileSync(join(path, 'scratch.txt'), 'work');
    const result = await run(ctx(['remove', 'feature/mixed'], {}));
    expect(result.success).toBe(false);
    expect(result.message).toContain('scratch.txt');
    expect(existsSync(path)).toBe(true);
  });

  it('names the gitignored paths it destroyed that provisioning did not create', async () => {
    // `git status --porcelain` never lists ignored files, so the dirty gate
    // cannot see them — but removing the worktree deletes them. Warn, never
    // block: a project whose setup ran `npm ci` would otherwise be blocked on
    // every single removal.
    writeConfig('project:\n  name: t\nworktree:\n  copy: ".env"\n');
    writeFileSync(join(repo, '.env'), 'SECRET=1');
    await run(ctx(['add', 'feature/ignored'], { from: 'main', json: true }));
    const path = lastJson<{ path: string }>().path;
    writeFileSync(join(path, 'node_modules-note.txt'), 'x');
    mkdirSync(join(path, 'node_modules'), { recursive: true });
    writeFileSync(join(path, 'node_modules', 'installed.txt'), 'x');

    const result = await run(ctx(['remove', 'feature/ignored'], { json: true, force: true }));
    expect(result.success).toBe(true);
    const out = lastJson<{ discardedIgnored: string[] }>();
    // node_modules is gitignored and was NOT provisioned here, so it is named.
    expect(out.discardedIgnored.some(p => p.startsWith('node_modules'))).toBe(true);
    // .env was copied in by provisioning and still exists in the primary — noise.
    expect(out.discardedIgnored).not.toContain('.env');
  });

  it('does not misattribute a GLOB-provisioned file as unprovisioned', async () => {
    writeConfig('project:\n  name: t\nworktree:\n  copy: ".env.*"\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n.env\n.env.*\n');
    writeFileSync(join(repo, '.env.local'), 'A=1');
    git(['commit', '-aqm', 'ignore env globs'], repo);
    await run(ctx(['add', 'feature/globbed'], { from: 'main', json: true }));

    const result = await run(ctx(['remove', 'feature/globbed'], { json: true, force: true }));
    expect(result.success).toBe(true);
    // `.env.*` must match the concrete `.env.local` git reports, or provisioning
    // gets blamed for its own file on every removal.
    expect(lastJson<{ discardedIgnored: string[] }>().discardedIgnored).not.toContain('.env.local');
  });

  it('refuses a path that is not a registered worktree of this repo', async () => {
    const stranger = join(root, 'stranger');
    mkdirSync(stranger, { recursive: true });
    const result = await run(ctx(['remove', stranger], {}));
    expect(result.success).toBe(false);
    expect(result.message).toContain('Not a registered worktree');
    expect(existsSync(stranger)).toBe(true);
  });

  it('refuses to remove the primary working tree', async () => {
    const result = await run(ctx(['remove', 'main'], {}));
    expect(result.success).toBe(false);
    expect(result.message).toContain('primary working tree');
    expect(existsSync(repo)).toBe(true);
  });

  it('requires an argument', async () => {
    const result = await run(ctx(['remove'], {}));
    expect(result.success).toBe(false);
    expect(result.message).toContain('Usage');
  });
});

// ============================================================================
// AC10 — help surface
// ============================================================================

describe('#1481 help surface (AC10)', () => {
  it('prints usage listing all three subcommands and exits 0 with no subcommand', async () => {
    const result = await run(ctx([], {}));
    expect(result.exitCode).toBe(0);
    const help = logs.join('\n');
    for (const sub of ['add', 'list', 'remove']) expect(help).toContain(sub);
    expect(help).toContain('worktree:');
  });

  it('exits 1 on an unknown subcommand', async () => {
    const result = await run(ctx(['bogus'], {}));
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});
