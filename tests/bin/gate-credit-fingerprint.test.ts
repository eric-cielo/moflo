/**
 * Gate credit is content-addressed, not observation-based.
 *
 * `testsRun` / `simplifyRun` / `verifyRun` used to be plain booleans cleared by
 * `reset-edit-gates`, which fires PostToolUse on `^(Write|Edit|MultiEdit)$`.
 * That equates "credit is still valid" with "no edit was observed", which only
 * holds if every mutation flows through those three tools. It does not:
 *
 *   - `node -e` with fs.writeFileSync, `sed -i`, `cp`, shell redirection
 *   - every git operation that moves the tree: checkout, pull, merge, rebase
 *   - simply moving to the next change in the same session (nothing is
 *     per-prompt; `learningsStored` is session-scoped by explicit design)
 *
 * Reproduced before the fix: earn full credit, append an `execSync` call to a
 * source file via Bash, commit — and `check-before-pr` exited 0, allowing the
 * PR with no re-test, no re-review, no re-verify.
 *
 * Each credit is now pinned to a fingerprint of the code it describes (HEAD plus
 * the content of every changed/untracked file), recomputed at check time. These
 * tests drive gate.cjs as a subprocess exactly as the hooks do, so they exercise
 * the real recorder → checker path rather than a reimplementation of it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');
const GATE = resolve(REPO_ROOT, 'bin/gate.cjs');

let root: string;

/** Run gate.cjs the way the hook bridge does: command + TOOL_INPUT_* env. */
function gate(cmd: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [GATE, cmd], {
    cwd: root,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function git(...args: string[]) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf-8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function readStateFile() {
  return JSON.parse(readFileSync(join(root, '.claude', 'workflow-state.json'), 'utf-8'));
}

function writeStateFile(patch: Record<string, unknown>) {
  const p = join(root, '.claude', 'workflow-state.json');
  const cur = JSON.parse(readFileSync(p, 'utf-8'));
  writeFileSync(p, JSON.stringify({ ...cur, ...patch }, null, 2));
}

/** Earn every PR-gate credit legitimately, through the real recorders. */
function earnFullCredit() {
  gate('record-skill-run', { TOOL_INPUT_skill: 'flo-simplify' });
  gate('record-test-run', {
    TOOL_INPUT_command: 'npm test',
    TOOL_RESPONSE_stdout: 'Test Files 3 passed (3)\nTests 42 passed (42)',
  });
  gate('record-skill-run', { TOOL_INPUT_skill: 'verify' });
  gate('record-verify-run', { TOOL_INPUT_skill: 'verify' });
  writeStateFile({ learningsStored: true, verifyOutcome: 'PASS' });
}

const PR_CMD = { TOOL_INPUT_command: 'gh pr create --title x --body y' };

beforeEach(() => {
  // Deliberately NOT under os.tmpdir(): isEphemeralPath exempts tmp-rooted
  // projects from gate resets (#1348), which would mask what these assert.
  root = resolve(REPO_ROOT, '.testoutput', `gate-fp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fp-test', version: '0.0.0' }));
  writeFileSync(join(root, 'src.js'), 'export const safe = 1;\n');
  git('init', '-q', '.');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'init');
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows may hold handles — non-fatal */
  }
});

describe('gate credit is pinned to the code it describes', () => {
  it('passes when nothing changed since the credits were earned', () => {
    earnFullCredit();
    const r = gate('check-before-pr', PR_CMD);
    expect(r.stderr).not.toContain('BLOCKED');
    expect(r.status).toBe(0);
  });

  it('blocks after a source write made outside Write/Edit (the original bypass)', () => {
    earnFullCredit();
    // The mutation reset-edit-gates structurally cannot see.
    appendFileSync(join(root, 'src.js'), 'export const evil = 2;\n');

    const r = gate('check-before-pr', PR_CMD);
    expect(r.stderr).toContain('BLOCKED');
    expect(r.stderr).toContain('the code changed since they ran');
    expect(r.status).toBe(2);
  });

  it('blocks after the change is committed, too — HEAD is part of the fingerprint', () => {
    earnFullCredit();
    appendFileSync(join(root, 'src.js'), 'export const evil = 2;\n');
    git('add', '-A');
    git('commit', '-qm', 'bash-written change');

    const r = gate('check-before-pr', PR_CMD);
    expect(r.stderr).toContain('BLOCKED');
    expect(r.status).toBe(2);
  });

  it('blocks after a branch switch moves the tree', () => {
    git('checkout', '-q', '-b', 'other');
    appendFileSync(join(root, 'src.js'), 'export const other = 3;\n');
    git('add', '-A');
    git('commit', '-qm', 'other work');
    git('checkout', '-q', '-');
    git('checkout', '-q', '-b', 'feature');
    earnFullCredit();
    // Credit earned on `feature`; now the tree moves underneath it.
    git('merge', '-q', 'other', '-m', 'merge other');

    const r = gate('check-before-pr', PR_CMD);
    expect(r.stderr).toContain('BLOCKED');
    expect(r.status).toBe(2);
  });

  it('blocks a brand-new untracked source file', () => {
    earnFullCredit();
    writeFileSync(join(root, 'sneaky.js'), 'export const sneaky = 4;\n');

    const r = gate('check-before-pr', PR_CMD);
    expect(r.stderr).toContain('BLOCKED');
    expect(r.status).toBe(2);
  });

  it('does NOT block on an inert-file edit — markdown never invalidated a run (#1176)', () => {
    earnFullCredit();
    writeFileSync(join(root, 'README.md'), '# docs change\n');

    const r = gate('check-before-pr', PR_CMD);
    expect(r.stderr).not.toContain('BLOCKED');
    expect(r.status).toBe(0);
  });

  it('does NOT block simplify on a test-only edit, preserving #908', () => {
    earnFullCredit();
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'tests', 'a.test.js'), 'it("x", () => {});\n');

    const r = gate('check-before-pr', PR_CMD);
    // The testing gate SHOULD go stale (test code changed) while the simplify
    // review of production code stands — the exact split #908 intended.
    expect(r.stderr).toContain('tests have not run green');
    expect(r.stderr).not.toContain('/flo-simplify (or /distill) has not run');
  });

  it('treats credit with no recorded fingerprint as stale (pre-upgrade state)', () => {
    earnFullCredit();
    // Exactly what an older gate left behind: flags set, no fingerprints.
    writeStateFile({ testsFingerprint: null, simplifyFingerprint: null, verifyFingerprint: null });

    const r = gate('check-before-pr', PR_CMD);
    expect(r.stderr).toContain('BLOCKED');
    expect(r.status).toBe(2);
  });

  it('clears the stale flags in state, so the block is not re-derived every call', () => {
    earnFullCredit();
    appendFileSync(join(root, 'src.js'), 'export const evil = 2;\n');
    gate('check-before-pr', PR_CMD);

    const s = readStateFile();
    expect(s.testsRun).toBe(false);
    expect(s.testsFingerprint).toBeNull();
  });

  it('re-earning credit on the changed code passes again', () => {
    earnFullCredit();
    appendFileSync(join(root, 'src.js'), 'export const evil = 2;\n');
    expect(gate('check-before-pr', PR_CMD).stderr).toContain('BLOCKED');

    earnFullCredit(); // re-run tests / simplify / verify against the new tree

    const r = gate('check-before-pr', PR_CMD);
    expect(r.stderr).not.toContain('BLOCKED');
    expect(r.status).toBe(0);
  });

  it('expires a PASS verdict at check-before-done when the code moved', () => {
    earnFullCredit();
    expect(gate('check-before-done', PR_CMD).status).toBe(0);

    appendFileSync(join(root, 'src.js'), 'export const evil = 2;\n');

    const r = gate('check-before-done', PR_CMD);
    expect(r.stderr).toContain('BLOCKED');
    expect(r.stderr).toContain('the code changed since /verify ran');
  });

  it('does not count its own state file — recording credit must not invalidate it', () => {
    // These fixtures have no .gitignore, so `.claude/workflow-state.json` is an
    // untracked file inside the repo. If it contributed to the fingerprint,
    // writing a credit would change the fingerprint that credit is pinned to and
    // every credit would be stale the instant it was earned — an unsatisfiable
    // gate. moflo's own repo ignores that path, so this only ever surfaced in a
    // consumer that does not, which is precisely why the exclusion is by name
    // rather than delegated to .gitignore.
    earnFullCredit();
    const before = readStateFile();
    expect(before.testsFingerprint).toBeTruthy();

    // Touch state again the way any later recorder would.
    gate('record-test-run', {
      TOOL_INPUT_command: 'npm test',
      TOOL_RESPONSE_stdout: 'Tests 42 passed (42)',
    });

    const r = gate('check-before-pr', PR_CMD);
    expect(r.stderr).not.toContain('BLOCKED');
    expect(readStateFile().testsFingerprint).toBe(before.testsFingerprint);
  });

  it('falls back to flag-only outside a git repo, rather than blocking work it cannot reason about', () => {
    rmSync(join(root, '.git'), { recursive: true, force: true });
    earnFullCredit();

    const r = gate('check-before-pr', PR_CMD);
    expect(r.stderr).not.toContain('BLOCKED');
    expect(r.status).toBe(0);
  });
});
