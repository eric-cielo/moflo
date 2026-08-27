/**
 * Tests for worktree provisioning (#1481) — `src/cli/services/worktree-provision.ts`
 * and the `worktree:` block in `moflo.yaml`.
 *
 * The service holds every platform-sensitive decision precisely so those
 * branches are reachable from a unit test on any host (Rule #1): the Windows
 * junction choice is a pure exported function asserted directly, rather than
 * gated behind a Windows runner (an ESM `fs` export cannot be spied on). The
 * containment guard is exercised through a symlinked tempdir so the macOS
 * `/var/folders` → `/private/var/folders` shape (#1145) is covered on the Linux
 * CI leg too.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  readlinkSync,
  writeFileSync,
  existsSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { join, sep, dirname, basename, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { generateMofloConfig, loadMofloConfig } from '../config/moflo-config.js';
import {
  WORKTREE_STATE_FILE,
  allocateIndex,
  WORKTREE_STATE_FILE_POSIX,
  computeWorktreePath,
  isInside,
  isProvisionedPath,
  linkTypeForPlatform,
  resolveForCompare,
  provisionWorktree,
  readWorktreeState,
  slugifyBranch,
  writeWorktreeState,
} from '../services/worktree-provision.js';

let root: string;
let worktree: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'moflo-wt-'));
  worktree = join(root, 'wt');
  mkdirSync(worktree, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ============================================================================
// AC1 — path computation
// ============================================================================

describe('#1481 computeWorktreePath (AC1)', () => {
  it('defaults to a sibling <repo>-worktrees directory', () => {
    const repo = join(root, 'myrepo');
    const result = computeWorktreePath(repo, 'feature/1481-x');
    expect(result).toBe(join(dirname(repo), 'myrepo-worktrees', 'feature-1481-x'));
    // Built with path.*, so it carries the host separator and never a literal '/'.
    expect(result.includes(sep)).toBe(true);
  });

  it('sits outside the checkout, never inside it', () => {
    const repo = join(root, 'myrepo');
    expect(isInside(repo, computeWorktreePath(repo, 'feature/x'))).toBe(false);
  });

  it('slugs both separators so the directory name is flat and NTFS-valid', () => {
    expect(slugifyBranch('feature/1481-x')).toBe('feature-1481-x');
    expect(slugifyBranch('feature\\1481-x')).toBe('feature-1481-x');
    expect(basename(computeWorktreePath(join(root, 'r'), 'a/b/c'))).toBe('a-b-c');
  });

  it('honors a configured dir, resolving a relative one against the repo root', () => {
    const repo = join(root, 'myrepo');
    expect(computeWorktreePath(repo, 'x', join(root, 'elsewhere'))).toBe(join(root, 'elsewhere', 'x'));
    expect(computeWorktreePath(repo, 'x', '../trees')).toBe(join(root, 'trees', 'x'));
  });
});

// ============================================================================
// AC6 — index allocation
// ============================================================================

describe('#1481 allocateIndex (AC6)', () => {
  it('starts at 0 and increments while slots are taken', () => {
    expect(allocateIndex([])).toBe(0);
    expect(allocateIndex([0])).toBe(1);
    expect(allocateIndex([0, 1, 2])).toBe(3);
  });

  it('reuses a freed slot rather than growing unbounded', () => {
    // Consumers derive ports from this index; an ever-growing counter would
    // eventually push a derived port out of range.
    expect(allocateIndex([0, 2])).toBe(1);
    expect(allocateIndex([1, 2, 3])).toBe(0);
  });

  it('ignores malformed entries', () => {
    expect(allocateIndex([-1, 1.5, Number.NaN, 0] as number[])).toBe(1);
  });
});

// ============================================================================
// AC7/AC8 — containment guard, realpath both sides
// ============================================================================

describe('#1481 isInside (AC7, AC8)', () => {
  it('accepts a path inside the root and the root itself', () => {
    expect(isInside(root, join(root, 'a', 'b'))).toBe(true);
    expect(isInside(root, root)).toBe(true);
  });

  it('rejects a sibling and a parent-escaping path', () => {
    expect(isInside(join(root, 'a'), join(root, 'b'))).toBe(false);
    expect(isInside(join(root, 'a'), join(root, 'a', '..', '..', 'secrets'))).toBe(false);
  });

  it('rejects a prefix-sharing sibling directory', () => {
    // `/x/repo-worktrees` must not read as inside `/x/repo`.
    expect(isInside(join(root, 'repo'), join(root, 'repo-worktrees', 'a'))).toBe(false);
  });

  it('resolves symlinks on BOTH sides (#1145 shape)', () => {
    // The macOS /var/folders -> /private/var/folders case: an unresolved path
    // compared against a resolved one made two identical paths look different.
    const real = join(root, 'real');
    mkdirSync(join(real, 'nested'), { recursive: true });
    const linked = join(root, 'linked');
    symlinkSync(real, linked);
    expect(isInside(real, join(linked, 'nested'))).toBe(true);
    expect(isInside(linked, join(real, 'nested'))).toBe(true);
  });

  it('works for a destination that does not exist yet', () => {
    expect(isInside(root, join(root, 'not', 'created', 'yet'))).toBe(true);
  });

  it('treats a path as inside ITSELF even when the equality shortcut misses', () => {
    // `path.relative` returns '' for two spellings of the same directory that
    // string equality missed (case differences on win32/APFS). A `rel.length > 0`
    // guard would call that "not inside" and break every identity test built on
    // this — remove-by-path and the already-registered scan both depend on it.
    expect(isInside(root, root)).toBe(true);
    expect(isInside(join(root, 'a', '..'), root)).toBe(true);
  });
});

describe('#1481 resolveForCompare (AC3, AC8)', () => {
  it('produces the same key for two spellings of one directory', () => {
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    const key = resolveForCompare(join(root, 'a', 'b'));
    expect(resolveForCompare(join(root, 'a', '..', 'a', 'b'))).toBe(key);
    expect(resolveForCompare(join(root, 'a'))).not.toBe(key);
  });

  it('sees through a symlink on both sides', () => {
    const real = join(root, 'real');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(root, 'linked'));
    expect(resolveForCompare(join(root, 'linked'))).toBe(resolveForCompare(real));
  });

  it('case-folds exactly on the platforms with a case-insensitive filesystem', () => {
    // This is what makes plain string equality on the key a correct identity
    // test on win32/APFS, where `C:\\Repo` and `C:\\repo` are one directory.
    mkdirSync(join(root, 'MixedCase'), { recursive: true });
    const key = resolveForCompare(join(root, 'MixedCase'));
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(key).toBe(key.toLowerCase());
    } else {
      expect(key).toContain('MixedCase');
    }
  });
})

// ============================================================================
// AC7 — copy
// ============================================================================

describe('#1481 provision copy (AC7)', () => {
  it('copies a literal gitignored file into the worktree', () => {
    writeFileSync(join(root, '.env'), 'SECRET=1');
    const result = provisionWorktree({
      primaryRoot: root,
      worktreePath: worktree,
      branch: 'b',
      index: 0,
      config: { copy: ['.env'] },
    });
    expect(result.provisioned).toBe(true);
    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('SECRET=1');
  });

  it('expands a single trailing glob within one directory level', () => {
    writeFileSync(join(root, '.env.local'), 'A');
    writeFileSync(join(root, '.env.test'), 'B');
    writeFileSync(join(root, 'my.env.backup'), 'C');
    provisionWorktree({
      primaryRoot: root,
      worktreePath: worktree,
      branch: 'b',
      index: 0,
      config: { copy: ['.env.*'] },
    });
    expect(existsSync(join(worktree, '.env.local'))).toBe(true);
    expect(existsSync(join(worktree, '.env.test'))).toBe(true);
    // Anchored: `.env.*` must not match `my.env.backup`.
    expect(existsSync(join(worktree, 'my.env.backup'))).toBe(false);
  });

  it('does not let a dot in the pattern match an arbitrary character', () => {
    // The `docs/*.md` matching `docsXmd` shape the shared translator was
    // hardened against: the `.` must be escaped, not treated as a wildcard.
    writeFileSync(join(root, '.envXlocal'), 'A');
    provisionWorktree({
      primaryRoot: root,
      worktreePath: worktree,
      branch: 'b',
      index: 0,
      config: { copy: ['.env.*'] },
    });
    expect(existsSync(join(worktree, '.envXlocal'))).toBe(false);
  });

  it('rejects a source resolving outside the primary checkout', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secrets'), 'leak');
    const primary = join(root, 'primary');
    mkdirSync(primary, { recursive: true });

    const result = provisionWorktree({
      primaryRoot: primary,
      worktreePath: worktree,
      branch: 'b',
      index: 0,
      config: { copy: ['../outside/secrets'] },
    });
    expect(result.provisioned).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: 'copy', status: 'failed' });
    expect(result.steps[0].detail).toContain('outside the primary checkout');
    expect(existsSync(join(worktree, 'outside', 'secrets'))).toBe(false);
  });

  it('skips a missing source without failing the run', () => {
    const result = provisionWorktree({
      primaryRoot: root,
      worktreePath: worktree,
      branch: 'b',
      index: 0,
      config: { copy: ['.env.local'] },
    });
    // `.env.local` legitimately does not exist on every machine.
    expect(result.provisioned).toBe(true);
    expect(result.steps[0]).toMatchObject({ kind: 'copy', status: 'skipped' });
  });

  it('copies a directory recursively', () => {
    mkdirSync(join(root, 'config', 'nested'), { recursive: true });
    writeFileSync(join(root, 'config', 'nested', 'a.json'), '{}');
    provisionWorktree({
      primaryRoot: root,
      worktreePath: worktree,
      branch: 'b',
      index: 0,
      config: { copy: ['config'] },
    });
    expect(existsSync(join(worktree, 'config', 'nested', 'a.json'))).toBe(true);
  });
});

// ============================================================================
// AC7/AC8 — link, including the Windows junction branch
// ============================================================================

describe('#1481 provision link (AC7, AC8)', () => {
  it('creates a real symlink whose target is ABSOLUTE', () => {
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    const result = provisionWorktree({
      primaryRoot: root,
      worktreePath: worktree,
      branch: 'b',
      index: 0,
      config: { link: ['node_modules'] },
    });
    expect(result.provisioned).toBe(true);
    // A RELATIVE target silently produces a broken junction on Windows, so the
    // target is resolved to absolute on every platform. Asserted against the
    // link actually on disk rather than a spy.
    const target = readlinkSync(join(worktree, 'node_modules'));
    expect(isAbsolute(target)).toBe(true);
    expect(realpathSync(target)).toBe(realpathSync(join(root, 'node_modules')));
    expect(existsSync(join(worktree, 'node_modules', 'pkg'))).toBe(true);
  });

  it("selects type 'junction' on Windows and none on POSIX", () => {
    // Junctions need no admin rights / developer mode, unlike 'dir' symlinks.
    // The decision is a pure exported function precisely so this branch is
    // assertable on a Linux or macOS runner — an ESM `fs` export cannot be
    // spied on, and a Windows-only assertion would go unverified on the two CI
    // legs that run most often.
    expect(linkTypeForPlatform('win32')).toBe('junction');
    expect(linkTypeForPlatform('linux')).toBeUndefined();
    expect(linkTypeForPlatform('darwin')).toBeUndefined();
  });

  it('does not clobber an existing destination', () => {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    mkdirSync(join(worktree, 'node_modules'), { recursive: true });
    writeFileSync(join(worktree, 'node_modules', 'mine.txt'), 'keep');
    const result = provisionWorktree({
      primaryRoot: root,
      worktreePath: worktree,
      branch: 'b',
      index: 0,
      config: { link: ['node_modules'] },
    });
    expect(result.steps[0]).toMatchObject({ kind: 'link', status: 'skipped' });
    expect(readFileSync(join(worktree, 'node_modules', 'mine.txt'), 'utf8')).toBe('keep');
  });

  it('does not clobber a BROKEN symlink left by an earlier run', () => {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    symlinkSync(join(root, 'gone'), join(worktree, 'node_modules'));
    const result = provisionWorktree({
      primaryRoot: root,
      worktreePath: worktree,
      branch: 'b',
      index: 0,
      config: { link: ['node_modules'] },
    });
    // existsSync() follows the link and reports false; lstat is what catches this.
    expect(result.steps[0]).toMatchObject({ kind: 'link', status: 'skipped' });
  });

  it('rejects a link entry that escapes the primary checkout', () => {
    const primary = join(root, 'primary');
    mkdirSync(join(root, 'outside', 'nm'), { recursive: true });
    mkdirSync(primary, { recursive: true });
    const result = provisionWorktree({
      primaryRoot: primary,
      worktreePath: worktree,
      branch: 'b',
      index: 0,
      config: { link: ['../outside/nm'] },
    });
    // Same guard runCopy has: without it the link is written outside the
    // worktree and sources from outside the checkout.
    expect(result.provisioned).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: 'link', status: 'failed' });
    expect(existsSync(join(root, 'outside', 'nm', 'x'))).toBe(false);
  });

  it('re-links cleanly on a RE-ADD, when the destination is already a symlink out of the tree', () => {
    // Regression from the escape guard: realpathing the destination resolves an
    // existing node_modules symlink back to the primary checkout, which reads as
    // "outside the worktree" and rejects the very link provisioning just made.
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    const config = { link: ['node_modules'] };
    const first = provisionWorktree({ primaryRoot: root, worktreePath: worktree, branch: 'b', index: 0, config });
    expect(first.provisioned).toBe(true);
    const second = provisionWorktree({ primaryRoot: root, worktreePath: worktree, branch: 'b', index: 0, config });
    expect(second.provisioned).toBe(true);
    expect(second.steps[0]).toMatchObject({ kind: 'link', status: 'skipped', detail: 'already exists' });
  });

  it('links a primary path that is itself a symlink (pnpm / shared store)', () => {
    const store = join(root, 'store');
    mkdirSync(join(store, 'pkg'), { recursive: true });
    symlinkSync(store, join(root, 'node_modules'));
    const result = provisionWorktree({
      primaryRoot: root,
      worktreePath: worktree,
      branch: 'b',
      index: 0,
      config: { link: ['node_modules'] },
    });
    expect(result.provisioned).toBe(true);
    expect(existsSync(join(worktree, 'node_modules', 'pkg'))).toBe(true);
  });

  it('skips a link source that does not exist', () => {
    const result = provisionWorktree({
      primaryRoot: root,
      worktreePath: worktree,
      branch: 'b',
      index: 0,
      config: { link: ['node_modules'] },
    });
    expect(result.steps[0]).toMatchObject({ kind: 'link', status: 'skipped' });
    expect(result.provisioned).toBe(true);
  });
});

// ============================================================================
// AC6 — setup command + MOFLO_WORKTREE_INDEX
// ============================================================================

describe('#1481 provision setup (AC6)', () => {
  it('runs in the worktree with MOFLO_WORKTREE_INDEX in its environment', () => {
    const result = provisionWorktree({
      primaryRoot: root,
      worktreePath: worktree,
      branch: 'b',
      index: 3,
      // node -e, not a shell builtin: Windows has no `echo > file` equivalent
      // on PATH, and this must run identically on all three platforms (Rule #1).
      config: {
        setup: `node -e "require('fs').writeFileSync('idx.txt', process.env.MOFLO_WORKTREE_INDEX)"`,
      },
      jsonMode: true,
    });
    expect(result.provisioned).toBe(true);
    expect(readFileSync(join(worktree, 'idx.txt'), 'utf8')).toBe('3');
  });

  it('marks the provision failed on a non-zero exit but leaves the worktree in place', () => {
    const result = provisionWorktree({
      primaryRoot: root,
      worktreePath: worktree,
      branch: 'b',
      index: 0,
      config: { setup: 'node -e "process.exit(3)"' },
      jsonMode: true,
    });
    expect(result.provisioned).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: 'setup', status: 'failed' });
    // A failed step must never unwind a tree the user may already be working in.
    expect(existsSync(worktree)).toBe(true);
    expect(readWorktreeState(worktree)?.provisioned).toBe(false);
  });

  it('runs copy and link before setup', () => {
    writeFileSync(join(root, '.env'), 'A=1');
    const result = provisionWorktree({
      primaryRoot: root,
      worktreePath: worktree,
      branch: 'b',
      index: 0,
      config: {
        copy: ['.env'],
        setup: `node -e "if(!require('fs').existsSync('.env'))process.exit(1)"`,
      },
      jsonMode: true,
    });
    // setup (typically `npm ci`) may depend on the .env material copy brings in.
    expect(result.provisioned).toBe(true);
    expect(result.steps.map(s => s.kind)).toEqual(['copy', 'setup']);
  });
});

// ============================================================================
// AC2/AC6 — state file
// ============================================================================

describe('#1481 worktree state file (AC2, AC6)', () => {
  it('records branch, index, primaryRoot and provisioned', () => {
    provisionWorktree({ primaryRoot: root, worktreePath: worktree, branch: 'feature/x', index: 2 });
    const state = readWorktreeState(worktree);
    expect(state).toEqual({ branch: 'feature/x', index: 2, primaryRoot: root, provisioned: true });
    expect(existsSync(join(worktree, WORKTREE_STATE_FILE))).toBe(true);
  });

  it('returns null for a worktree moflo did not create', () => {
    // This is how `flo worktree list` reports an externally-created worktree.
    expect(readWorktreeState(worktree)).toBeNull();
  });

  it('returns null for a malformed state file rather than throwing', () => {
    mkdirSync(join(worktree, '.moflo'), { recursive: true });
    writeFileSync(join(worktree, WORKTREE_STATE_FILE), 'not json');
    expect(readWorktreeState(worktree)).toBeNull();
    writeFileSync(join(worktree, WORKTREE_STATE_FILE), '{"branch":1}');
    expect(readWorktreeState(worktree)).toBeNull();
  });

  it('exposes the state path in git spelling for porcelain comparison', () => {
    // `git status --porcelain` reports forward slashes on every platform, so a
    // caller comparing against it needs this form, not the host-separator one.
    expect(WORKTREE_STATE_FILE_POSIX).toBe('.moflo/worktree.json');
    expect(WORKTREE_STATE_FILE_POSIX).toBe(WORKTREE_STATE_FILE.split(sep).join('/'));
  });

  it('round-trips through writeWorktreeState', () => {
    writeWorktreeState(worktree, { branch: 'b', index: 7, primaryRoot: root, provisioned: false });
    expect(readWorktreeState(worktree)).toMatchObject({ index: 7, provisioned: false });
  });
});

// ============================================================================
// AC4/AC5 — config parsing
// ============================================================================

describe('#1481 moflo.yaml worktree block (AC4, AC5)', () => {
  const writeConfig = (yaml: string): void => writeFileSync(join(root, 'moflo.yaml'), yaml);

  it('AC5: a config with NO worktree block loads and leaves the key undefined', () => {
    // The consumer-upgrade case: this is what proves the change is non-breaking.
    writeConfig('project:\n  name: t\n');
    expect(loadMofloConfig(root).worktree).toBeUndefined();
  });

  it('AC5: no config file at all still loads', () => {
    expect(loadMofloConfig(root).worktree).toBeUndefined();
  });

  it('parses dir, copy, link and setup', () => {
    writeConfig(
      'project:\n  name: t\nworktree:\n  dir: ../trees\n  copy: [".env"]\n  link: ["node_modules"]\n  setup: npm ci\n',
    );
    expect(loadMofloConfig(root).worktree).toEqual({
      dir: '../trees',
      copy: ['.env'],
      link: ['node_modules'],
      setup: 'npm ci',
    });
  });

  it('accepts a bare string for copy and link', () => {
    writeConfig('project:\n  name: t\nworktree:\n  copy: .env\n  link: node_modules\n');
    expect(loadMofloConfig(root).worktree).toEqual({ copy: ['.env'], link: ['node_modules'] });
  });

  it('ignores unknown sub-keys rather than failing to parse', () => {
    // A consumer's config must never fail to load on an unrecognised entry.
    writeConfig('project:\n  name: t\nworktree:\n  copy: .env\n  future_key: yes\n');
    expect(loadMofloConfig(root).worktree).toEqual({ copy: ['.env'] });
  });

  it('treats an empty or malformed block as absent', () => {
    writeConfig('project:\n  name: t\nworktree:\n  copy: []\n  setup: "  "\n');
    expect(loadMofloConfig(root).worktree).toBeUndefined();
  });

  it('drops non-string entries from copy/link', () => {
    writeConfig('project:\n  name: t\nworktree:\n  copy: [".env", 42, null]\n');
    expect(loadMofloConfig(root).worktree).toEqual({ copy: ['.env'] });
  });
});

// ============================================================================
// AC3 — attributing a worktree path back to provisioning
// ============================================================================

describe('#1481 isProvisionedPath (AC3)', () => {
  it('matches a GLOB copy entry against the concrete filename git reports', () => {
    // The bug this exists to prevent: comparing `.env.*` literally against
    // `.env.local` never matches, so `remove` blamed provisioning's own files
    // on the user on every single removal.
    const config = { copy: ['.env.*'] };
    expect(isProvisionedPath('.env.local', config)).toBe(true);
    expect(isProvisionedPath('.env.test', config)).toBe(true);
    expect(isProvisionedPath('scratch.txt', config)).toBe(false);
  });

  it('matches literal file and directory entries', () => {
    const config = { copy: ['.env'], link: ['node_modules'] };
    expect(isProvisionedPath('.env', config)).toBe(true);
    expect(isProvisionedPath('node_modules', config)).toBe(true);
    // `git status -uall` reports a directory's files individually.
    expect(isProvisionedPath('node_modules/pkg/index.js', config)).toBe(true);
    expect(isProvisionedPath('node_modules-backup', config)).toBe(false);
  });

  it('claims the contents of a directory a glob entry matched', () => {
    expect(isProvisionedPath('cfgs/a.json', { copy: ['cfg*'] })).toBe(true);
    expect(isProvisionedPath('other/a.json', { copy: ['cfg*'] })).toBe(false);
  });

  it('matches a nested entry written with either separator', () => {
    expect(isProvisionedPath('config/local.json', { copy: ['config/local.json'] })).toBe(true);
    expect(isProvisionedPath('config/local.json', { copy: ['config\\local.json'] })).toBe(true);
  });

  it('claims nothing when no block is configured', () => {
    expect(isProvisionedPath('.env', undefined)).toBe(false);
    expect(isProvisionedPath('.env', {})).toBe(false);
  });
});

// ============================================================================
// AC10 — the generated moflo.yaml documents the surface
// ============================================================================

describe('#1481 moflo.yaml template (AC10)', () => {
  const template = generateMofloConfig(root);

  it('ships a commented worktree block naming every key', () => {
    expect(template).toMatch(/# worktree:/);
    for (const key of ['dir:', 'copy:', 'link:', 'setup:']) expect(template).toContain(key);
  });

  it('documents the port-offset contract and the secret-relocation caveat', () => {
    // These two are the surprising parts: a consumer cannot discover the env
    // var from the schema, and `copy:` moving secrets outside the repo is the
    // kind of thing that must be stated where the user configures it.
    expect(template).toContain('MOFLO_WORKTREE_INDEX');
    expect(template).toMatch(/secret/i);
  });

  it('stays commented out, so a fresh project provisions nothing by default', () => {
    const active = template.split(/\r?\n/).filter(l => /^worktree:/.test(l));
    expect(active).toEqual([]);
  });
});

// ============================================================================
// AC5 — no-config parity
// ============================================================================

describe('#1481 no-config parity (AC5)', () => {
  it('provisions nothing but still records state when no block is configured', () => {
    writeFileSync(join(root, '.env'), 'SECRET=1');
    const result = provisionWorktree({
      primaryRoot: root,
      worktreePath: worktree,
      branch: 'b',
      index: 0,
      config: undefined,
    });
    expect(result.steps).toEqual([]);
    expect(result.provisioned).toBe(true);
    // Behaviourally identical to the inline `git worktree add` recipe it replaced.
    expect(existsSync(join(worktree, '.env'))).toBe(false);
    expect(readWorktreeState(worktree)).not.toBeNull();
  });
});

// ============================================================================
// AC8 — Rule #1 static guard
// ============================================================================

describe('#1481 Rule #1 guard (AC8)', () => {
  const sources = [
    'src/cli/services/worktree-provision.ts',
    'src/cli/commands/worktree.ts',
  ];

  it('shells out to no POSIX-only coreutils and hardcodes no paths', () => {
    const banned: Array<[RegExp, string]> = [
      [/spawnSync\(\s*['"](cp|ln|rm|mkdir|find|grep|sed|cat)['"]/, 'POSIX-only coreutil spawn'],
      [/['"]\/tmp\//, 'hardcoded /tmp'],
      [/['"]C:\\\\/, 'hardcoded Windows path'],
      [/mkdir -p|rm -rf|ln -s/, 'shell file-op string'],
    ];
    for (const file of sources) {
      const text = readFileSync(join(realpathSync(process.cwd()), file), 'utf8');
      // Comments legitimately name these commands when explaining why they are
      // not used; strip them before matching so the guard tests the code.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const [pattern, label] of banned) {
        expect(pattern.test(code), `${file}: ${label}`).toBe(false);
      }
    }
  });

  it('builds every path through node:path', () => {
    for (const file of sources) {
      const text = readFileSync(join(realpathSync(process.cwd()), file), 'utf8');
      expect(text).toMatch(/from 'node:path'/);
    }
  });
});
