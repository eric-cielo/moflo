/**
 * The filesystem half of the dead-path pass (#1479).
 *
 * `learnings-dead-paths.test.ts` drives the rules against a predicate; this
 * drives the predicate against a real directory tree, because the two ways this
 * half can be wrong — a path joined with the wrong separator, a workspace layout
 * that yields no prefixes — are both invisible to a stubbed resolver.
 *
 * Cross-platform (Rule #1): every fixture path is built with `path.join`, the
 * tree is `os.tmpdir()`-rooted, and the resolver is fed the forward-slash form
 * entries are authored with on all three platforms.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  MAX_WORKSPACE_PREFIXES,
  listWorkspacePrefixes,
  makeTreeResolver,
} from '../../memory/learnings-tree.js';

let root: string;

function makeRoot(): string {
  // realpath: macOS os.tmpdir() is a symlink into /private/var (Rule #1).
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-1479-')));
}

function touch(dir: string, ...segments: string[]): void {
  const file = path.join(dir, ...segments);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '', 'utf-8');
}

beforeAll(() => {
  root = makeRoot();
});

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* best-effort — Windows can hold a brief handle */
  }
});

describe('makeTreeResolver', () => {
  it('resolves a forward-slash path against the host separator', () => {
    const dir = path.join(root, 'resolver');
    touch(dir, 'src', 'cli', 'output.ts');
    const resolves = makeTreeResolver(dir);

    expect(resolves('src/cli/output.ts')).toBe(true);
    expect(resolves('src/cli/missing.ts')).toBe(false);
  });

  it('counts a directory, not only a file — a moved directory is the same finding', () => {
    const dir = path.join(root, 'dirs');
    touch(dir, 'guidance', 'shipped', 'rules.md');
    const resolves = makeTreeResolver(dir);

    expect(resolves('guidance/shipped/')).toBe(true);
    expect(resolves('guidance/shipped')).toBe(true);
    expect(resolves('guidance/internal/')).toBe(false);
  });

  it('refuses a traversal segment rather than answering about a path outside the repo', () => {
    const dir = path.join(root, 'traversal', 'nested');
    fs.mkdirSync(dir, { recursive: true });
    touch(path.join(root, 'traversal'), 'outside.ts');

    expect(makeTreeResolver(dir)('../outside.ts')).toBe(false);
  });

  it('reads an empty or dot-only path as unresolved rather than as the project root', () => {
    const resolves = makeTreeResolver(root);

    expect(resolves('')).toBe(false);
    expect(resolves('.')).toBe(false);
    expect(resolves('./')).toBe(false);
  });
});

describe('listWorkspacePrefixes', () => {
  it('offers the top-level directories of a flat repo', () => {
    const dir = path.join(root, 'flat');
    for (const name of ['src', 'tests', 'docs']) fs.mkdirSync(path.join(dir, name), { recursive: true });

    expect(listWorkspacePrefixes(dir)).toEqual(['docs', 'src', 'tests']);
  });

  it('keeps dot directories and drops only the ones that say nothing about the entry', () => {
    const dir = path.join(root, 'skips');
    for (const name of ['src', 'node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.claude']) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
    }

    // A stale `dist/` would resolve a path whose source has been deleted, which
    // is the one answer this pass must never give. `.claude/` is the opposite —
    // learnings cite it constantly, so excluding every dot directory would cost
    // real resolutions.
    expect(listWorkspacePrefixes(dir)).toEqual(['.claude', 'src']);
  });

  it('expands a declared workspace glob ahead of the bare directory walk', () => {
    const dir = path.join(root, 'monorepo');
    fs.mkdirSync(path.join(dir, 'packages', 'api'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'packages', 'web'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }),
      'utf-8',
    );

    // `packages/api` is a more specific answer than the bare `packages` the walk
    // offers, so it has to be tried first.
    expect(listWorkspacePrefixes(dir)).toEqual(['packages/api', 'packages/web', 'packages']);
  });

  it('reads the npm/yarn object form of the workspaces field', () => {
    const dir = path.join(root, 'mono-object');
    fs.mkdirSync(path.join(dir, 'apps', 'web'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ workspaces: { packages: ['apps/*', 'tools/cli'] } }),
      'utf-8',
    );

    expect(listWorkspacePrefixes(dir)).toEqual(['apps/web', 'tools/cli', 'apps']);
  });

  it('leaves a ** glob to the directory walk instead of walking the whole tree', () => {
    const dir = path.join(root, 'deep-glob');
    fs.mkdirSync(path.join(dir, 'packages', 'api'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ workspaces: ['packages/**'] }),
      'utf-8',
    );

    // The glob contributes nothing; `packages/api` is here because the ordinary
    // two-level walk reaches it, not because `**` was expanded.
    expect(listWorkspacePrefixes(dir)).toEqual(['packages', 'packages/api']);
  });

  it('descends one level below the top, where the source root usually is', () => {
    // `src/cli/commands/x.ts` cited as `commands/x.ts` is the shape this exists
    // for: the directory a learning writes relative to is nested inside a
    // top-level container, not the container itself.
    const dir = path.join(root, 'nested-root');
    fs.mkdirSync(path.join(dir, 'src', 'cli', 'commands'), { recursive: true });

    const prefixes = listWorkspacePrefixes(dir);

    expect(prefixes).toEqual(['src', 'src/cli']);
    // Depth 3 would start resolving paths by coincidence rather than by layout.
    expect(prefixes).not.toContain('src/cli/commands');
  });

  it('refuses to descend into a wide directory, so one scratch dir cannot starve the budget', () => {
    // A container holds one or two entries; a directory holding thirty is
    // already the source root and its children are not prefixes anybody writes
    // relative to. Measured on this repo, a `tmp/` full of test fixtures took
    // every slot after the top level.
    const dir = path.join(root, 'wide-child');
    for (let i = 0; i < 30; i++) fs.mkdirSync(path.join(dir, 'tmp', `fixture-${i}`), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'cli'), { recursive: true });

    expect(listWorkspacePrefixes(dir)).toEqual(['src', 'tmp', 'src/cli']);
  });

  it('survives a missing or unparseable manifest', () => {
    const dir = path.join(root, 'bad-manifest');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{ not json', 'utf-8');

    expect(listWorkspacePrefixes(dir)).toEqual(['src']);
    expect(listWorkspacePrefixes(path.join(root, 'does-not-exist'))).toEqual([]);
  });

  it('caps the prefix list — every unresolved path costs one lookup per prefix', () => {
    const dir = path.join(root, 'wide');
    for (let i = 0; i < MAX_WORKSPACE_PREFIXES + 10; i++) {
      fs.mkdirSync(path.join(dir, `pkg-${String(i).padStart(3, '0')}`), { recursive: true });
    }

    expect(listWorkspacePrefixes(dir)).toHaveLength(MAX_WORKSPACE_PREFIXES);
  });
});
