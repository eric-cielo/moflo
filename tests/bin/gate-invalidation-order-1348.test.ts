/**
 * System tests for #1348 — the pre-PR gates invalidated each other.
 *
 * Reported symptom: `/flo-simplify` then `gh pr create` blocked on verify;
 * `/verify` then `gh pr create` blocked on simplify *again*; and re-running
 * `/verify` to recover left `verifyOutcome` null, because re-invoking it clears
 * any prior verdict by design (#1332). Every individual block was correct, so
 * the loop was invisible from any single message — the reporter escaped it only
 * by discovering an undocumented ordering.
 *
 * Two mechanisms produced it, and both are pinned here:
 *
 *   1. `reset-edit-gates` counted ANY Write/Edit as a code edit, including a
 *      scratch probe under the OS temp dir that can never reach the branch diff.
 *      A `/verify` run that jotted one cleared the `/flo-simplify` stamp.
 *   2. `record-verify-outcome` wrote a verdict without checking that the run was
 *      still live, so a store arriving after an edit-reset produced the
 *      self-contradictory `verifyRun:false, verifyOutcome:'PASS'`.
 *
 * The third assertion class is the messages: a block now names the working
 * ORDER, not only the gate that happens to be missing.
 *
 * Each test runs the real `bin/gate.cjs` as a subprocess, the way a hook does.
 *
 * Cross-platform (Rule #1): temp roots go through `realpathSync` (macOS
 * /var -> /private/var), every path is built with `join`, and the gate is
 * spawned via an argv array rather than a shell string.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

import { generateGateScript } from '../../src/cli/init/helpers-generator.js';

const GATE = resolve(__dirname, '../../bin/gate.cjs');
const PR_COMMAND = 'gh pr create --title x --body y';

let tmpDir: string;

function baseEnv(projectDir: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
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

/**
 * spawnSync rather than execFileSync: the recorder crumbs this file asserts on
 * are written to stderr while exiting 0, and an exec helper that only captures
 * stderr from the throw path would report them as absent.
 */
function runGate(command: string, env: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync('node', [GATE, command], {
    env, encoding: 'utf-8', timeout: 30000, windowsHide: true,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 };
}

function readState(projectDir: string): Record<string, unknown> {
  const f = join(projectDir, '.claude', 'workflow-state.json');
  if (!existsSync(f)) return {};
  return JSON.parse(readFileSync(f, 'utf-8'));
}

function writeState(projectDir: string, state: Record<string, unknown>): void {
  writeFileSync(join(projectDir, '.claude', 'workflow-state.json'), JSON.stringify(state, null, 2));
}

/** A verify record shaped exactly as /verify Step 5 (#1328) writes it. */
function verifyRecord(overall: string): string {
  return JSON.stringify({
    type: 'verify-record',
    issue: '1348',
    commit: 'abc1234',
    overall,
    verifiedAt: '2026-08-04T00:00:00Z',
    criteria: [{ id: 1, statement: 'a criterion', verdict: overall, evidence: 'a test', freshlyExecuted: true }],
  });
}

/** All three edit-resettable gates satisfied — the state just before `gh pr create`. */
const READY = { testsRun: true, simplifyRun: true, learningsStored: true, verifyRun: true, verifyOutcome: 'PASS' };

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-gate-1348-')));
  mkdirSync(join(tmpDir, '.claude'), { recursive: true });
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('#1348 a write that cannot reach the branch diff does not reset a gate', () => {
  it('a scratchpad write under the OS temp dir leaves every gate standing', () => {
    writeState(tmpDir, READY);
    const env = baseEnv(tmpDir);
    // The real shape: <tmpdir>/claude-<uid>/<project-slug>/<session>/scratchpad/probe.mjs
    env.TOOL_INPUT_file_path = join(tmpdir(), 'claude-1000', 'proj', 'sess', 'scratchpad', 'probe.mjs');
    runGate('reset-edit-gates', env);

    expect(readState(tmpDir)).toMatchObject(READY);
  });

  it('a .moflo/ write leaves every gate standing — it is gitignored state', () => {
    writeState(tmpDir, READY);
    const env = baseEnv(tmpDir);
    // Deliberately NOT `specs/plan.md`: markdown is already inert by extension,
    // so that path would pass whether or not `.moflo/` is recognised. Use the
    // persisted task state — a real .moflo file with a resetting extension.
    env.TOOL_INPUT_file_path = join('project', '.moflo', 'tasks', 'state.json');
    runGate('reset-edit-gates', env);

    expect(readState(tmpDir)).toMatchObject(READY);
  });

  it('the same file outside .moflo/ does reset — proving the path is what is read', () => {
    writeState(tmpDir, READY);
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = join('project', 'tasks', 'state.json');
    runGate('reset-edit-gates', env);

    expect(readState(tmpDir).testsRun).toBe(false);
  });

  it('a real source edit still resets tests, simplify AND verify', () => {
    // The counterweight: the skips above must not have widened into "nothing
    // resets". Without this, #1348's fix would silently disable the gates.
    writeState(tmpDir, READY);
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = join('project', 'src', 'cli', 'thing.ts');
    runGate('reset-edit-gates', env);

    const s = readState(tmpDir);
    expect(s.testsRun).toBe(false);
    expect(s.simplifyRun).toBe(false);
    expect(s.verifyRun).toBe(false);
    expect(s.verifyOutcome).toBeNull();
  });

  it('a tmp-rooted project has its own source edits skipped too — the known scope limit', () => {
    // Not the behaviour you would design from scratch: the skip is tmp-scoped,
    // so a project that itself lives under os.tmpdir() (test fixtures, some CI
    // checkouts) gets its real source edits skipped as well. Pinned rather than
    // hidden, because it is the price of reusing isEphemeralPath instead of
    // project-root containment — see the scope note in bin/gate.cjs. Acceptable
    // because it errs toward resetting less, and consumer projects are not in
    // tmp; if that ever stops being true, containment is the fix.
    writeState(tmpDir, READY);
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = join(tmpDir, 'src', 'thing.ts');
    runGate('reset-edit-gates', env);

    expect(readState(tmpDir)).toMatchObject(READY);
  });
});

describe('#1348 a verdict is refused once its run has been invalidated', () => {
  it('does not record a PASS that arrives after a code edit cleared verifyRun', () => {
    writeState(tmpDir, { verifyRun: false, verifyOutcome: null });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_key = 'verify:1348';
    env.TOOL_INPUT_metadata = verifyRecord('PASS');
    const r = runGate('record-verify-outcome', env);

    const s = readState(tmpDir);
    expect(s.verifyOutcome).toBeNull();
    // The state combination this prevents — verifyRun false with a PASS beside
    // it — has no branch in check-before-done's message chain, so it surfaces as
    // "a code edit invalidated the previous verification" while a PASS sits in
    // state, which reads as a gate bug rather than as the stale verdict it is.
    expect(s.verifyRun).toBe(false);
    expect(r.stderr).toContain('arrived after a code edit invalidated the run');
  });

  it('still records the verdict for a live run', () => {
    writeState(tmpDir, { verifyRun: true, verifyOutcome: null });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_key = 'verify:1348';
    env.TOOL_INPUT_metadata = verifyRecord('PASS');
    runGate('record-verify-outcome', env);

    expect(readState(tmpDir).verifyOutcome).toBe('PASS');
  });

  it('records a FAIL for a live run — refusal keys on liveness, not on verdict', () => {
    writeState(tmpDir, { verifyRun: true, verifyOutcome: null });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_key = 'verify:1348';
    env.TOOL_INPUT_metadata = verifyRecord('FAIL');
    runGate('record-verify-outcome', env);

    expect(readState(tmpDir).verifyOutcome).toBe('FAIL');
  });
});

describe('#1348 a block names the order, not just the missing gate', () => {
  it('check-before-pr prints the working order', () => {
    writeState(tmpDir, { testsRun: false, simplifyRun: false, learningsStored: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = PR_COMMAND;
    const r = runGate('check-before-pr', env);

    expect(r.exitCode).toBe(2);
    // Read the ordering off the hint LINE, not off the whole stderr: the
    // missing-gate list above it already mentions /flo-simplify, so a
    // whole-buffer indexOf comparison would pass without the hint saying
    // anything about order at all.
    const hint = r.stderr.split('\n').find((l) => l.includes('Order that satisfies all of them'));
    expect(hint).toBeDefined();
    // Simplify strictly precedes verify: /flo-simplify may edit code (which
    // resets verify), and /verify must not. An order that put them the other way
    // round is the loop this ticket is about.
    expect(hint!.indexOf('/flo-simplify')).toBeGreaterThanOrEqual(0);
    expect(hint!.indexOf('/flo-simplify')).toBeLessThan(hint!.indexOf('/verify'));
  });

  it('check-before-done prints the order and warns that re-running clears the verdict', () => {
    // The "ran but no verdict" state, whose obvious recovery — re-run /verify —
    // clears the verdict again and lands right back here (#1332 by design).
    writeState(tmpDir, { verifyRun: true, verifyOutcome: null });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = PR_COMMAND;
    const r = runGate('check-before-done', env);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('recorded no verdict');
    expect(r.stderr).toContain('Re-invoking /verify clears the prior verdict');
    expect(r.stderr).toContain('Order that satisfies all of them');
  });
});

describe('#1348 the reported loop no longer happens', () => {
  it('simplify, then a verify run that writes a scratch probe, opens the PR', () => {
    const env = baseEnv(tmpDir);
    writeState(tmpDir, { testsRun: true, learningsStored: true });

    // /flo-simplify
    runGate('record-skill-run', { ...env, TOOL_INPUT_skill: 'flo-simplify' });
    // /verify — invocation clears any prior verdict (#1332)
    runGate('record-verify-run', { ...env, TOOL_INPUT_skill: 'verify' });
    // ...and jots a probe into the scratchpad while checking a criterion. This
    // is the step that used to clear simplifyRun, testsRun and verifyRun.
    runGate('reset-edit-gates', {
      ...env,
      TOOL_INPUT_file_path: join(tmpdir(), 'claude-1000', 'proj', 'sess', 'scratchpad', 'check.mjs'),
    });
    // /verify Step 5 stores the structured verdict
    runGate('record-verify-outcome', { ...env, TOOL_INPUT_key: 'verify:1348', TOOL_INPUT_metadata: verifyRecord('PASS') });
    runGate('record-learnings-stored', env);

    const beforePr = readState(tmpDir);
    expect(beforePr.simplifyRun).toBe(true);
    expect(beforePr.verifyRun).toBe(true);
    expect(beforePr.verifyOutcome).toBe('PASS');

    expect(runGate('check-before-pr', { ...env, TOOL_INPUT_command: PR_COMMAND }).exitCode).toBe(0);
    expect(runGate('check-before-done', { ...env, TOOL_INPUT_command: PR_COMMAND }).exitCode).toBe(0);
  });
});

describe('#1348 the generated gate carries the same fixes', () => {
  // This block used to re-assert each #1348 invariant against
  // generateGateScript()'s output, because that fallback template was a
  // hand-maintained COPY of the gate and had drifted — it never consulted
  // EDIT_RESET_SKIP_PATH_RE at all, so the fix had shipped to one audience and
  // not the other.
  //
  // #1443 removed the copy: the fallback now emits bin/gate.cjs verbatim from a
  // build-time embed. Every behavioural test above already runs that exact file
  // (GATE points at bin/gate.cjs), so re-checking substrings here would only
  // restate byte-identity — and would break on any innocuous rename inside the
  // gate, which is how the `if (!vs.verifyRun) break;` assertion aged out.
  //
  // The invariant that replaced it: tests/guards/embedded-helpers-parity.test.ts
  // pins generateGateScript() to bin/gate.cjs byte-for-byte, and fails if the
  // committed embed goes stale.
  it('emits exactly the gate these tests exercise', () => {
    expect(generateGateScript().replace(/\r\n/g, '\n')).toBe(
      readFileSync(GATE, 'utf-8').replace(/\r\n/g, '\n'),
    );
  });
});
