/**
 * Guard: a gate message may only claim to block when the gate actually blocks (#1326).
 *
 * The defect this pins: `check-before-agent` printed "Task tool is blocked until
 * then" on stdout with no `process.exit(2)` anywhere near it. Nothing was
 * blocked. A warning that claims an authority it does not have teaches the
 * reader to discount the whole channel — including the messages that ARE
 * load-bearing, like the #952 swarm/hive block a few lines below it.
 *
 * The invariant is expressed against Claude Code's hook contract rather than
 * against any particular sentence, so it survives rewording:
 *
 *   stderr + exit 2  → the tool call is prevented. Blocking language is honest.
 *   stdout + exit 0  → advisory context only. Blocking language is a lie.
 *
 * Both halves are asserted: the advisory channel must never claim to block, and
 * every case that DOES use blocking language must contain the exit that backs
 * it. #1326's sibling failure was a stale comment claiming the opposite ("agent
 * spawning is never blocked", written before #952 added a hard block), so the
 * check runs on real behaviour, not on prose.
 *
 * Cross-platform (Rule #1): gate.cjs is spawned with an argv array, never a
 * shell; temp roots go through realpathSync (macOS /var -> /private/var).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

import { generateGateScript } from '../../src/cli/init/helpers-generator.js';
import { generateClaudeMd } from '../../src/cli/init/claudemd-generator.js';
import { GateService } from '../../src/cli/services/spell-gate.js';

const GATE = resolve(__dirname, '../../bin/gate.cjs');

/** "blocked", "blocks", "blocking" — but not "blockchain" or "block scope". */
const BLOCKING_LANGUAGE = /\bblock(?:s|ed|ing)?\b/i;

/** Every `process.<channel>.write('literal'` in a gate script. */
function writeLiterals(source: string, channel: 'stdout' | 'stderr'): string[] {
  const re = new RegExp(`process\\.${channel}\\.write\\(\\s*(['"])((?:[^\\\\]|\\\\.)*?)\\1`, 'g');
  const found: string[] = [];
  for (let m = re.exec(source); m !== null; m = re.exec(source)) found.push(m[2]);
  return found;
}

/** Split a gate script into its `case '<command>':` bodies. */
function caseBlocks(source: string): Array<{ command: string; body: string }> {
  const parts = source.split(/\n  case '/).slice(1);
  return parts.map((part) => ({
    command: part.slice(0, part.indexOf("'")),
    body: part,
  }));
}

let tmpDir: string;

function runGate(command: string, state: Record<string, unknown>, prompt = ''): {
  stdout: string; stderr: string; exitCode: number;
} {
  writeFileSync(join(tmpDir, '.claude', 'workflow-state.json'), JSON.stringify(state));
  const env = {
    ...(process.env as Record<string, string>),
    CLAUDE_PROJECT_DIR: tmpDir,
    CLAUDE_USER_PROMPT: prompt,
    HOOK_SESSION_ID: '',
  };
  try {
    return {
      stdout: execFileSync('node', [GATE, command], {
        env, encoding: 'utf-8', timeout: 30000, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
      stderr: '',
      exitCode: 0,
    };
  } catch (err: any) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status ?? 1 };
  }
}

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-gate-1326-')));
  mkdirSync(join(tmpDir, '.claude', 'helpers'), { recursive: true });
  writeFileSync(join(tmpDir, '.claude', 'helpers', 'gate.cjs'), readFileSync(GATE, 'utf-8'));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('#1326 gate messages agree with gate behaviour', () => {
  // bin/ is what dogfood + the launcher sync run; the generator is what a
  // consumer's `flo init` writes. Both must hold the invariant, or the fix
  // ships to one audience and not the other.
  const scripts: Array<[string, string]> = [
    ['bin/gate.cjs', readFileSync(GATE, 'utf-8')],
    ['generateGateScript()', generateGateScript()],
  ];

  it.each(scripts)('%s: nothing written to stdout claims to block', (_name, source) => {
    const offenders = writeLiterals(source, 'stdout').filter((s) => BLOCKING_LANGUAGE.test(s));
    expect(offenders).toEqual([]);
  });

  it.each(scripts)('%s: every case using blocking language also exits 2', (_name, source) => {
    // Emitted text only. A comment may legitimately use the word ("memory stays
    // searched so Read/Grep aren't blocked mid-execution") — a regex cannot
    // judge prose, and the reader-facing claim is what this guard is about.
    const claimed = caseBlocks(source).filter((c) =>
      [...writeLiterals(c.body, 'stdout'), ...writeLiterals(c.body, 'stderr')]
        .some((s) => BLOCKING_LANGUAGE.test(s)));
    // Sanity: if this is empty the filter is broken, not the code — the
    // memory-first and pr gates genuinely do block.
    expect(claimed.length).toBeGreaterThan(0);
    for (const { command, body } of claimed) {
      expect(body, `case '${command}' claims blocking without exit(2)`).toContain('process.exit(2)');
    }
  });

  it('the TaskCreate reminder is advisory in wording as well as in effect', () => {
    const r = runGate('check-before-agent', { tasksCreated: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('REMINDER: Use TaskCreate before spawning agents.');
    expect(r.stdout).not.toMatch(BLOCKING_LANGUAGE);
  });

  it('still hard-blocks the #952 swarm path — the fix is wording, not enforcement', () => {
    const r = runGate('check-before-agent', { flMode: 'swarm', swarmInitialized: false }, '/fl 1326 -s');
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('BLOCKED');
  });
});

describe('#1326 spell-gate mirrors the same contract', () => {
  it('an allowed:true result never carries blocking language', () => {
    const gate = new GateService(tmpDir);
    writeFileSync(join(tmpDir, '.claude', 'workflow-state.json'), JSON.stringify({ tasksCreated: false }));

    const result = gate.checkBeforeAgent();
    expect(result.allowed).toBe(true);
    if (result.message) expect(result.message).not.toMatch(BLOCKING_LANGUAGE);

    const reminder = gate.promptReminder('implement the thing').reminder;
    if (reminder) expect(reminder).not.toMatch(BLOCKING_LANGUAGE);
  });
});

describe('#1326 the injected CLAUDE.md block', () => {
  const block = generateClaudeMd();

  it('does not file the advisory TaskCreate reminder under an enforced heading', () => {
    expect(block).not.toContain('Auto-enforced gates');
    const advisory = block.split('\n').find((l) => l.includes('TaskCreate') && l.includes('Agent tool'));
    expect(advisory).toBeDefined();
    expect(advisory).toContain('Advisory');
  });

  it('stays small — this text lands in every consumer\'s CLAUDE.md', () => {
    // Not a style nit: the block is prepended to a file the consumer's agent
    // reads on every prompt, so growth here is a per-prompt tax on every
    // install. Raise this bound deliberately, never incidentally.
    expect(block.split('\n').length).toBeLessThanOrEqual(45);
  });
});
