/**
 * Gate snapshot + baseline-TRIVIAL skip — bin/gate.cjs
 *
 * Covers two cost-control paths added on top of issue #908:
 *
 *   1. Snapshot path — when /simplify ran earlier on this branch, gate.cjs
 *      stamps `simplifySnapshotSha = HEAD`. On `gh pr create`, if the diff
 *      between the snapshot and current HEAD classifies TRIVIAL, the gate
 *      auto-passes the simplify check without forcing a /simplify re-run.
 *
 *   2. Baseline path — first time on a branch, no snapshot. If the entire
 *      branch diff (merge-base...HEAD) classifies TRIVIAL, the gate auto-passes
 *      without ever invoking /simplify (typo-only PRs, etc.).
 *
 * Each test uses a real on-disk git repo so gate.cjs's git-rev-parse and
 * git-diff calls produce a real diff for the classifier to see.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

const BIN = resolve(__dirname, '../../bin');
const GATE = resolve(BIN, 'gate.cjs');
const CLASSIFIER = resolve(BIN, 'simplify-classify.cjs');

let tmpDir: string;

function makeTmpRepo(): string {
  const dir = resolve(tmpdir(), `moflo-gate-snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  // Co-locate the classifier next to gate.cjs's expected lookup path —
  // gate.cjs does `require('./simplify-classify.cjs')`, which resolves
  // relative to the gate.cjs file itself, not the project dir. So no copy
  // needed: we always run gate.cjs from BIN so its sibling classifier loads.
  // Initialise a real git repo so merge-base/diff calls have something to read.
  execSync('git init -q -b main', { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  // Seed an initial commit so HEAD exists and merge-base resolves.
  writeFileSync(join(dir, 'src.ts'), 'export const X = 1;\n');
  execSync('git add -A', { cwd: dir });
  execSync('git commit -q -m "init"', { cwd: dir });
  return dir;
}

function baseEnv(projectDir: string): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    CLAUDE_PROJECT_DIR: projectDir,
    TOOL_INPUT_command: '',
    TOOL_INPUT_pattern: '',
    TOOL_INPUT_path: '',
    TOOL_INPUT_file_path: '',
    TOOL_INPUT_skill: '',
    CLAUDE_USER_PROMPT: '',
    HOOK_SESSION_ID: '',
  };
}

function runGate(command: string, env: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [GATE, command], {
      env, encoding: 'utf-8', timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status ?? 1,
    };
  }
}

function readState(projectDir: string): Record<string, unknown> {
  const stateFile = join(projectDir, '.claude', 'workflow-state.json');
  if (!existsSync(stateFile)) return {};
  return JSON.parse(readFileSync(stateFile, 'utf-8'));
}

function writeState(projectDir: string, state: Record<string, unknown>): void {
  const stateFile = join(projectDir, '.claude', 'workflow-state.json');
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

beforeEach(() => {
  tmpDir = makeTmpRepo();
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('gate snapshot — record-skill-run captures HEAD SHA', () => {
  it('stamps simplifySnapshotSha when /simplify runs', () => {
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_skill = 'simplify';
    runGate('record-skill-run', env);
    const s = readState(tmpDir) as any;
    expect(s.simplifyRun).toBe(true);
    expect(typeof s.simplifySnapshotSha).toBe('string');
    expect(s.simplifySnapshotSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('updates the snapshot SHA on subsequent /simplify runs', () => {
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_skill = 'simplify';
    runGate('record-skill-run', env);
    const sha1 = (readState(tmpDir) as any).simplifySnapshotSha;
    // Make a new commit so HEAD advances, then record again
    writeFileSync(join(tmpDir, 'src.ts'), 'export const X = 2;\n');
    execSync('git add -A && git commit -q -m "advance"', { cwd: tmpDir });
    runGate('record-skill-run', env);
    const sha2 = (readState(tmpDir) as any).simplifySnapshotSha;
    expect(sha2).not.toBe(sha1);
    expect(sha2).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('gate snapshot path — TRIVIAL delta-since-simplify auto-passes', () => {
  it('a tiny edit after /simplify does not block gh pr create', () => {
    const env = baseEnv(tmpDir);
    // /simplify ran on prior HEAD
    env.TOOL_INPUT_skill = 'simplify';
    runGate('record-skill-run', env);
    // simplifyRun is now true. Simulate the post-edit reset that would
    // normally fire (edit-reset-gates flips simplifyRun back to false).
    const s = readState(tmpDir) as any;
    s.simplifyRun = false;
    s.testsRun = true;
    s.learningsStored = true;
    writeState(tmpDir, s);

    // Make a 2-line trivial edit and commit it
    writeFileSync(join(tmpDir, 'src.ts'), 'export const X = 1;\n// fix typo in comment\n');
    execSync('git add -A && git commit -q -m "typo"', { cwd: tmpDir });

    // gh pr create — should auto-pass via snapshot classifier
    env.TOOL_INPUT_command = 'gh pr create --title "fix typo"';
    const r = runGate('check-before-pr', env);
    expect(r.exitCode, `expected pass, stderr=${r.stderr} stdout=${r.stdout}`).toBe(0);
    expect(r.stdout).toMatch(/auto-passed/i);

    // simplifyRun re-stamped silently
    expect((readState(tmpDir) as any).simplifyRun).toBe(true);
  });

  it('a substantial edit after /simplify still blocks gh pr create', () => {
    const env = baseEnv(tmpDir);
    // Branch off so merge-base != HEAD — otherwise the baseline-classifier
    // path sees an empty branch diff (HEAD == main) and would auto-pass for
    // the wrong reason. Mirrors how PRs actually work.
    execSync('git checkout -q -b feature', { cwd: tmpDir });

    env.TOOL_INPUT_skill = 'simplify';
    runGate('record-skill-run', env);
    const s = readState(tmpDir) as any;
    s.simplifyRun = false;
    s.testsRun = true;
    s.learningsStored = true;
    writeState(tmpDir, s);

    // Real new function (not trivial — should classify SMALL, gate must NOT
    // auto-pass since gate only auto-passes on TRIVIAL).
    const big = 'export function bigNewFn() {\n' + Array(40).fill('  console.log("x");').join('\n') + '\n}\n';
    writeFileSync(join(tmpDir, 'src.ts'), 'export const X = 1;\n' + big);
    execSync('git add -A && git commit -q -m "new fn"', { cwd: tmpDir });

    env.TOOL_INPUT_command = 'gh pr create --title "feat"';
    const r = runGate('check-before-pr', env);
    expect(r.exitCode, 'non-trivial delta should still block').toBe(2);
    expect(r.stderr).toContain('/flo-simplify has not run');
  });
});

describe('gate baseline path — TRIVIAL whole-branch diff auto-passes', () => {
  // The whole-branch baseline path runs when there is NO snapshot (first time
  // on a branch, no /simplify run yet). If the entire branch diff vs main
  // classifies TRIVIAL, /simplify would provide ~zero value, so skip it.
  it('a typo-only branch (no /simplify run) does not block gh pr create', () => {
    const env = baseEnv(tmpDir);
    // Branch off main with one tiny edit
    execSync('git checkout -q -b feature', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'src.ts'), 'export const X = 1; // typo: fixed\n');
    execSync('git add -A && git commit -q -m "typo"', { cwd: tmpDir });

    // No /simplify ever ran — testsRun true, learningsStored true, simplifyRun false
    writeState(tmpDir, { testsRun: true, simplifyRun: false, learningsStored: true });

    env.TOOL_INPUT_command = 'gh pr create --title "typo"';
    const r = runGate('check-before-pr', env);
    expect(r.exitCode, `expected pass, stderr=${r.stderr} stdout=${r.stdout}`).toBe(0);
    expect(r.stdout).toMatch(/auto-passed.*branch diff is TRIVIAL/i);
  });

  it('a non-trivial branch (no /simplify run) still blocks gh pr create', () => {
    const env = baseEnv(tmpDir);
    execSync('git checkout -q -b feature', { cwd: tmpDir });
    // Real new code, not a typo
    const big = 'export function bigNewFn() {\n' + Array(40).fill('  console.log("x");').join('\n') + '\n}\n';
    writeFileSync(join(tmpDir, 'src.ts'), 'export const X = 1;\n' + big);
    execSync('git add -A && git commit -q -m "feat"', { cwd: tmpDir });

    writeState(tmpDir, { testsRun: true, simplifyRun: false, learningsStored: true });
    env.TOOL_INPUT_command = 'gh pr create --title "feat"';
    const r = runGate('check-before-pr', env);
    expect(r.exitCode, 'non-trivial branch should block').toBe(2);
    expect(r.stderr).toContain('/flo-simplify has not run');
  });
});

describe('classifier sanity for the gate path', () => {
  // Belt-and-suspenders: gate.cjs requires('./simplify-classify.cjs') — make
  // sure that resolution actually returns a usable classifyDiff function.
  it('the bundled classifier is loadable and TRIVIAL for tiny diffs', () => {
    const classifier = require(CLASSIFIER);
    expect(typeof classifier.classifyDiff).toBe('function');
    const diff = `diff --git a/src.ts b/src.ts
--- a/src.ts
+++ b/src.ts
@@ -1 +1 @@
-export const X = 1;
+export const X = 2;
`;
    const dec = classifier.classifyDiff(diff);
    expect(dec.tier).toBe('TRIVIAL');
  });
});
