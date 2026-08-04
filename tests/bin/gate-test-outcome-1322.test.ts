/**
 * #1322 — `record-test-run` credits an OUTCOME, not an invocation.
 *
 * Background, because the obvious reading of this file is wrong: Claude Code's
 * PostToolUse hook does **not** fire when a Bash command exits non-zero, so an
 * ordinary red suite already left `testsRun` false before this change — by
 * accident of the hook lifecycle, not by design. The defect is narrower: when
 * the non-zero exit is MASKED (`npm test | tail -20`, `npm test || true`,
 * `npm test 2>&1 | grep -i fail`) the pipeline exits 0, PostToolUse fires with a
 * clean-looking response, and a red suite credits the gate.
 *
 * There is no exit status in the payload to consult, so the signal is the
 * runner's own output. That is genuinely weaker than a status, and the tests
 * below pin both directions of the trade: real failure summaries must be
 * caught, and the phrasings that merely *look* like failures must not be.
 *
 * gate.cjs is spawned exactly as the hook spawns it. Cross-platform (Rule #1):
 * no shell, argv arrays only, temp roots via realpathSync.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const GATE = resolve(__dirname, '../../bin/gate.cjs');

let tmpDir: string;

interface Response { stdout?: string; stderr?: string; interrupted?: boolean }

function stateFile(): string {
  return join(tmpDir, '.claude', 'workflow-state.json');
}

function writeState(patch: Record<string, unknown>): void {
  writeFileSync(stateFile(), JSON.stringify(patch));
}

function readTestsRun(): boolean {
  return JSON.parse(readFileSync(stateFile(), 'utf-8')).testsRun;
}

/** Run record-test-run with the env gate-hook.mjs would have built. */
function record(cmd: string, response: Response = {}): string {
  const r = spawnSync('node', [GATE, 'record-test-run'], {
    env: {
      ...(process.env as Record<string, string>),
      CLAUDE_PROJECT_DIR: tmpDir,
      TOOL_INPUT_command: cmd,
      TOOL_RESPONSE_stdout: response.stdout ?? '',
      TOOL_RESPONSE_stderr: response.stderr ?? '',
      TOOL_RESPONSE_interrupted: response.interrupted === undefined ? '' : String(response.interrupted),
    },
    encoding: 'utf-8',
    timeout: 30000,
    windowsHide: true,
  });
  return r.stderr || '';
}

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-gate-1322-')));
  mkdirSync(join(tmpDir, '.claude'), { recursive: true });
  writeState({ testsRun: false });
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('#1322 a masked red suite does not credit the gate', () => {
  it('leaves testsRun false when output reports failures', () => {
    const stderr = record('npm test 2>&1 | tail -20', {
      stdout: ' Test Files  1 failed | 40 passed (41)\n      Tests  3 failed | 9864 passed (9867)',
    });
    expect(readTestsRun()).toBe(false);
    expect(stderr).toContain('record-test-run not credited');
  });

  it('CLEARS a testsRun already earned by an earlier green run', () => {
    // Without the reset, `npm test` (green) then an edit then
    // `npm test | tail -20` (red) leaves the gate satisfied: the edit resets
    // the flag and the masked red run immediately sets it back.
    writeState({ testsRun: true });
    record('npm test || true', { stdout: 'Tests  1 failed | 2 passed' });
    expect(readTestsRun()).toBe(false);
  });

  it.each([
    ['vitest / jest counts', 'Tests  2 failed | 8 passed (10)'],
    ['jest summary line', 'Tests:       1 failed, 2 passed, 3 total'],
    ['pytest summary', '=========== 1 failed, 2 passed in 0.42s ==========='],
    ['mocha', '  1 failing'],
    ['vitest per-file marker', 'FAIL  src/cli/__tests__/foo.test.ts > does a thing'],
    ['pytest per-test marker', 'FAILED tests/test_x.py::test_y - assert 1 == 2'],
    ['go test', '--- FAIL: TestThing (0.00s)'],
    ['cargo', 'test result: FAILED. 1 passed; 1 failed; 0 ignored'],
    ['npm wrapper', 'npm ERR! Test failed.  See above for more details.'],
    // The lookahead that rejects prose must not reject these: a tally at a line
    // end has nothing after it, and "2 failed tests" is a summary, not a phrase.
    ['a tally at end of line', 'Summary of all failing tests\n  2 failed'],
    ['an explicit "N failed tests"', '4 failed tests, 20 passed'],
  ])('detects a %s failure summary', (_label, output) => {
    record('npm test | cat', { stdout: output });
    expect(readTestsRun()).toBe(false);
  });

  it('does not credit an interrupted run', () => {
    record('npm test', { stdout: 'partial output', interrupted: true });
    expect(readTestsRun()).toBe(false);
  });
});

describe('#1322 green and ambiguous runs are unaffected', () => {
  it('still credits a genuinely passing run', () => {
    record('npm test', { stdout: ' Test Files  41 passed (41)\n      Tests  9867 passed (9867)' });
    expect(readTestsRun()).toBe(true);
  });

  it('still credits a run with no captured output', () => {
    // A quiet green `npm test > /dev/null` and a silently-masked red one are
    // indistinguishable. Absent means unknown, and unknown keeps the
    // pre-#1322 behaviour rather than blocking every consumer who redirects.
    record('npm test > /dev/null');
    expect(readTestsRun()).toBe(true);
  });

  it('treats an explicit zero count as passing', () => {
    // `0 failed` must not self-block — some reporters always print the segment.
    record('npm test', { stdout: 'Tests:       0 failed, 12 passed, 12 total' });
    expect(readTestsRun()).toBe(true);
  });

  it.each([
    ['a passing test whose NAME contains "failed"', '  ✓ returns null when the lookup failed (3 ms)'],
    ['a passing test whose name contains "failure"', '  ✓ surfaces a failure reason to the caller'],
    ['prose mentioning failures', 'Note: retries on transient failure are covered elsewhere'],
    ['a zero-failure cargo line', 'test result: ok. 42 passed; 0 failed; 0 ignored'],
    // Mocha's default spec reporter prints every PASSING test name, so a green
    // `npm test | tail -20` genuinely contains lines shaped like a tally. These
    // are the false positives that would block a legitimate PR.
    ['a passing mocha test named with a count', '    ✓ retries 2 failed requests before giving up'],
    ['a passing test named with a failure count', '  ✓ reports 3 failing shards to the coordinator'],
  ])('does not false-positive on %s', (_label, output) => {
    record('npm test', { stdout: `${output}\n Tests  12 passed (12)` });
    expect(readTestsRun()).toBe(true);
  });

  it('ignores tool_response entirely for a non-test command', () => {
    record('git status', { stdout: 'Tests  3 failed' });
    expect(readTestsRun()).toBe(false); // unchanged — never matched TEST_RUNNER_RE
  });
});
