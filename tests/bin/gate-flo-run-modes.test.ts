/**
 * System tests for the authoritative /flo run-mode announcement.
 *
 * Context: `moflo.yaml sdd.default: true` was being silently ignored. The
 * resolution logic in bin/gate.cjs was correct and already re-read moflo.yaml on
 * every prompt, but it never SURFACED the result — and the /flo skill carried
 * `let sddMode = false` as a literal beside a comment saying "seed from
 * moflo.yaml", so the model executed the literal and ran a non-SDD cycle.
 *
 * These tests run the real bin/gate.cjs as a subprocess (as Claude Code invokes
 * it via the UserPromptSubmit hook) and assert:
 *   - a /flo prompt emits the `[moflo] /flo run modes` line on stdout
 *   - the announced sdd/verify/merge values honor moflo.yaml, per-run flags, and
 *     flag-over-config precedence
 *   - a config-sourced ON (one the user did not type) gets the extra explainer
 *   - non-/flo prompts emit nothing (zero cost for ordinary work)
 *   - the announcement always agrees with the armed state.sddMode — one resolver,
 *     so the gate and the announcement can never disagree
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

const GATE = resolve(__dirname, '../../bin/gate.cjs');

let tmpDir: string;

beforeEach(() => {
  tmpDir = resolve(tmpdir(), `moflo-flo-modes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(tmpDir, '.claude'), { recursive: true });
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Run prompt-reminder for `prompt` against an optional moflo.yaml; return stdout + armed state. */
function run(prompt: string, moflo?: string): { out: string; state: Record<string, unknown> } {
  if (moflo !== undefined) writeFileSync(join(tmpDir, 'moflo.yaml'), moflo);
  const env = {
    ...(process.env as Record<string, string>),
    CLAUDE_PROJECT_DIR: tmpDir,
    CLAUDE_USER_PROMPT: prompt,
    TOOL_INPUT_command: '',
    TOOL_INPUT_file_path: '',
    TOOL_INPUT_skill: '',
    HOOK_SESSION_ID: '',
  };
  const out = execFileSync('node', [GATE, 'prompt-reminder'], {
    env, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const f = join(tmpDir, '.claude', 'workflow-state.json');
  const state = existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : {};
  return { out, state };
}

/** Pull the `sdd=`/`verify=`/`merge=` values out of the announcement line. */
function modes(out: string): Record<string, string> | null {
  const line = out.split(/\r?\n/).find((l) => l.includes('/flo run modes'));
  if (!line) return null;
  const grab = (k: string) => (line.match(new RegExp(k + '=(ON|off)')) || [])[1];
  return { sdd: grab('sdd'), verify: grab('verify'), merge: grab('merge') };
}

const SDD_ON = 'sdd:\n  default: true\n';

describe('prompt-reminder: /flo run-mode announcement', () => {
  it('emits nothing for a non-/flo prompt', () => {
    expect(run('fix a bug', SDD_ON).out).not.toContain('/flo run modes');
  });

  it('announces sdd=ON for a bare /flo when moflo.yaml sets sdd.default: true', () => {
    // The exact regression: bare /flo on an sdd-default project must not read as off.
    expect(modes(run('/flo 42', SDD_ON).out)).toMatchObject({ sdd: 'ON' });
  });

  it('attributes a config-sourced sdd=ON to moflo.yaml and states the cycle is mandatory', () => {
    const { out } = run('/flo 42', SDD_ON);
    expect(out).toContain('sdd is ON via moflo.yaml sdd.default');
    expect(out).toContain('MANDATORY');
  });

  it('omits the explainer when the user typed the flag themselves', () => {
    const { out } = run('/flo -sd 42', '');
    expect(modes(out)).toMatchObject({ sdd: 'ON' });
    expect(out).not.toContain('sdd is ON via');
  });

  it('announces sdd=off for a bare /flo with no config', () => {
    expect(modes(run('/flo 42', '').out)).toMatchObject({ sdd: 'off' });
  });

  it('--no-sdd overrides sdd.default: true', () => {
    expect(modes(run('/flo --no-sdd 42', SDD_ON).out)).toMatchObject({ sdd: 'off' });
  });

  it('-s (swarm) is not mistaken for -sd (sdd)', () => {
    expect(modes(run('/flo -s 42', '').out)).toMatchObject({ sdd: 'off' });
  });

  it('verify is ON by default (#1294) and off when gates.verify_before_done: false', () => {
    expect(modes(run('/flo 42', '').out)).toMatchObject({ verify: 'ON' });
    const off = 'gates:\n  verify_before_done: false\n';
    expect(modes(run('/flo 42', off).out)).toMatchObject({ verify: 'off' });
  });

  it('--sdd implies verify even when gates.verify_before_done: false', () => {
    const off = 'gates:\n  verify_before_done: false\n';
    expect(modes(run('/flo -sd 42', off).out)).toMatchObject({ sdd: 'ON', verify: 'ON' });
  });

  it('--no-verify still wins over the --sdd implication', () => {
    expect(modes(run('/flo -sd --no-verify 42', '').out)).toMatchObject({ sdd: 'ON', verify: 'off' });
  });

  it('merge follows moflo.yaml merge.auto and is attributed when not typed', () => {
    const { out } = run('/flo 42', 'merge:\n  auto: true\n');
    expect(modes(out)).toMatchObject({ merge: 'ON' });
    expect(out).toContain('merge is ON via moflo.yaml merge.auto');
  });

  it('--no-merge overrides merge.auto: true', () => {
    expect(modes(run('/flo --no-merge 42', 'merge:\n  auto: true\n').out)).toMatchObject({ merge: 'off' });
  });

  it('does not confuse a merge.auto key with sdd.default (block scoping)', () => {
    // A bare `auto: true` under another section must not turn merge on.
    const other = 'epic:\n  auto: true\n\nsdd:\n  default: true\n';
    expect(modes(run('/flo 42', other).out)).toMatchObject({ sdd: 'ON', merge: 'off' });
  });

  it('clears verify in -t/-r (no implementation) and sdd in -r (no artifacts)', () => {
    expect(modes(run('/flo -t 42', SDD_ON).out)).toMatchObject({ sdd: 'ON', verify: 'off' });
    expect(modes(run('/flo -r 42', SDD_ON).out)).toMatchObject({ sdd: 'off', verify: 'off' });
  });

  it('clears merge under --epic-branch (the epic orchestrator owns merging)', () => {
    const cfg = 'merge:\n  auto: true\n';
    expect(modes(run('/flo --epic-branch foo 42', cfg).out)).toMatchObject({ merge: 'off' });
  });

  it('the announced sdd always matches the armed state.sddMode', () => {
    // One resolver feeds both — a divergence here is the bug class this fixes.
    for (const [prompt, cfg] of [
      ['/flo 42', SDD_ON], ['/flo -sd 42', ''], ['/flo --no-sdd 42', SDD_ON],
      ['/flo -s 42', ''], ['/flo -r 42', SDD_ON], ['/flo -t 42', SDD_ON],
    ] as const) {
      const { out, state } = run(prompt, cfg);
      expect(modes(out)!.sdd === 'ON', `${prompt} (cfg=${JSON.stringify(cfg)})`).toBe(state.sddMode === true);
    }
  });

  it('picks up a moflo.yaml edit on the very next prompt (no cache to invalidate)', () => {
    // Fresh process per prompt is what makes a git pull mid-session safe.
    expect(modes(run('/flo 42', '').out)).toMatchObject({ sdd: 'off' });
    expect(modes(run('/flo 42', SDD_ON).out)).toMatchObject({ sdd: 'ON' });
  });

  it('tolerates CRLF line endings in moflo.yaml (Rule #1)', () => {
    expect(modes(run('/flo 42', 'sdd:\r\n  default: true\r\n').out)).toMatchObject({ sdd: 'ON' });
  });
});
