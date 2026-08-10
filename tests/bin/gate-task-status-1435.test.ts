/**
 * #1435 — task-list closure must be enforced, and a passing gate's advisory must
 * actually reach Claude.
 *
 * Two defects, one report. A `/flo` run on a consumer project opened four tasks,
 * finished all four items of work, and shipped a green PR with `TaskUpdate`
 * called zero times — while #1374's open-task check was installed and running.
 *
 *   1. It could not be heard. The count goes to STDOUT, and `check-before-pr`
 *      exits 0 once the other gates pass; a passing PreToolUse hook's stdout is
 *      surfaced in transcript mode only. It reached anyone solely when some OTHER
 *      gate blocked, because gate-hook.mjs re-routes a failed gate's stdout to
 *      stderr — i.e. only on runs already stopped for another reason.
 *   2. Even heard, it was advisory. A reminder ignored ten consecutive times in
 *      one session is not a control.
 *
 * So this file pins the ENFORCEMENT and the DELIVERY. The ledger's arithmetic —
 * what counts as created, closed, or carried across `/clear` — stays pinned in
 * gate-helpers.test.ts, which exercises those shapes in `warn` mode.
 *
 * Assertions run against the shipped `bin/` scripts plus the generator that
 * writes gate.cjs into a fresh project, because a consumer runs a synced copy,
 * never this repo's source tree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, join, isAbsolute } from 'path';
import { tmpdir } from 'os';

import { generateGateScript } from '../../src/cli/init/helpers-generator.js';

const REPO_ROOT = resolve(__dirname, '../..');
const GATE = resolve(REPO_ROOT, 'bin/gate.cjs');
const GATE_HOOK = resolve(REPO_ROOT, 'bin/gate-hook.mjs');

let root: string;

function baseEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    CLAUDE_PROJECT_DIR: root,
    TOOL_INPUT_command: 'gh pr create --title "t" --body "b"',
    HOOK_SESSION_ID: '',
    HOOK_TRANSCRIPT_PATH: '',
  };
}

function runGate(command: string, env: Record<string, string>) {
  const r = spawnSync(process.execPath, [GATE, command], {
    env, encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: typeof r.status === 'number' ? r.status : 1 };
}

/** One transcript line as Claude Code writes it: an assistant tool_use block. */
function toolUse(name: string, input: Record<string, unknown>, id = 'toolu_x'): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
}

/** A TaskCreate call plus the tool_result naming the id it was assigned. */
function taskCreate(taskId: string): string[] {
  const useId = `toolu_create_${taskId}`;
  return [
    toolUse('TaskCreate', { subject: `task ${taskId}`, description: 'd' }, useId),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: `Task #${taskId} created successfully: task ${taskId}` }] },
    }),
  ];
}

function withTranscript(env: Record<string, string>, lines: string[]): string {
  const p = join(root, 'transcript.jsonl');
  writeFileSync(p, lines.join('\n') + '\n');
  env.HOOK_TRANSCRIPT_PATH = p;
  return p;
}

function writeState(patch: Record<string, unknown>): void {
  writeFileSync(join(root, '.claude', 'workflow-state.json'), JSON.stringify(patch, null, 2));
}

function readStateFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, '.claude', 'workflow-state.json'), 'utf-8'));
}

/** Every OTHER pre-PR gate satisfied, so only the task gate can speak. */
function otherGatesGreen(): void {
  writeState({ testsRun: true, simplifyRun: true, learningsStored: true, verifyRun: true, verifyOutcome: 'PASS' });
}

function setMode(mode: string): void {
  writeFileSync(join(root, 'moflo.yaml'), `gates:\n  task_status_gate: ${mode}\n`);
}

beforeEach(() => {
  root = resolve(tmpdir(), `moflo-1435-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(root, '.claude', 'helpers'), { recursive: true });
  // gate-hook.mjs resolves the gate at <project>/.claude/helpers/gate.cjs — the
  // bridge tests below exercise the real pair, not a stub.
  writeFileSync(join(root, '.claude', 'helpers', 'gate.cjs'), readFileSync(GATE, 'utf-8'));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows may still hold handles — non-fatal */
  }
});

describe('#1435 open tasks block the PR by default', () => {
  it('blocks gh pr create when every other gate is green', () => {
    const env = baseEnv();
    otherGatesGreen();
    withTranscript(env, [...taskCreate('1'), ...taskCreate('2')]);

    const r = runGate('check-before-pr', env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('BLOCKED');
    expect(r.stderr).toContain('2 tasks created this session, 2 still open');
  });

  it('passes once every created task reached a terminal status', () => {
    const env = baseEnv();
    otherGatesGreen();
    withTranscript(env, [
      ...taskCreate('1'),
      ...taskCreate('2'),
      toolUse('TaskUpdate', { taskId: '1', status: 'completed' }),
      toolUse('TaskUpdate', { taskId: '2', status: 'deleted' }),
    ]);

    const r = runGate('check-before-pr', env);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain('BLOCKED');
  });

  /**
   * The block fires before the no-source exemption on purpose: a docs-only PR
   * can abandon a task list exactly like a source PR can, and the exemption is
   * about testing/simplify/learnings, not about whether the run reported what it
   * did. Nothing in this fixture is a source file, so the exemption would swallow
   * the gate if the order were reversed.
   */
  it('blocks even on a diff the other gates would exempt', () => {
    const env = baseEnv();
    writeState({});
    withTranscript(env, taskCreate('1'));

    const r = runGate('check-before-pr', env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('1 task created this session, 1 still open');
  });

  it('names the acknowledgement escape rather than only the failure', () => {
    const env = baseEnv();
    otherGatesGreen();
    withTranscript(env, taskCreate('1'));

    const { stderr } = runGate('check-before-pr', env);
    expect(stderr).toContain('record-tasks-acknowledged');
    // The mode knob is part of the escape surface: a project that wants the old
    // report-only behaviour must be able to find it from the block itself.
    expect(stderr).toContain('task_status_gate: warn');
  });
});

describe('#1435 acknowledging deferred work credits the gate', () => {
  it('lets gh pr create through with the tasks still open', () => {
    const env = baseEnv();
    otherGatesGreen();
    withTranscript(env, [...taskCreate('1'), ...taskCreate('2')]);
    expect(runGate('check-before-pr', env).exitCode).toBe(2);

    const ack = runGate('record-tasks-acknowledged', env);
    expect(ack.exitCode).toBe(0);
    expect(readStateFile().tasksAcknowledged).toBe(true);

    const after = runGate('check-before-pr', env);
    expect(after.exitCode).toBe(0);
    expect(after.stderr).not.toContain('BLOCKED');
  });

  it('says the tasks stay open, so acknowledging is not mistaken for closing', () => {
    const r = runGate('record-tasks-acknowledged', baseEnv());
    expect(r.stdout).toContain('deferred');
    expect(r.stdout).toContain('does not close them');
  });

  it('is idempotent and leaves the other credits untouched', () => {
    otherGatesGreen();
    const before = readStateFile();
    runGate('record-tasks-acknowledged', baseEnv());
    runGate('record-tasks-acknowledged', baseEnv());
    const after = readStateFile();
    expect(after.tasksAcknowledged).toBe(true);
    expect(after.testsRun).toBe(before.testsRun);
    expect(after.learningsStored).toBe(before.learningsStored);
    expect(after.verifyOutcome).toBe(before.verifyOutcome);
  });

  /**
   * The escape is the ONLY way past a blocking gate, and writeState swallows its
   * own errors so a gate never crashes the hook it runs in. Reporting success on
   * a write that did not land would block the next `gh pr create` anyway, with
   * nothing said about why — a deadlock with no diagnostic.
   *
   * The failure is induced by making the state path a DIRECTORY, which fails the
   * write on every platform (Rule #1) — unlike a permissions bit, which Windows
   * would happily ignore.
   */
  it('reports failure, loudly, when the acknowledgement cannot be persisted', () => {
    rmSync(join(root, '.claude', 'workflow-state.json'), { force: true });
    mkdirSync(join(root, '.claude', 'workflow-state.json'), { recursive: true });

    const r = runGate('record-tasks-acknowledged', baseEnv());
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain('satisfied:');
    expect(r.stderr).toContain('NOT satisfied');
    // Name the file and a way forward — a diagnostic that only says "failed"
    // leaves the caller with the same deadlock.
    expect(r.stderr).toContain('workflow-state.json');
    expect(r.stderr).toContain('task_status_gate: off');
  });

  /**
   * The command is typed by the model into a Bash tool, where $CLAUDE_PROJECT_DIR
   * is unset (a hook-only variable) and the cwd is not guaranteed to be the
   * project root. Matching the case name alone would pass on a command that
   * cannot run — so run the printed command itself, from elsewhere.
   */
  it('prints a command that actually runs from an unrelated cwd', () => {
    const env = baseEnv();
    otherGatesGreen();
    withTranscript(env, taskCreate('1'));

    const { stderr } = runGate('check-before-pr', env);
    const printed = /node "([^"]+)" record-tasks-acknowledged/.exec(stderr);
    expect(printed, 'block message must print an absolute, quoted script path').not.toBeNull();
    expect(isAbsolute(printed![1])).toBe(true);
    expect(stderr).not.toContain('$CLAUDE_PROJECT_DIR');

    const r = spawnSync(process.execPath, [printed![1], 'record-tasks-acknowledged'], {
      cwd: REPO_ROOT, // deliberately NOT the fixture project root
      env, encoding: 'utf-8', timeout: 30_000,
    });
    expect(r.status).toBe(0);
    expect(readStateFile().tasksAcknowledged).toBe(true);
  });
});

describe('#1435 task_status_gate modes', () => {
  function openOneTask(env: Record<string, string>): void {
    otherGatesGreen();
    withTranscript(env, taskCreate('1'));
  }

  it('warn reports on stdout without blocking', () => {
    const env = baseEnv();
    setMode('warn');
    openOneTask(env);

    const r = runGate('check-before-pr', env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('1 task created this session, 1 still open');
    expect(r.stdout).not.toContain('BLOCKED');
  });

  it('off says nothing at all', () => {
    const env = baseEnv();
    setMode('off');
    openOneTask(env);

    const r = runGate('check-before-pr', env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('still open');
    expect(r.stderr).not.toContain('still open');
  });

  it('accepts the boolean forms its neighbouring gate keys use', () => {
    const env = baseEnv();
    setMode('false');
    openOneTask(env);
    expect(runGate('check-before-pr', env).exitCode).toBe(0);

    setMode('true');
    expect(runGate('check-before-pr', env).exitCode).toBe(2);
  });

  /**
   * A typo must not be a stealth opt-out. `task_status_gate: blcok` reads like a
   * configured value at a glance, and silently disabling enforcement on it would
   * reproduce this ticket in a form nobody can see.
   */
  it('keeps blocking on an unrecognised value', () => {
    const env = baseEnv();
    setMode('blcok');
    openOneTask(env);
    expect(runGate('check-before-pr', env).exitCode).toBe(2);
  });

  it('is disabled entirely by task_create_first: false — both halves or neither', () => {
    const env = baseEnv();
    openOneTask(env);
    writeFileSync(join(root, 'moflo.yaml'), 'gates:\n  task_create_first: false\n');

    const r = runGate('check-before-pr', env);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain('still open');
  });
});

describe('#1435 the gate fails open, never closed', () => {
  it('does not block when the host forwards no transcript path', () => {
    const env = baseEnv();
    otherGatesGreen();
    env.HOOK_TRANSCRIPT_PATH = '';
    expect(runGate('check-before-pr', env).exitCode).toBe(0);
  });

  it('does not block when the transcript path does not exist', () => {
    const env = baseEnv();
    otherGatesGreen();
    env.HOOK_TRANSCRIPT_PATH = join(root, 'no-such-transcript.jsonl');
    expect(runGate('check-before-pr', env).exitCode).toBe(0);
  });

  it('does not block when the transcript is over the size cap', () => {
    // Past the cap the ledger declines to comment rather than risk the hook
    // timeout. Declining must mean "no opinion", not "no tasks" and not a block.
    const env = baseEnv();
    otherGatesGreen();
    const p = join(root, 'huge.jsonl');
    const line = taskCreate('1').join('\n') + '\n';
    writeFileSync(p, line + 'x'.repeat(16 * 1024 * 1024 + 1));
    env.HOOK_TRANSCRIPT_PATH = p;

    const r = runGate('check-before-pr', env);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain('still open');
  });

  it('does not block a session that opened no tasks at all', () => {
    const env = baseEnv();
    otherGatesGreen();
    withTranscript(env, [toolUse('TaskUpdate', { taskId: '7', status: 'completed' })]);
    expect(runGate('check-before-pr', env).exitCode).toBe(0);
  });
});

/**
 * The delivery half. Asserting gate.cjs writes the right bytes proves nothing if
 * the bridge then drops them where nobody reads — which is precisely what
 * happened to #1374's advisory for two releases.
 */
describe('#1435 gate-hook.mjs delivers a passing gate advisory to Claude', () => {
  function runBridge(command: string, payload: Record<string, unknown>) {
    const r = spawnSync(process.execPath, [GATE_HOOK, command], {
      env: { ...(process.env as Record<string, string>), CLAUDE_PROJECT_DIR: root },
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: typeof r.status === 'number' ? r.status : 1 };
  }

  function warnPayload(event: string | undefined): Record<string, unknown> {
    setMode('warn');
    otherGatesGreen();
    const p = join(root, 'transcript.jsonl');
    writeFileSync(p, taskCreate('1').join('\n') + '\n');
    const payload: Record<string, unknown> = {
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title "t"' },
      transcript_path: p,
    };
    if (event) payload.hook_event_name = event;
    return payload;
  }

  it('wraps exit-0 stdout as hookSpecificOutput.additionalContext on PreToolUse', () => {
    const r = runBridge('check-before-pr', warnPayload('PreToolUse'));
    expect(r.exitCode).toBe(0);

    const parsed = JSON.parse(r.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('1 task created this session, 1 still open');
  });

  it('wraps PostToolUse the same way', () => {
    const payload = warnPayload('PostToolUse');
    const r = runBridge('check-before-pr', payload);
    expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe('PostToolUse');
  });

  it('falls back to raw stdout when the host sends no hook_event_name', () => {
    // Older hosts, and any event outside the tool pair. Byte-identical to the
    // pre-#1435 behaviour rather than a JSON blob the host cannot interpret.
    const r = runBridge('check-before-pr', warnPayload(undefined));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('1 task created this session, 1 still open');
    expect(r.stdout.trim().startsWith('{')).toBe(false);
  });

  it('leaves a blocking gate on stderr with exit 2, unwrapped', () => {
    // The block path must stay plain text: Claude Code reads a PreToolUse
    // exit-2 stderr directly, and wrapping it would bury the reason.
    const payload = warnPayload('PreToolUse');
    setMode('block');
    const r = runBridge('check-before-pr', payload);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('1 task created this session, 1 still open');
    expect(r.stdout).toBe('');
  });
});

describe('#1435 every gate copy carries the fix', () => {
  const copies = [
    ['bin/gate.cjs', readFileSync(GATE, 'utf-8')],
    ['.claude/helpers/gate.cjs', readFileSync(join(REPO_ROOT, '.claude', 'helpers', 'gate.cjs'), 'utf-8')],
    ['generateGateScript()', generateGateScript()],
  ] as const;

  for (const [name, src] of copies) {
    it(`${name} handles record-tasks-acknowledged and reads the mode`, () => {
      expect(src).toContain("case 'record-tasks-acknowledged'");
      expect(src).toContain('task_status_gate');
      expect(src).toContain('readTaskLedger');
    });

    /**
     * The escape path must be the `__filename` TOKEN, resolved when the gate runs
     * in the consumer. The generator embeds its copy inside a template literal, so
     * a `${__filename}` slip would bake the build machine's absolute path into
     * every consumer's block message — wrong for them, and a path disclosure.
     */
    it(`${name} resolves the escape path at runtime, not at build time`, () => {
      expect(src).toMatch(/'node "' \+ __filename \+ '"/);
      expect(src).not.toMatch(/node "\/(home|Users)\//);
    });
  }

  const hooks = [
    ['bin/gate-hook.mjs', readFileSync(GATE_HOOK, 'utf-8')],
    ['.claude/helpers/gate-hook.mjs', readFileSync(join(REPO_ROOT, '.claude', 'helpers', 'gate-hook.mjs'), 'utf-8')],
  ] as const;

  for (const [name, src] of hooks) {
    it(`${name} wraps passing-gate advisories`, () => {
      expect(src).toContain('additionalContext');
      expect(src).toContain('hook_event_name');
    });
  }
});

/**
 * The generated copy is what a FRESH `flo init` writes. Substring-matching its
 * source cannot catch a syntax error inside the template literal — a mis-escaped
 * `\n`, an unbalanced brace — which would then ship to every new project.
 */
describe('#1435 the generated gate script runs, not just contains the case', () => {
  it('blocks and then acknowledges, executed as a fresh init would write it', () => {
    const genPath = join(root, 'generated-gate.cjs');
    writeFileSync(genPath, generateGateScript());

    const env = baseEnv();
    otherGatesGreen();
    withTranscript(env, taskCreate('1'));

    const blocked = spawnSync(process.execPath, [genPath, 'check-before-pr'], {
      env, encoding: 'utf-8', timeout: 30_000,
    });
    expect(blocked.stderr).not.toMatch(/SyntaxError|Unexpected token/);
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('1 task created this session, 1 still open');

    const ack = spawnSync(process.execPath, [genPath, 'record-tasks-acknowledged'], {
      env, encoding: 'utf-8', timeout: 30_000,
    });
    expect(ack.status).toBe(0);
    expect(readStateFile().tasksAcknowledged).toBe(true);

    const after = spawnSync(process.execPath, [genPath, 'check-before-pr'], {
      env, encoding: 'utf-8', timeout: 30_000,
    });
    expect(after.status).toBe(0);
  });
});
