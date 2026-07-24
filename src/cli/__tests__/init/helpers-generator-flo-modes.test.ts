/**
 * Drift guard: the gate script embedded in init/helpers-generator.ts is a
 * hand-maintained verbatim copy of bin/gate.cjs (it is what `flo init` writes to
 * a consumer's .claude/helpers/gate.cjs before the launcher syncs the canonical
 * bin/ copy over it). The two have historically drifted whenever one side was
 * edited alone.
 *
 * Rather than diff the sources (they differ by design — the embedded copy has
 * trimmed comments), generate the script, run it as a real subprocess, and
 * assert it produces the SAME /flo run-mode announcement as bin/gate.cjs. A
 * behavioural equivalence check survives cosmetic divergence and catches the
 * only thing that matters: a consumer on the generated copy resolving
 * `sdd.default: true` differently from one on the canonical copy.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import { generateGateScript } from '../../init/helpers-generator.js';

const CANONICAL = resolve(__dirname, '../../../../bin/gate.cjs');

let root: string;
let generated: string;

beforeAll(() => {
  root = resolve(tmpdir(), `moflo-gen-gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(root, { recursive: true });
  generated = join(root, 'generated-gate.cjs');
  writeFileSync(generated, generateGateScript());
});

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Run a gate script's prompt-reminder in a throwaway project; return stdout. */
function announce(gateScript: string, prompt: string, moflo: string): string {
  const proj = join(root, `p-${Math.random().toString(36).slice(2, 10)}`);
  mkdirSync(join(proj, '.claude'), { recursive: true });
  writeFileSync(join(proj, 'moflo.yaml'), moflo);
  return execFileSync('node', [gateScript, 'prompt-reminder'], {
    env: {
      ...(process.env as Record<string, string>),
      CLAUDE_PROJECT_DIR: proj,
      CLAUDE_USER_PROMPT: prompt,
      TOOL_INPUT_command: '',
      TOOL_INPUT_file_path: '',
      TOOL_INPUT_skill: '',
      HOOK_SESSION_ID: '',
    },
    encoding: 'utf-8',
    timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Just the run-modes line, so interactionCount-driven Context warnings don't matter. */
function modesLine(out: string): string {
  return out.split(/\r?\n/).find((l) => l.includes('/flo run modes')) ?? '';
}

const CASES: Array<[string, string]> = [
  ['/flo 42', 'sdd:\n  default: true\n'],
  ['/flo 42', ''],
  ['/flo -sd 42', ''],
  ['/flo --no-sdd 42', 'sdd:\n  default: true\n'],
  ['/flo -s 42', 'sdd:\n  default: true\n'],
  ['/flo -r 42', 'sdd:\n  default: true\n'],
  ['/flo -t 42', 'sdd:\n  default: true\n'],
  ['/flo 42', 'merge:\n  auto: true\n'],
  ['/flo 42', 'gates:\n  verify_before_done: false\n'],
  ['/flo -sd --no-verify 42', ''],
];

describe('generated gate.cjs matches bin/gate.cjs on /flo run modes', () => {
  it('is syntactically valid', () => {
    expect(() => execFileSync('node', ['--check', generated], { stdio: 'pipe' })).not.toThrow();
  });

  it.each(CASES)('resolves %j (config %j) identically to the canonical gate', (prompt, moflo) => {
    const fromGenerated = modesLine(announce(generated, prompt, moflo));
    const fromCanonical = modesLine(announce(CANONICAL, prompt, moflo));
    expect(fromGenerated).not.toBe('');
    expect(fromGenerated).toBe(fromCanonical);
  });

  it('emits the config-sourced sdd explainer, same as the canonical gate', () => {
    const out = announce(generated, '/flo 42', 'sdd:\n  default: true\n');
    expect(out).toContain('sdd is ON via moflo.yaml sdd.default');
    expect(out).toContain('MANDATORY');
  });

  it('stays silent for a non-/flo prompt', () => {
    expect(announce(generated, 'fix a bug', 'sdd:\n  default: true\n')).not.toContain('/flo run modes');
  });
});
