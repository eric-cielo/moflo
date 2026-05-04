/**
 * System tests for issue #908 — gate-scope split.
 *
 * Each test runs the *real* gate.cjs as a subprocess (the same way Claude Code
 * invokes it via PostToolUse / PreToolUse hooks) and asserts on:
 *   - whether `gh pr create` is blocked or allowed afterwards (exit code 2 vs 0)
 *   - which gate flags actually flipped in workflow-state.json
 *   - whether the blocked message lists the file that tripped the reset
 *
 * The test exercises the full lifecycle that #908 cares about:
 *   record-skill-run → reset-edit-gates(test file) → check-before-pr
 *
 * Acceptance criteria from the issue:
 *   - Editing only test files after /simplify does NOT block gh pr create
 *   - Editing only .md files after /simplify does NOT block
 *   - Editing src/** after /simplify DOES still block until simplify reruns
 *   - The gate's blocked message lists the file(s) that tripped it
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

const BIN = resolve(__dirname, '../../bin');
const GATE = resolve(BIN, 'gate.cjs');

let tmpDir: string;

function makeTmpProject(): string {
  const dir = resolve(tmpdir(), `moflo-gate-908-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(dir, '.claude'), { recursive: true });
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
  tmpDir = makeTmpProject();
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('#908 gate scope — test-file edits do not retrip /simplify', () => {
  describe('end-to-end: simplify → edit → check-before-pr', () => {
    it('test-file edit after /simplify keeps simplifyRun true; PR not blocked on simplify', () => {
      const env = baseEnv(tmpDir);

      // 1) /simplify ran, tests ran, learnings stored — fully green
      writeState(tmpDir, {
        testsRun: true, simplifyRun: true, learningsStored: true,
      });

      // 2) User edits a test file (PostToolUse: reset-edit-gates fires)
      env.TOOL_INPUT_file_path = '/project/tests/bin/foo.test.ts';
      runGate('reset-edit-gates', env);

      const after = readState(tmpDir);
      expect(after.simplifyRun, 'test edit must NOT reset simplifyRun').toBe(true);
      expect(after.testsRun, 'test edit MUST reset testsRun').toBe(false);

      // 3) Re-run tests
      writeState(tmpDir, { ...after, testsRun: true });

      // 4) Try gh pr create — should NOT block (only simplify gate matters here)
      env.TOOL_INPUT_command = 'gh pr create --title "fix"';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode, `should not block, but got: ${r.stderr}`).toBe(0);
    });

    it('source-file edit after /simplify resets simplifyRun; PR blocked', () => {
      const env = baseEnv(tmpDir);

      writeState(tmpDir, {
        testsRun: true, simplifyRun: true, learningsStored: true,
      });

      env.TOOL_INPUT_file_path = '/project/src/cli/foo.ts';
      runGate('reset-edit-gates', env);

      const after = readState(tmpDir);
      expect(after.simplifyRun).toBe(false);
      expect(after.testsRun).toBe(false);

      // Re-run tests but not simplify — PR should still block on simplify
      writeState(tmpDir, { ...after, testsRun: true });
      env.TOOL_INPUT_command = 'gh pr create --title "fix"';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('/simplify has not run');
    });

    it('blocked message lists the file that tripped the reset', () => {
      const env = baseEnv(tmpDir);
      writeState(tmpDir, {
        testsRun: true, simplifyRun: true, learningsStored: true,
      });

      const offendingFile = '/project/src/cli/launcher.ts';
      env.TOOL_INPUT_file_path = offendingFile;
      runGate('reset-edit-gates', env);

      env.TOOL_INPUT_command = 'gh pr create --title "fix"';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('Last gate reset:');
      expect(r.stderr).toContain(offendingFile);
      expect(r.stderr).toMatch(/\(.*simplify.*\)|\(.*tests.*\)/);
    });

    it('markdown edit after /simplify keeps both gates; PR not blocked', () => {
      const env = baseEnv(tmpDir);
      writeState(tmpDir, {
        testsRun: true, simplifyRun: true, learningsStored: true,
      });

      env.TOOL_INPUT_file_path = '/project/docs/CHANGELOG.md';
      runGate('reset-edit-gates', env);

      const after = readState(tmpDir);
      expect(after.testsRun).toBe(true);
      expect(after.simplifyRun).toBe(true);

      env.TOOL_INPUT_command = 'gh pr create --title "docs"';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(0);
    });
  });

  describe('test-file path detection coverage', () => {
    const TEST_PATHS = [
      '/project/tests/bin/foo.test.ts',
      '/project/src/__tests__/bar.test.ts',
      '/project/src/foo.test.ts',
      '/project/src/foo.spec.ts',
      '/project/src/foo.test.tsx',
      '/project/src/foo.spec.mjs',
      '/project/src/foo.test.cjs',
      '/project/spec/integration.ts',
      '/project/cypress/e2e/foo.cy.ts',
      '/project/e2e/login.ts',
      '/project/test/legacy.ts',
      '/project/__tests__/whatever.ts',
      '/project/__mocks__/fs.ts',
      '/project/fixtures/sample.json',
      '/project/src/foo.fixture.ts',
      // Windows-style paths
      'C:\\project\\tests\\bin\\foo.test.ts',
      'C:\\project\\src\\__tests__\\bar.ts',
    ];

    for (const tp of TEST_PATHS) {
      it(`preserves simplifyRun for test path: ${tp}`, () => {
        writeState(tmpDir, { testsRun: true, simplifyRun: true });
        const env = baseEnv(tmpDir);
        env.TOOL_INPUT_file_path = tp;
        runGate('reset-edit-gates', env);
        const s = readState(tmpDir);
        expect(s.simplifyRun, `simplifyRun should be preserved for ${tp}`).toBe(true);
      });
    }

    const SOURCE_PATHS = [
      '/project/src/cli/foo.ts',
      '/project/src/index.ts',
      '/project/bin/gate.cjs',
      '/project/scripts/build.mjs',
      '/project/harness/runner.ts',
    ];

    for (const sp of SOURCE_PATHS) {
      it(`resets simplifyRun for source path: ${sp}`, () => {
        writeState(tmpDir, { testsRun: true, simplifyRun: true });
        const env = baseEnv(tmpDir);
        env.TOOL_INPUT_file_path = sp;
        runGate('reset-edit-gates', env);
        const s = readState(tmpDir);
        expect(s.simplifyRun, `simplifyRun SHOULD reset for ${sp}`).toBe(false);
      });
    }
  });

  describe('lastResetBy tracking', () => {
    it('records which gates were reset, not just the file', () => {
      writeState(tmpDir, { testsRun: true, simplifyRun: true });
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_file_path = '/project/src/foo.ts';
      runGate('reset-edit-gates', env);
      const s = readState(tmpDir) as any;
      expect(s.lastResetBy).toBeDefined();
      expect(s.lastResetBy.file).toBe('/project/src/foo.ts');
      expect(s.lastResetBy.gates).toEqual(expect.arrayContaining(['tests', 'simplify']));
    });

    it('records only tests gate when test-file edit resets only testsRun', () => {
      writeState(tmpDir, { testsRun: true, simplifyRun: true });
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_file_path = '/project/tests/foo.test.ts';
      runGate('reset-edit-gates', env);
      const s = readState(tmpDir) as any;
      expect(s.lastResetBy.gates).toEqual(['tests']);
      expect(s.simplifyRun).toBe(true);
    });

    it('does not record lastResetBy for inert markdown edits', () => {
      writeState(tmpDir, { testsRun: true, simplifyRun: true });
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_file_path = '/project/README.md';
      runGate('reset-edit-gates', env);
      const s = readState(tmpDir) as any;
      // No reset happened, no lastResetBy recorded
      expect(s.lastResetBy).toBeUndefined();
    });
  });
});
