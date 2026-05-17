/**
 * Tests for the `Nested .moflo/ Islands` doctor check (#1174).
 *
 * The check walks downward from the project root, BFS-bounded, looking for
 * sub-directories that have their own `.moflo/moflo.db`. Each is a daemon
 * island that fragments monorepo state. The fix archives them as
 * `.moflo-archived-<ISO>/`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  checkNestedMofloIslands,
  findNestedMofloDirsForFix,
} from '../commands/doctor-checks-config.js';

function makeTempRoot(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nested-moflo-${label}-`));
}

function seedMofloDb(dir: string): void {
  fs.mkdirSync(path.join(dir, '.moflo'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.moflo', 'moflo.db'), 'SQLite format 3\0');
}

describe('checkNestedMofloIslands (#1174)', () => {
  let root: string;

  beforeEach(() => { root = makeTempRoot('check'); });
  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('passes when no nested .moflo/ directories exist', async () => {
    seedMofloDb(root);
    fs.mkdirSync(path.join(root, 'packages', 'foo'), { recursive: true });
    const result = await checkNestedMofloIslands(root);
    expect(result.status).toBe('pass');
    expect(result.name).toBe('Nested .moflo/ Islands');
  });

  it('warns when a sub-package has its own .moflo/moflo.db (1-level)', async () => {
    seedMofloDb(root);
    const sub = path.join(root, 'packages', 'api');
    fs.mkdirSync(sub, { recursive: true });
    seedMofloDb(sub);

    const result = await checkNestedMofloIslands(root);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('1 nested');
    expect(result.message).toContain(path.join('packages', 'api'));
    expect(result.fix).toContain('nested-moflo');
  });

  it('finds multiple nested islands at different depths', async () => {
    seedMofloDb(root);
    const appA = path.join(root, 'apps', 'a');
    const appB = path.join(root, 'apps', 'b');
    fs.mkdirSync(appA, { recursive: true });
    fs.mkdirSync(appB, { recursive: true });
    seedMofloDb(appA);
    seedMofloDb(appB);

    const result = await checkNestedMofloIslands(root);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('2 nested');
  });

  it('does not recurse below a nested island', async () => {
    seedMofloDb(root);
    const outer = path.join(root, 'workspace', 'outer');
    const inner = path.join(outer, 'inner');
    fs.mkdirSync(inner, { recursive: true });
    seedMofloDb(outer);
    seedMofloDb(inner);

    // Both outer and inner have their own .moflo, but the BFS stops at outer
    // (descendants of a nested island would be conflated under that residue).
    const found = findNestedMofloDirsForFix(root);
    expect(found).toContain(outer);
    expect(found).not.toContain(inner);
  });

  it('skips node_modules and dist directories', async () => {
    seedMofloDb(root);
    const nm = path.join(root, 'node_modules', 'fakedep');
    const dist = path.join(root, 'dist');
    fs.mkdirSync(nm, { recursive: true });
    fs.mkdirSync(dist, { recursive: true });
    seedMofloDb(nm);
    seedMofloDb(dist);

    const result = await checkNestedMofloIslands(root);
    expect(result.status).toBe('pass');
  });

  it('skips additional build/cache directories (.turbo, vendor, __pycache__)', async () => {
    seedMofloDb(root);
    const turbo = path.join(root, '.turbo', 'cache-island');
    const vendor = path.join(root, 'vendor', 'github.com', 'pkg');
    const pycache = path.join(root, '__pycache__', 'mod');
    fs.mkdirSync(turbo, { recursive: true });
    fs.mkdirSync(vendor, { recursive: true });
    fs.mkdirSync(pycache, { recursive: true });
    seedMofloDb(turbo);
    seedMofloDb(vendor);
    seedMofloDb(pycache);

    const result = await checkNestedMofloIslands(root);
    expect(result.status).toBe('pass');
  });

  it('skips archived .moflo-archived-* directories from prior fix runs', async () => {
    seedMofloDb(root);
    const sub = path.join(root, 'packages', 'api');
    fs.mkdirSync(sub, { recursive: true });
    // Archived residue from a prior `flo doctor --fix` run — not an active island.
    fs.mkdirSync(path.join(sub, '.moflo-archived-2026-05-17T10-30-00-000Z'), { recursive: true });
    fs.writeFileSync(
      path.join(sub, '.moflo-archived-2026-05-17T10-30-00-000Z', 'moflo.db'),
      'SQLite format 3\0',
    );

    const result = await checkNestedMofloIslands(root);
    expect(result.status).toBe('pass');
  });
});
