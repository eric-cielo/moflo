/**
 * Issue #952 — gate enforces swarm/hive-mind init when /fl is invoked with -s/-h.
 *
 * The user explicitly opts in to moflo's protected coordination surface by
 * passing -s (swarm) or -h (hive-mind). Without this gate, Claude can quietly
 * fall back to "Claude-native parallelism" via raw Agent dispatch and never
 * exercise mcp__moflo__swarm_init / mcp__moflo__hive-mind_init — re-creating
 * the silent-regression failure mode that triggered epic #798.
 *
 * Tests run gate.cjs as a child process, exactly like Claude Code's hook
 * runner does, and verify:
 *   1. /fl ... -s without swarm_init  → exit 2 (BLOCKED)
 *   2. /fl ... -s after swarm_init    → exit 0 (allowed)
 *   3. /fl ... -h without hive_init   → exit 2 (BLOCKED)
 *   4. /fl ... -h after hive_init     → exit 0 (allowed)
 *   5. /fl ... (no flag)              → exit 0 (no false positive)
 *   6. Non-/fl prompt with -s         → exit 0 (no false positive)
 *   7. moflo.yaml: swarm_invocation_gate: false → exit 0 (opt-out)
 *   8. New prompt resets swarmInitialized → re-block
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

const GATE = resolve(__dirname, '../../bin/gate.cjs');

let tmpDir: string;

function makeTmpProject(): string {
  const dir = resolve(tmpdir(), `moflo-952-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(dir, '.claude', 'helpers'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'helpers', 'gate.cjs'), readFileSync(GATE, 'utf-8'));
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
  const f = join(projectDir, '.claude', 'workflow-state.json');
  if (!existsSync(f)) return {};
  return JSON.parse(readFileSync(f, 'utf-8'));
}

beforeEach(() => { tmpDir = makeTmpProject(); });
afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

describe('gate.cjs #952: swarm_invocation_gate', () => {
  it('blocks Agent when /fl -s prompt is active and swarm_init has not run', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = '/fl 952 -s';
    runGate('prompt-reminder', env);

    expect(readState(tmpDir).flMode).toBe('swarm');
    expect(readState(tmpDir).swarmInitialized).toBe(false);

    const r = runGate('check-before-agent', env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('BLOCKED');
    expect(r.stderr).toContain('mcp__moflo__swarm_init');
  });

  it('allows Agent after mcp__moflo__swarm_init has been recorded', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = '/fl 952 -s';
    runGate('prompt-reminder', env);
    runGate('record-swarm-init', env);

    expect(readState(tmpDir).swarmInitialized).toBe(true);

    const r = runGate('check-before-agent', env);
    expect(r.exitCode).toBe(0);
  });

  it('blocks Agent when /fl -h prompt is active and hive-mind_init has not run', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = '/flo 953 --hive';
    runGate('prompt-reminder', env);

    expect(readState(tmpDir).flMode).toBe('hive');

    const r = runGate('check-before-agent', env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('BLOCKED');
    expect(r.stderr).toContain('mcp__moflo__hive-mind_init');
  });

  it('allows Agent after mcp__moflo__hive-mind_init has been recorded', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = '/fl 953 -h';
    runGate('prompt-reminder', env);
    runGate('record-hive-init', env);

    expect(readState(tmpDir).hiveInitialized).toBe(true);

    const r = runGate('check-before-agent', env);
    expect(r.exitCode).toBe(0);
  });

  it('does not block /fl without -s or -h (normal mode)', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = '/fl 952';
    runGate('prompt-reminder', env);

    expect(readState(tmpDir).flMode).toBe(null);

    const r = runGate('check-before-agent', env);
    expect(r.exitCode).toBe(0);
  });

  it('does not false-positive on a non-/fl prompt that contains -s', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'fix the auth bug -s flag';
    runGate('prompt-reminder', env);

    expect(readState(tmpDir).flMode).toBe(null);

    const r = runGate('check-before-agent', env);
    expect(r.exitCode).toBe(0);
  });

  it('respects moflo.yaml opt-out: gates: swarm_invocation_gate: false', () => {
    writeFileSync(join(tmpDir, 'moflo.yaml'), 'gates:\n  swarm_invocation_gate: false\n');
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = '/fl 952 -s';
    runGate('prompt-reminder', env);

    expect(readState(tmpDir).flMode).toBe('swarm');

    const r = runGate('check-before-agent', env);
    expect(r.exitCode).toBe(0);
  });

  it('resets swarmInitialized on each new prompt (re-block on next /fl -s)', () => {
    const env = baseEnv(tmpDir);

    env.CLAUDE_USER_PROMPT = '/fl 952 -s';
    runGate('prompt-reminder', env);
    runGate('record-swarm-init', env);
    expect(runGate('check-before-agent', env).exitCode).toBe(0);

    env.CLAUDE_USER_PROMPT = '/fl 953 -s';
    runGate('prompt-reminder', env);
    expect(readState(tmpDir).swarmInitialized).toBe(false);

    const r = runGate('check-before-agent', env);
    expect(r.exitCode).toBe(2);
  });

  it('detects -s flag in any position (before or after issue number)', () => {
    const cases = ['/fl -s 952', '/fl 952 --swarm', '/flo --swarm 952', '/flo 952 -s'];
    for (const prompt of cases) {
      const env = baseEnv(tmpDir);
      env.CLAUDE_USER_PROMPT = prompt;
      runGate('prompt-reminder', env);
      expect(readState(tmpDir).flMode, `flMode for "${prompt}"`).toBe('swarm');
    }
  });

  it('detects -h flag in any position (before or after issue number)', () => {
    const cases = ['/fl -h 953', '/fl 953 --hive', '/flo --hive 953', '/flo 953 -h'];
    for (const prompt of cases) {
      const env = baseEnv(tmpDir);
      env.CLAUDE_USER_PROMPT = prompt;
      runGate('prompt-reminder', env);
      expect(readState(tmpDir).flMode, `flMode for "${prompt}"`).toBe('hive');
    }
  });

  it('session-reset clears flMode, swarmInitialized, and hiveInitialized', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = '/fl 952 -s';
    runGate('prompt-reminder', env);
    runGate('record-swarm-init', env);
    runGate('record-hive-init', env);

    let state = readState(tmpDir);
    expect(state.flMode).toBe('swarm');
    expect(state.swarmInitialized).toBe(true);
    expect(state.hiveInitialized).toBe(true);

    runGate('session-reset', env);
    state = readState(tmpDir);
    expect(state.flMode).toBe(null);
    expect(state.swarmInitialized).toBe(false);
    expect(state.hiveInitialized).toBe(false);
  });
});

describe('execution-modes.md #952: skill text contains MANDATORY directives', () => {
  const skillPath = resolve(__dirname, '../../.claude/skills/fl/execution-modes.md');

  it('SWARM mode section starts with MANDATORY directive citing swarm_init', () => {
    const text = readFileSync(skillPath, 'utf-8');
    expect(text).toMatch(/SWARM mode.*?MANDATORY when `-s` is passed/s);
    expect(text).toContain('mcp__moflo__swarm_init');
    expect(text).toContain('mcp__moflo__agent_spawn');
  });

  it('HIVE-MIND mode section starts with MANDATORY directive citing hive-mind_init', () => {
    const text = readFileSync(skillPath, 'utf-8');
    expect(text).toMatch(/HIVE-MIND mode.*?MANDATORY when `-h` is passed/s);
    expect(text).toContain('mcp__moflo__hive-mind_init');
  });

  it('cites issue #952 and the protected-functionality CLAUDE.md section', () => {
    const text = readFileSync(skillPath, 'utf-8');
    expect(text).toContain('#952');
    expect(text).toMatch(/Protected functionality/i);
  });
});
