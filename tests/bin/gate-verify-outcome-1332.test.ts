/**
 * System tests for #1332 — `check-before-done` gated on attendance, not outcome.
 *
 * `if (sd.verifyRun) break;` was the entire check, and `verifyRun` is set by
 * `record-verify-run` whenever the `/verify` skill is invoked. A failing verdict
 * is still a successful tool invocation, so a `/verify` returning FAIL opened
 * the gate exactly as a PASS did.
 *
 * The verdict now reaches the gate through the structured record #1328 has
 * `/verify` write to memory_store's `metadata` — never parsed out of the prose
 * `value`, which is the free-text dependency #1328 removed.
 *
 * Each test runs the real `bin/gate.cjs` as a subprocess, the same way Claude
 * Code invokes it from a hook.
 *
 * Cross-platform (Rule #1): temp roots go through `realpathSync` because macOS
 * `os.tmpdir()` is a symlink (/var -> /private/var); every path is built with
 * `join`, and the gate is spawned via execFileSync with an argv array rather
 * than a shell string, so nothing here depends on a POSIX shell.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

const BIN = resolve(__dirname, '../../bin');
const GATE = resolve(BIN, 'gate.cjs');

const PR_COMMAND = 'gh pr create --title x --body y';

let tmpDir: string;

function baseEnv(projectDir: string): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    CLAUDE_PROJECT_DIR: projectDir,
    TOOL_INPUT_command: '',
    TOOL_INPUT_file_path: '',
    TOOL_INPUT_skill: '',
    TOOL_INPUT_key: '',
    TOOL_INPUT_metadata: '',
    CLAUDE_USER_PROMPT: '',
    HOOK_SESSION_ID: '',
  };
}

function runGate(command: string, env: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [GATE, command], {
      env, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.status ?? 1 };
  }
}

function readState(projectDir: string): Record<string, unknown> {
  const stateFile = join(projectDir, '.claude', 'workflow-state.json');
  if (!existsSync(stateFile)) return {};
  return JSON.parse(readFileSync(stateFile, 'utf-8'));
}

function writeState(projectDir: string, state: Record<string, unknown>): void {
  writeFileSync(join(projectDir, '.claude', 'workflow-state.json'), JSON.stringify(state, null, 2));
}

/** A verify record shaped exactly as /verify Step 5 (#1328) writes it. */
function verifyRecord(overall: string): string {
  return JSON.stringify({
    type: 'verify-record',
    issue: '1332',
    commit: 'abc1234',
    overall,
    verifiedAt: '2026-08-03T22:00:00Z',
    criteria: [
      { id: 1, statement: 'a criterion', verdict: overall, evidence: 'a test', freshlyExecuted: true },
    ],
  });
}

/** Drive the full recorded path: /verify invoked, then its outcome stored. */
function verifyWithVerdict(projectDir: string, overall: string | null): void {
  runGate('record-verify-run', { ...baseEnv(projectDir), TOOL_INPUT_skill: 'verify' });
  if (overall !== null) {
    runGate('record-verify-outcome', {
      ...baseEnv(projectDir),
      TOOL_INPUT_key: 'verify:1332',
      TOOL_INPUT_metadata: verifyRecord(overall),
    });
  }
}

function attemptPr(projectDir: string): { stdout: string; stderr: string; exitCode: number } {
  return runGate('check-before-done', { ...baseEnv(projectDir), TOOL_INPUT_command: PR_COMMAND });
}

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-gate-1332-')));
  mkdirSync(join(tmpDir, '.claude'), { recursive: true });
  // A source file in the diff, so the docs-only exemption never short-circuits
  // the gate in these tests (that exemption has its own test below).
  writeState(tmpDir, {});
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('#1332 check-before-done gates on the verdict, not attendance', () => {
  it('a FAIL verdict leaves gh pr create BLOCKED', () => {
    verifyWithVerdict(tmpDir, 'FAIL');
    expect(readState(tmpDir).verifyRun).toBe(true); // attendance satisfied...
    expect(readState(tmpDir).verifyOutcome).toBe('FAIL');

    const res = attemptPr(tmpDir);
    expect(res.exitCode).toBe(2); // ...but the gate still blocks
    expect(res.stderr).toMatch(/returned FAIL/);
  });

  it('a PASS verdict ALLOWS gh pr create', () => {
    verifyWithVerdict(tmpDir, 'PASS');
    expect(readState(tmpDir).verifyOutcome).toBe('PASS');

    expect(attemptPr(tmpDir).exitCode).toBe(0);
  });

  it('an UNVERIFIED verdict blocks — an unproven criterion is not a pass', () => {
    verifyWithVerdict(tmpDir, 'UNVERIFIED');
    const res = attemptPr(tmpDir);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toMatch(/returned UNVERIFIED/);
  });

  it('/verify invoked but no verdict recorded blocks (the old bypass)', () => {
    // This is precisely the pre-#1332 state: verifyRun true, outcome unknown.
    verifyWithVerdict(tmpDir, null);
    expect(readState(tmpDir).verifyRun).toBe(true);

    const res = attemptPr(tmpDir);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toMatch(/recorded no verdict/);
  });

  it('never verified at all blocks', () => {
    const res = attemptPr(tmpDir);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toMatch(/has not been verified/);
  });
});

describe('#1332 the four block states are distinguishable', () => {
  it('never-verified, failed, no-verdict and invalidated produce different messages', () => {
    const messages = new Set<string>();

    // never verified
    messages.add(attemptPr(tmpDir).stderr);

    // verified, no verdict
    verifyWithVerdict(tmpDir, null);
    messages.add(attemptPr(tmpDir).stderr);

    // verified and failed
    verifyWithVerdict(tmpDir, 'FAIL');
    messages.add(attemptPr(tmpDir).stderr);

    // passed, then invalidated by a source edit
    verifyWithVerdict(tmpDir, 'PASS');
    runGate('reset-edit-gates', { ...baseEnv(tmpDir), TOOL_INPUT_file_path: 'src/cli/thing.ts' });
    const invalidated = attemptPr(tmpDir);
    messages.add(invalidated.stderr);

    expect(messages.size).toBe(4);
    expect(invalidated.stderr).toMatch(/invalidated the previous verification/);
    expect(invalidated.stderr).toMatch(/src[/\\]cli[/\\]thing\.ts/);
  });
});

describe('#1332 a stale verdict cannot survive', () => {
  it('a source edit after a PASS clears BOTH the flag and the verdict', () => {
    verifyWithVerdict(tmpDir, 'PASS');
    expect(attemptPr(tmpDir).exitCode).toBe(0);

    runGate('reset-edit-gates', { ...baseEnv(tmpDir), TOOL_INPUT_file_path: 'src/cli/thing.ts' });

    const st = readState(tmpDir);
    expect(st.verifyRun).toBe(false);
    expect(st.verifyOutcome).toBeNull();
    expect(attemptPr(tmpDir).exitCode).toBe(2);
  });

  it('re-invoking /verify clears a previous PASS, so the new run must conclude', () => {
    // Otherwise issue A's PASS would satisfy the gate for issue B the moment
    // /verify was invoked, before it had checked anything.
    verifyWithVerdict(tmpDir, 'PASS');
    runGate('record-verify-run', { ...baseEnv(tmpDir), TOOL_INPUT_skill: 'verify' });

    expect(readState(tmpDir).verifyOutcome).toBeNull();
    expect(attemptPr(tmpDir).exitCode).toBe(2);
  });

  it('a docs-only edit does not clear a PASS (inert paths stay inert)', () => {
    verifyWithVerdict(tmpDir, 'PASS');
    runGate('reset-edit-gates', { ...baseEnv(tmpDir), TOOL_INPUT_file_path: 'docs/readme.md' });

    expect(readState(tmpDir).verifyOutcome).toBe('PASS');
    expect(attemptPr(tmpDir).exitCode).toBe(0);
  });
});

describe('#1332 record-verify-outcome only trusts the structured record', () => {
  it('ignores a memory_store that is not a verify: key', () => {
    runGate('record-verify-run', { ...baseEnv(tmpDir), TOOL_INPUT_skill: 'verify' });
    runGate('record-verify-outcome', {
      ...baseEnv(tmpDir),
      TOOL_INPUT_key: 'learnings:something-else',
      TOOL_INPUT_metadata: verifyRecord('PASS'),
    });
    expect(readState(tmpDir).verifyOutcome).toBeNull();
  });

  it('ignores metadata whose type is not verify-record', () => {
    runGate('record-verify-run', { ...baseEnv(tmpDir), TOOL_INPUT_skill: 'verify' });
    runGate('record-verify-outcome', {
      ...baseEnv(tmpDir),
      TOOL_INPUT_key: 'verify:1332',
      TOOL_INPUT_metadata: JSON.stringify({ type: 'chunk', overall: 'PASS' }),
    });
    expect(readState(tmpDir).verifyOutcome).toBeNull();
  });

  it('does NOT infer a verdict from the prose value — only from metadata', () => {
    // Guards the #1328 boundary: a record whose prose says PASS but which
    // carries no structured verdict must not open the gate.
    runGate('record-verify-run', { ...baseEnv(tmpDir), TOOL_INPUT_skill: 'verify' });
    runGate('record-verify-outcome', {
      ...baseEnv(tmpDir),
      TOOL_INPUT_key: 'verify:1332',
      TOOL_INPUT_value: 'PASS — everything is fine, commit abc1234',
    });
    expect(readState(tmpDir).verifyOutcome).toBeNull();
    expect(attemptPr(tmpDir).exitCode).toBe(2);
  });

  it('survives malformed metadata JSON without throwing or crediting a pass', () => {
    runGate('record-verify-run', { ...baseEnv(tmpDir), TOOL_INPUT_skill: 'verify' });
    const res = runGate('record-verify-outcome', {
      ...baseEnv(tmpDir),
      TOOL_INPUT_key: 'verify:1332',
      TOOL_INPUT_metadata: '{ not valid json',
    });
    expect(res.exitCode).toBe(0);
    expect(readState(tmpDir).verifyOutcome).toBeNull();
  });

  it('treats an unrecognised overall as not-passing rather than crediting it', () => {
    runGate('record-verify-run', { ...baseEnv(tmpDir), TOOL_INPUT_skill: 'verify' });
    runGate('record-verify-outcome', {
      ...baseEnv(tmpDir),
      TOOL_INPUT_key: 'verify:1332',
      TOOL_INPUT_metadata: JSON.stringify({ type: 'verify-record', overall: 'probably fine' }),
    });
    expect(readState(tmpDir).verifyOutcome).toBe('UNVERIFIED');
    expect(attemptPr(tmpDir).exitCode).toBe(2);
  });

  it('accepts a lowercase overall (case-insensitive verdict)', () => {
    verifyWithVerdict(tmpDir, 'pass');
    expect(readState(tmpDir).verifyOutcome).toBe('PASS');
    expect(attemptPr(tmpDir).exitCode).toBe(0);
  });
});

describe('#1332 exemptions and opt-outs are preserved', () => {
  it('a docs-only branch diff still skips the gate entirely', () => {
    // The exemption lives above the verdict check and must stay reachable
    // without any verification at all.
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: tmpDir, stdio: 'ignore', windowsHide: true });
    };
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    writeFileSync(join(tmpDir, 'seed.txt'), 'seed\n');
    git(['add', '-A']);
    git(['commit', '-m', 'seed']);
    git(['checkout', '-b', 'docs-branch']);
    writeFileSync(join(tmpDir, 'README.md'), '# docs only\n');
    git(['add', '-A']);
    git(['commit', '-m', 'docs']);

    const res = attemptPr(tmpDir);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/skipping verify-before-done gate/);
  });

  it('gates.verify_before_done: false disables the gate even on a FAIL', () => {
    writeFileSync(join(tmpDir, 'moflo.yaml'), 'gates:\n  verify_before_done: false\n');
    verifyWithVerdict(tmpDir, 'FAIL');
    expect(attemptPr(tmpDir).exitCode).toBe(0);
  });
});
