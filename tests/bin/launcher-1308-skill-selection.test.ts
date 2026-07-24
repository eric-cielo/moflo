/**
 * End-to-end launcher test for skill-category selection (#1308).
 *
 * Why this exists as well as the unit tests: #1307 taught the lesson the hard
 * way. `writeRetainedRecord` had seven green unit tests, including one that
 * explicitly asserted the behaviour that turned out to be broken — because the
 * tests called the helper directly while the LAUNCHER only invoked it under a
 * condition the tests never reproduced. Unit-testing
 * `computeExcludedSkills` proves the set arithmetic, not that the launcher
 * actually passes it to `syncDirRecursive`.
 *
 * So this spawns the real `bin/session-start-launcher.mjs` against a temp
 * consumer and asserts what lands on disk.
 *
 * On the isolation list (vitest.config.ts) — it spawns the launcher and copies
 * the shipped skills tree, exactly the profile #1310 showed times out under
 * parallel fork contention.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { findRepoRoot } from '../../src/cli/__tests__/_helpers/repo-walk.js';
import { SKILLS_MAP, INTERNAL_SKILLS } from '../../src/cli/init/executor.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const LAUNCHER = join(REPO_ROOT, 'bin', 'session-start-launcher.mjs');

/**
 * Build a consumer fixture with a version SKEW — the launcher's §3 sync (which
 * owns the skills copy) only runs when the installed version differs from the
 * recorded stamp. A fixture without skew silently exercises nothing, which is
 * precisely how #1307's first end-to-end attempt produced a false negative.
 */
function makeConsumer(mofloYamlBody: string): string {
  const root = mkdtempSync(join(tmpdir(), 'launcher-1308-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, '.moflo'), { recursive: true });
  const pkgDir = join(root, 'node_modules', 'moflo');
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'moflo', version: '4.12.1' }));
  writeFileSync(join(pkgDir, 'bin', 'cli.js'), 'process.exit(0);\n');
  writeFileSync(join(root, '.moflo', 'moflo-version'), '4.12.0');
  cpSync(join(REPO_ROOT, '.claude', 'skills'), join(pkgDir, '.claude', 'skills'), { recursive: true });
  writeFileSync(join(root, 'moflo.yaml'), `auto_update:\n  enabled: true\n${mofloYamlBody}`);
  return root;
}

function runLauncher(cwd: string) {
  return spawnSync('node', [LAUNCHER], {
    cwd, encoding: 'utf-8', timeout: 90_000,
    env: { ...process.env, CI: '1', CLAUDE_PROJECT_DIR: cwd }, input: '',
  });
}

function installedSkills(root: string): string[] {
  const dir = join(root, '.claude', 'skills');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/**
 * Prove the launcher's §3 sync branch actually executed, rather than inferring
 * it from files that a fixture could have created itself. The launcher commits
 * the version stamp only on sync success, so a flipped stamp is unforgeable
 * evidence that the branch under test ran. Without this the suite could pass
 * against a launcher that silently skipped the whole section.
 */
function assertSyncBranchRan(root: string, res: { status: number | null; stderr: string }) {
  expect(res.status, `launcher stderr: ${res.stderr}`).toBe(0);
  expect(
    readFileSync(join(root, '.moflo', 'moflo-version'), 'utf-8').trim(),
    'version stamp did not flip — the §3 sync branch never ran, so this test proved nothing',
  ).toBe('4.12.1');
}

describe('launcher honours skills.categories (#1308)', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) { try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ } }
    root = undefined;
  });

  it('syncs only the selected categories', () => {
    root = makeConsumer('skills:\n  categories: [core]\n');

    const res = runLauncher(root);
    assertSyncBranchRan(root, res);

    const got = installedSkills(root);
    for (const s of SKILLS_MAP.core) expect(got).toContain(s);
    for (const s of SKILLS_MAP.memory) expect(got).not.toContain(s);
    for (const s of SKILLS_MAP.spells) expect(got).not.toContain(s);
    // /flo + /fl are the headline entry point and are never category-gated.
    expect(got).toContain('flo');
    expect(got).toContain('fl');
  });

  it('syncs EVERYTHING when moflo.yaml has no skills block (Rule #2)', () => {
    // The upgrade path for every existing consumer. If this ever fails, an
    // upgrade silently deletes skills from projects that never opted in.
    root = makeConsumer('');

    const res = runLauncher(root);
    assertSyncBranchRan(root, res);

    const got = installedSkills(root);
    for (const skills of Object.values(SKILLS_MAP)) {
      for (const s of skills) expect(got).toContain(s);
    }
    for (const s of INTERNAL_SKILLS) expect(got).not.toContain(s);
  });

  it('accepts block-style YAML and multiple categories', () => {
    root = makeConsumer('skills:\n  categories:\n    - core\n    - spells\n');

    const res = runLauncher(root);
    assertSyncBranchRan(root, res);

    const got = installedSkills(root);
    for (const s of SKILLS_MAP.spells) expect(got).toContain(s);
    for (const s of SKILLS_MAP.memory) expect(got).not.toContain(s);
  });
});
