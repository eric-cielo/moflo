/**
 * Issue #1441 — `/compact` and `/clear` wiped `.claude/workflow-state.json`,
 * turning moflo's run-mode gates off for the rest of the run.
 *
 * Claude Code fires SessionStart with a `source` of `startup`, `resume`,
 * `clear` or `compact`, and moflo's settings entry carries no matcher, so the
 * launcher runs for all four. §2 reset unconditionally — but a compaction is
 * the SAME session continuing with a shorter context, and a resume is the same
 * session reopened.
 *
 * Two distinct failures came out of that:
 *
 *   1. `flMode` and `sddMode` are derived ONLY from the user's prompt text
 *      (gate.cjs applyPromptStateReset). Clearing them turned the #952
 *      swarm/hive invocation gate — protected surface — and the #1297 SDD gate
 *      OFF, and nothing re-armed them: the user's next prompt mid-run is
 *      ordinary prose, not `/fl -s`. A `/fl -s` run that compacted stopped
 *      enforcing `swarm_init` before `Agent` spawns, with no signal.
 *   2. testsRun / simplifyRun / verifyRun / learningsStored and their
 *      fingerprints were discarded, forcing a full re-run of tests,
 *      /flo-simplify and /verify before `gh pr create`.
 *
 * Coverage:
 *   - `compact` / `resume` leave an existing state file byte-identical
 *   - `startup` / `clear` still reset (a fresh context SHOULD start armed)
 *   - absent / unparseable stdin still resets — back-compat with any host that
 *     doesn't send `source`, and the safe direction (gates armed, not silent)
 *   - end-to-end: the #952 swarm gate still blocks after a compact SessionStart
 *   - shape parity: the launcher's reset keys match gate.cjs's STATE_DEFAULTS,
 *     so the two cannot drift apart again
 *
 * Fixtures live under os.tmpdir() and every spawn passes its own
 * CLAUDE_PROJECT_DIR — see tests/bin/launcher-state-leak.test.ts for why an
 * un-anchored launcher spawn resets the developer's live session.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const LAUNCHER = resolve(__dirname, '../../bin/session-start-launcher.mjs');
const GATE = resolve(__dirname, '../../bin/gate.cjs');

let fixture: string;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'moflo-1441-'));
  mkdirSync(join(fixture, '.claude', 'helpers'), { recursive: true });
  writeFileSync(
    join(fixture, 'package.json'),
    JSON.stringify({ name: 'launcher-1441-fixture', version: '0.0.0' }),
  );
  writeFileSync(join(fixture, '.claude', 'helpers', 'gate.cjs'), readFileSync(GATE, 'utf-8'));
});

afterEach(() => {
  try {
    rmSync(fixture, { recursive: true, force: true });
  } catch {
    /* Windows occasionally holds handles — non-fatal */
  }
});

const STATE_REL = join('.claude', 'workflow-state.json');

/** A mid-run state: swarm mode armed, tests + simplify + verify already credited. */
function stageMidRunState(): Record<string, unknown> {
  const state = {
    tasksCreated: true,
    taskCount: 4,
    tasksAcknowledged: true,
    memorySearched: true,
    memorySearchedBy: { 'sess-1': true },
    memoryRequired: true,
    learningsStored: true,
    testsRun: true,
    testsFingerprint: 'abc123',
    simplifyRun: true,
    simplifySnapshotSha: 'deadbeef',
    simplifyFingerprint: 'abc123',
    verifyRun: true,
    verifyOutcome: 'pass',
    verifyFingerprint: 'abc123',
    interactionCount: 12,
    sessionStart: '2026-01-01T00:00:00.000Z',
    lastBlockedAt: null,
    lastNamespaceHint: '',
    lastNamespaceHintEmittedBy: {},
    flMode: 'swarm',
    swarmInitialized: false,
    hiveInitialized: false,
    sddMode: true,
    activeSddSlug: 'my-spec',
  };
  writeFileSync(join(fixture, STATE_REL), JSON.stringify(state, null, 2));
  return state;
}

function readStateFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixture, STATE_REL), 'utf-8'));
}

/** Run the launcher the way Claude Code does: hook payload on stdin. */
function runLauncher(payload: string): { stderr: string; status: number | null } {
  const result = spawnSync('node', [LAUNCHER], {
    cwd: fixture,
    encoding: 'utf-8',
    timeout: 60_000,
    // CLAUDE_PROJECT_DIR anchors resolveStateRoot on the fixture. Without it the
    // walk-up lands on the moflo repo and this test resets the live session.
    env: { ...process.env, CLAUDE_PROJECT_DIR: fixture, CI: '1' },
    input: payload,
  });
  return { stderr: result.stderr || '', status: result.status };
}

function runGate(command: string, env: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [GATE, command], {
      env: { ...(process.env as Record<string, string>), CLAUDE_PROJECT_DIR: fixture, ...env },
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status ?? 1 };
  }
}

describe('#1441 session-start launcher: continuing sessions keep their gate state', () => {
  it('leaves workflow-state.json untouched on SessionStart source="resume"', () => {
    const staged = stageMidRunState();
    runLauncher(JSON.stringify({ hook_event_name: 'SessionStart', source: 'resume' }));

    // A resume reloads the conversation, so even the memory-search results are
    // still in context — nothing to re-arm.
    expect(
      readStateFile(),
      'SessionStart:resume rewrote workflow-state.json. A resume reopens the SAME ' +
        'session — resetting it turns the #952 swarm gate and the #1297 SDD gate off ' +
        'mid-run and throws away tests/simplify/verify credits.',
    ).toEqual(staged);
  });

  it('keeps every earned credit on SessionStart source="compact"', () => {
    const staged = stageMidRunState();
    runLauncher(JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact' }));

    const after = readStateFile();
    // Everything except the memory credit survives — the work it describes still
    // stands after a compaction (tests ran, /verify passed, the diff is unchanged).
    const memoryKeys = new Set(['memorySearched', 'memorySearchedBy', 'memoryRequired']);
    for (const [key, value] of Object.entries(staged)) {
      if (memoryKeys.has(key)) continue;
      expect(
        after[key],
        `SessionStart:compact dropped "${key}". A compaction continues the SAME run — ` +
          'only the memory-search credit is invalidated by the context loss.',
      ).toEqual(value);
    }
  });

  it('re-arms the memory gate on SessionStart source="compact"', () => {
    stageMidRunState(); // memorySearched: true, memoryRequired: true
    runLauncher(JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact' }));

    const after = readStateFile();
    // `memorySearched` means "this actor has the results in context". After a
    // compaction it does not, so carrying the credit forward hands the model a
    // satisfied memory gate over a context holding none of the results.
    expect(after.memorySearched).toBe(false);
    expect(after.memorySearchedBy).toEqual({});
    // Re-armed regardless of what the pre-compaction prompt left behind. #1447
    // removed one way that mattered — `/compact` used to score memoryRequired:
    // false under the old length/task-word rule — but the launcher's re-arm is
    // deliberately independent of prompt text, because AUTO compaction happens
    // with no prompt submitted at all.
    expect(after.memoryRequired).toBe(true);
  });

  it('re-arms the memory gate after a compaction that followed a disarming prompt', () => {
    // The reported shape end-to-end: a real task arms the gate, a prompt that
    // carries no subject of its own disarms it, then the compaction lands.
    //
    // #1447 changed WHICH prompt does that. This used to submit `/compact`,
    // which the old `TASK_RE || length > 20` rule scored as memoryRequired:
    // false; under the inverted rule `/compact` is subject-bearing and arms. A
    // bare continuation is now the realistic disarming prompt — and it keeps
    // this test honest, because the assertion below is only meaningful if the
    // gate is genuinely down when the launcher runs.
    const env = {
      TOOL_INPUT_command: '',
      TOOL_INPUT_pattern: 'src/**',
      TOOL_INPUT_path: '',
      TOOL_INPUT_file_path: '',
      HOOK_SESSION_ID: '',
    };
    runGate('prompt-reminder', { ...env, CLAUDE_USER_PROMPT: 'fix the launcher state reset bug' });
    expect(readStateFile().memoryRequired).toBe(true);

    runGate('prompt-reminder', { ...env, CLAUDE_USER_PROMPT: 'ok' });
    expect(readStateFile().memoryRequired, 'precondition: a bare continuation disarms it').toBe(false);
    expect(runGate('check-before-scan', { ...env, CLAUDE_USER_PROMPT: '' }).exitCode).toBe(0);

    runLauncher(JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact' }));

    const blocked = runGate('check-before-scan', { ...env, CLAUDE_USER_PROMPT: '' });
    expect(
      blocked.exitCode,
      'The memory gate stayed disarmed through a compaction — the post-compaction ' +
        'model explores files with no memory search and no signal that it should.',
    ).toBe(2);
  });

  it('leaves an unparseable state file alone, and the gate still arms', () => {
    // The catch arm. Rewriting a corrupt file here would buy nothing: gate.cjs
    // readState() already falls back to STATE_DEFAULTS on a parse failure, and
    // that default arms the memory gate — so the fail-safe is the same either
    // way. What must NOT happen is a crash or a half-written file.
    writeFileSync(join(fixture, STATE_REL), '{ this is not json');
    const { stderr } = runLauncher(
      JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact' }),
    );

    expect(readFileSync(join(fixture, STATE_REL), 'utf-8')).toBe('{ this is not json');
    expect(stderr).toContain('re-arm the memory gate');

    // The fallback that makes leaving it alone safe — assert it rather than
    // assume it, since this branch's correctness rests on it.
    const scan = runGate('check-before-scan', {
      TOOL_INPUT_command: '',
      TOOL_INPUT_pattern: 'src/**',
      TOOL_INPUT_path: '',
      TOOL_INPUT_file_path: '',
      HOOK_SESSION_ID: '',
      CLAUDE_USER_PROMPT: '',
    });
    expect(scan.exitCode, 'a corrupt state file must fail safe to an ARMED gate').toBe(2);
  });

  it('does not create a partial state file when compacting before any prompt', () => {
    // No state file staged: there is nothing to re-arm, and writing one here
    // would bypass freshWorkflowState()'s shape guarantee.
    runLauncher(JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact' }));
    expect(existsSync(join(fixture, STATE_REL))).toBe(false);
  });

  for (const source of ['startup', 'clear']) {
    it(`resets workflow-state.json on SessionStart source="${source}"`, () => {
      stageMidRunState();
      runLauncher(JSON.stringify({ hook_event_name: 'SessionStart', source }));

      const after = readStateFile();
      expect(after.flMode).toBeNull();
      expect(after.sddMode).toBe(false);
      expect(after.testsRun).toBe(false);
      expect(after.simplifyRun).toBe(false);
      expect(after.verifyRun).toBe(false);
      expect(after.learningsStored).toBe(false);
      expect(after.tasksAcknowledged).toBe(false);
      expect(after.interactionCount).toBe(0);
      // memoryRequired defaults ON — a fresh session must arm the memory gate.
      expect(after.memoryRequired).toBe(true);
    });
  }

  it('resets when stdin carries no source — back-compat with hosts that omit it', () => {
    stageMidRunState();
    runLauncher('');
    expect(readStateFile().flMode).toBeNull();
  });

  it('resets when stdin is not valid JSON', () => {
    stageMidRunState();
    runLauncher('not json at all');
    expect(readStateFile().flMode).toBeNull();
  });

  it('warns — and still resets — on a source it does not recognise', () => {
    stageMidRunState();
    const { stderr } = runLauncher(
      JSON.stringify({ hook_event_name: 'SessionStart', source: 'teleport' }),
    );
    expect(readStateFile().flMode).toBeNull();
    expect(
      stderr,
      'An unrecognised source resets in silence — that is how a renamed or new ' +
        '"continuing" source re-opens #1441 with nothing to notice it by.',
    ).toContain('teleport');
  });

  it('keeps the #952 swarm gate blocking across a compact (end-to-end)', () => {
    const env = {
      TOOL_INPUT_command: '',
      TOOL_INPUT_pattern: '',
      TOOL_INPUT_path: '',
      TOOL_INPUT_file_path: '',
      HOOK_SESSION_ID: '',
      CLAUDE_USER_PROMPT: '/fl -s 1414',
    };

    // 1. `/fl -s` arms swarm mode.
    runGate('prompt-reminder', env);
    expect(readStateFile().flMode).toBe('swarm');

    // 2. Agent spawn without swarm_init is blocked.
    const before = runGate('check-before-agent', { ...env, CLAUDE_USER_PROMPT: '' });
    expect(before.exitCode).toBe(2);
    expect(before.stderr).toContain('mcp__moflo__swarm_init');

    // 3. The user compacts mid-run.
    runLauncher(JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact' }));

    // 4. The gate must still block. Before #1441 this returned 0 with an
    //    advisory, and stayed off for the rest of the run.
    const after = runGate('check-before-agent', { ...env, CLAUDE_USER_PROMPT: '' });
    expect(
      after.exitCode,
      'The swarm gate stopped blocking after a compact — protected coordination ' +
        'surface silently unenforced (CLAUDE.md "⛔ Protected functionality").',
    ).toBe(2);
    expect(after.stderr).toContain('mcp__moflo__swarm_init');
  });

  // Shape parity with gate.cjs STATE_DEFAULTS — keys AND values — lives in
  // tests/guards/workflow-state-shape-parity.test.ts, alongside the other
  // declaration sites it has to hold across.
});
