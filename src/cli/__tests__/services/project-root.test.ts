/**
 * Project Root Tests
 *
 * Validates findProjectRoot() walks up from cwd to find package.json or .git,
 * and that memory markers (.moflo/moflo.db, .swarm/memory.db) anchor to the
 * TOPMOST ancestor — not the nearest — so monorepos don't fragment daemons
 * (#1174).
 *
 * Story #229: Extracted from workflow-tools.ts.
 * Story #1057: Aligned with bridge-core.getProjectRoot().
 * Issue #1174: Memory markers anchor topmost, not nearest.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findProjectRoot } from '../../services/project-root.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('findProjectRoot', () => {
  it('should return a directory containing package.json or .git', () => {
    const root = findProjectRoot();
    const hasPackageJson = existsSync(resolve(root, 'package.json'));
    const hasGit = existsSync(resolve(root, '.git'));
    expect(hasPackageJson || hasGit).toBe(true);
  });

  it('should return a string path', () => {
    expect(typeof findProjectRoot()).toBe('string');
  });

  it('should return the same value on repeated calls', () => {
    expect(findProjectRoot()).toBe(findProjectRoot());
  });
});

describe('findProjectRoot — monorepo memory-marker anchoring (#1174)', () => {
  // Each test isolates env so CLAUDE_PROJECT_DIR (set by Claude Code session
  // start) can't override the cwd walk-up we're trying to verify.
  let fixtureRoot: string;
  let prevClaudeProjectDir: string | undefined;

  beforeEach(() => {
    prevClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    fixtureRoot = mkdtempSync(join(tmpdir(), 'project-root-1174-'));
  });

  afterEach(() => {
    if (prevClaudeProjectDir !== undefined) {
      process.env.CLAUDE_PROJECT_DIR = prevClaudeProjectDir;
    }
    try {
      rmSync(fixtureRoot, { recursive: true, force: true });
    } catch { /* Windows file handles occasionally linger */ }
  });

  function seedMofloDb(dir: string) {
    mkdirSync(join(dir, '.moflo'), { recursive: true });
    writeFileSync(join(dir, '.moflo', 'moflo.db'), 'SQLite format 3\0');
  }

  it('returns workspace root when nested package has .moflo residue (1-level)', () => {
    const workspace = join(fixtureRoot, 'mono');
    const subpkg = join(workspace, 'packages', 'api');
    const subSrc = join(subpkg, 'src');
    mkdirSync(subSrc, { recursive: true });
    seedMofloDb(workspace);
    seedMofloDb(subpkg);
    writeFileSync(join(workspace, 'package.json'), '{}');
    writeFileSync(join(subpkg, 'package.json'), '{}');

    expect(findProjectRoot({ cwd: subSrc, honorEnv: false })).toBe(workspace);
  });

  it('returns topmost when .moflo residue exists at 2 nested levels', () => {
    const workspace = join(fixtureRoot, 'mono-2level');
    const intermediate = join(workspace, 'apps', 'web');
    const sub = join(intermediate, 'api');
    const subSrc = join(sub, 'src');
    mkdirSync(subSrc, { recursive: true });
    seedMofloDb(workspace);
    seedMofloDb(intermediate);
    seedMofloDb(sub);
    writeFileSync(join(workspace, 'package.json'), '{}');

    expect(findProjectRoot({ cwd: subSrc, honorEnv: false })).toBe(workspace);
  });

  it('CLAUDE.md+package.json pair does NOT short-circuit past an ancestor .moflo', () => {
    // Pre-#1174 bug: rule 1c fired at the subpkg level because both CLAUDE.md
    // and package.json were present, returning the subpkg before the walk
    // ever reached the workspace's .moflo/moflo.db. The fix moves CLAUDE.md+
    // package.json into Pass B (only reached when no memory markers exist).
    const workspace = join(fixtureRoot, 'claudemd-trap');
    const subpkg = join(workspace, 'packages', 'foo');
    mkdirSync(subpkg, { recursive: true });
    seedMofloDb(workspace);
    writeFileSync(join(workspace, 'package.json'), '{}');
    writeFileSync(join(subpkg, 'package.json'), '{}');
    writeFileSync(join(subpkg, 'CLAUDE.md'), '# foo');

    expect(findProjectRoot({ cwd: subpkg, honorEnv: false })).toBe(workspace);
  });

  it('falls back to CLAUDE.md+package.json pair when no .moflo exists anywhere', () => {
    const project = join(fixtureRoot, 'pair-only');
    const sub = join(project, 'src');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(project, 'package.json'), '{}');
    writeFileSync(join(project, 'CLAUDE.md'), '# project');

    expect(findProjectRoot({ cwd: sub, honorEnv: false })).toBe(project);
  });

  it('falls back to bare package.json when no .moflo and no CLAUDE.md pair', () => {
    const project = join(fixtureRoot, 'bare');
    const sub = join(project, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(project, 'package.json'), '{}');

    expect(findProjectRoot({ cwd: sub, honorEnv: false })).toBe(project);
  });

  it('.swarm/memory.db (legacy) also anchors topmost', () => {
    const workspace = join(fixtureRoot, 'legacy-mono');
    const subpkg = join(workspace, 'pkg');
    const subSrc = join(subpkg, 'src');
    mkdirSync(subSrc, { recursive: true });
    mkdirSync(join(workspace, '.swarm'), { recursive: true });
    writeFileSync(join(workspace, '.swarm', 'memory.db'), 'SQLite format 3\0');
    mkdirSync(join(subpkg, '.swarm'), { recursive: true });
    writeFileSync(join(subpkg, '.swarm', 'memory.db'), 'SQLite format 3\0');
    writeFileSync(join(workspace, 'package.json'), '{}');
    writeFileSync(join(subpkg, 'package.json'), '{}');

    expect(findProjectRoot({ cwd: subSrc, honorEnv: false })).toBe(workspace);
  });
});
