/**
 * System tests for issue #1297 — the SDD front-half implement gate.
 *
 * Runs the real bin/gate.cjs as a subprocess (as Claude Code invokes it via
 * PreToolUse / UserPromptSubmit hooks) and asserts:
 *   - `check-before-implement` BLOCKS source Write/Edit when a run is armed for
 *     SDD (sddMode) until a spec exists (activeSddSlug) and its plan is reviewed
 *   - disarmed runs, non-source files, and the spec/plan artifacts themselves pass
 *   - `gates.sdd_gate: false` disables the gate
 *   - `prompt-reminder` arms/disarms sddMode from the /flo prompt + sdd.default
 *
 * Acceptance criteria (from #1297):
 *   - `-sd` / `sdd.default` runs cannot skip straight to implementation
 *   - the gate is a no-op for non-SDD work (zero friction)
 *   - `-sd` disambiguates from `-s` (swarm)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

const GATE = resolve(__dirname, '../../bin/gate.cjs');

let tmpDir: string;

function makeTmpProject(): string {
  const dir = resolve(tmpdir(), `moflo-gate-1297-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  return dir;
}

function baseEnv(projectDir: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    CLAUDE_PROJECT_DIR: projectDir,
    TOOL_INPUT_command: '',
    TOOL_INPUT_file_path: '',
    TOOL_INPUT_skill: '',
    CLAUDE_USER_PROMPT: '',
    HOOK_SESSION_ID: '',
  };
}

function runGate(command: string, env: Record<string, string>): { stderr: string; exitCode: number } {
  try {
    execFileSync('node', [GATE, command], { env, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
    return { stderr: '', exitCode: 0 };
  } catch (err: any) {
    return { stderr: err.stderr || '', exitCode: err.status ?? 1 };
  }
}

function writeState(projectDir: string, state: Record<string, unknown>): void {
  writeFileSync(join(projectDir, '.claude', 'workflow-state.json'), JSON.stringify(state, null, 2));
}

function readState(projectDir: string): Record<string, unknown> {
  const f = join(projectDir, '.claude', 'workflow-state.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : {};
}

function writePlan(projectDir: string, slug: string, status: 'draft' | 'reviewed'): void {
  const dir = join(projectDir, '.moflo', 'specs', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'plan.md'),
    `---\nkind: "plan"\nslug: "${slug}"\ntitle: "T"\nstatus: "${status}"\ncreated: "x"\nupdated: "x"\n---\n\n## Steps\n- a\n`,
  );
}

beforeEach(() => { tmpDir = makeTmpProject(); });
afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

describe('#1297 check-before-implement', () => {
  it('BLOCKS a source edit when armed with no active slug', () => {
    writeState(tmpDir, { sddMode: true, activeSddSlug: null });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = join(tmpDir, 'src', 'a.ts');
    const r = runGate('check-before-implement', env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('author a spec before editing source');
  });

  it('BLOCKS a source edit when the plan is not reviewed', () => {
    writeState(tmpDir, { sddMode: true, activeSddSlug: 'foo' });
    writePlan(tmpDir, 'foo', 'draft');
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = join(tmpDir, 'src', 'a.ts');
    const r = runGate('check-before-implement', env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('the plan for "foo" is not reviewed');
  });

  it('PASSES once the plan is reviewed', () => {
    writeState(tmpDir, { sddMode: true, activeSddSlug: 'foo' });
    writePlan(tmpDir, 'foo', 'reviewed');
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = join(tmpDir, 'src', 'a.ts');
    expect(runGate('check-before-implement', env).exitCode).toBe(0);
  });

  it('is a no-op for a disarmed (non-SDD) run', () => {
    writeState(tmpDir, { sddMode: false, activeSddSlug: null });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = join(tmpDir, 'src', 'a.ts');
    expect(runGate('check-before-implement', env).exitCode).toBe(0);
  });

  it('does not gate non-source files (docs)', () => {
    writeState(tmpDir, { sddMode: true, activeSddSlug: null });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = join(tmpDir, 'docs', 'a.md');
    expect(runGate('check-before-implement', env).exitCode).toBe(0);
  });

  it('does not gate edits to the spec/plan artifacts themselves', () => {
    writeState(tmpDir, { sddMode: true, activeSddSlug: 'foo' });
    writePlan(tmpDir, 'foo', 'draft');
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = join(tmpDir, '.moflo', 'specs', 'foo', 'plan.md');
    // plan.md is not a SOURCE_FILE_RE match anyway, but assert the intent holds.
    expect(runGate('check-before-implement', env).exitCode).toBe(0);
  });

  it('respects gates.sdd_gate: false', () => {
    writeFileSync(join(tmpDir, 'moflo.yaml'), 'gates:\n  sdd_gate: false\n');
    writeState(tmpDir, { sddMode: true, activeSddSlug: 'foo' });
    writePlan(tmpDir, 'foo', 'draft');
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = join(tmpDir, 'src', 'a.ts');
    expect(runGate('check-before-implement', env).exitCode).toBe(0);
  });

  it('honors a custom specs_dir when locating the plan', () => {
    writeFileSync(join(tmpDir, 'moflo.yaml'), 'sdd:\n  specs_dir: docs/specs\n');
    writeState(tmpDir, { sddMode: true, activeSddSlug: 'foo' });
    const dir = join(tmpDir, 'docs', 'specs', 'foo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plan.md'), `---\nkind: "plan"\nslug: "foo"\ntitle: "T"\nstatus: "reviewed"\ncreated: "x"\nupdated: "x"\n---\n\n## Steps\n- a\n`);
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = join(tmpDir, 'src', 'a.ts');
    expect(runGate('check-before-implement', env).exitCode).toBe(0);
  });
});

describe('#1297 prompt-reminder arms sddMode', () => {
  function arm(prompt: string, moflo?: string): Record<string, unknown> {
    if (moflo) writeFileSync(join(tmpDir, 'moflo.yaml'), moflo);
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = prompt;
    runGate('prompt-reminder', env);
    return readState(tmpDir);
  }

  it('/flo -sd arms sddMode', () => {
    expect(arm('/flo -sd 42').sddMode).toBe(true);
  });

  it('/flo with no flag and no config does not arm', () => {
    expect(arm('/flo 42').sddMode).toBe(false);
  });

  it('sdd.default: true arms a bare /flo run', () => {
    expect(arm('/flo 42', 'sdd:\n  default: true\n').sddMode).toBe(true);
  });

  it('--no-sdd overrides sdd.default', () => {
    expect(arm('/flo --no-sdd 42', 'sdd:\n  default: true\n').sddMode).toBe(false);
  });

  it('/flo -s (swarm) does NOT arm sddMode (disambiguation)', () => {
    const s = arm('/flo -s 42');
    expect(s.sddMode).toBe(false);
    expect(s.flMode).toBe('swarm');
  });

  it('a non-/flo prompt does not arm', () => {
    expect(arm('fix a bug').sddMode).toBe(false);
  });

  it('resets activeSddSlug on a fresh prompt', () => {
    writeState(tmpDir, { activeSddSlug: 'stale' });
    expect(arm('/flo -sd 42').activeSddSlug).toBeNull();
  });
});
