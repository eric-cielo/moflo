/**
 * Tests for `flo sdd mode` — the CLI fallback that resolves a /flo run's
 * sdd/verify/merge modifiers from moflo.yaml + the run's flags.
 *
 * This is the backup path for the authoritative announcement that
 * bin/gate.cjs prompt-reminder normally injects. Consumers with hooks disabled
 * (or a gate.cjs predating the announcement) shell out to this instead, so its
 * precedence MUST match resolveFloRun in bin/gate.cjs exactly.
 *
 * Also guards the `--args=` calling convention: `--args <value>` silently
 * degrades to `args=true` when the value starts with `-`, which would resolve
 * every run to the bare config default — the exact silent-wrong-answer failure
 * this whole change exists to eliminate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

const CLI = resolve(__dirname, '../../../../bin/cli.js');

let tmpDir: string;

beforeEach(() => {
  tmpDir = resolve(tmpdir(), `moflo-sdd-mode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(tmpDir, '.claude'), { recursive: true });
  // findProjectRoot needs a marker; .git makes tmpDir the root rather than
  // walking up into the real repo and picking up ITS moflo.yaml.
  mkdirSync(join(tmpDir, '.git'), { recursive: true });
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function resolveModes(floArgs: string, moflo = ''): Record<string, unknown> {
  writeFileSync(join(tmpDir, 'moflo.yaml'), moflo);
  const out = execFileSync('node', [CLI, 'sdd', 'mode', `--args=${floArgs}`], {
    cwd: tmpDir, encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

const SDD_ON = 'sdd:\n  default: true\n';

describe('flo sdd mode', () => {
  it('resolves sdd from moflo.yaml sdd.default for a bare run', () => {
    expect(resolveModes('42', SDD_ON)).toMatchObject({ sdd: true, sddSrc: 'moflo.yaml sdd.default' });
  });

  it('defaults sdd off with no config (opt-in)', () => {
    expect(resolveModes('42')).toMatchObject({ sdd: false });
  });

  it('an explicit flag outranks the config and is attributed to the flag', () => {
    expect(resolveModes('-sd 42')).toMatchObject({ sdd: true, sddSrc: 'flag' });
    expect(resolveModes('--no-sdd 42', SDD_ON)).toMatchObject({ sdd: false, sddSrc: 'flag' });
  });

  it('parses a value beginning with "-" (the --args= convention)', () => {
    // Regression: `--args "-sd 42"` degraded to args=true and lost the flags.
    expect(resolveModes('-sd 42')).toMatchObject({ sdd: true, sddSrc: 'flag' });
  });

  it('does not mistake -s (swarm) for -sd (sdd)', () => {
    expect(resolveModes('-s 42')).toMatchObject({ sdd: false });
  });

  it('verify is on by default and opt-out via gates.verify_before_done', () => {
    expect(resolveModes('42')).toMatchObject({ verify: true });
    expect(resolveModes('42', 'gates:\n  verify_before_done: false\n')).toMatchObject({ verify: false });
  });

  it('--sdd implies verify, but --no-verify still wins', () => {
    expect(resolveModes('-sd 42', 'gates:\n  verify_before_done: false\n')).toMatchObject({ verify: true });
    expect(resolveModes('-sd --no-verify 42')).toMatchObject({ sdd: true, verify: false });
  });

  it('merge follows merge.auto and its per-run overrides', () => {
    expect(resolveModes('42', 'merge:\n  auto: true\n')).toMatchObject({ merge: true, mergeSrc: 'moflo.yaml merge.auto' });
    expect(resolveModes('--no-merge 42', 'merge:\n  auto: true\n')).toMatchObject({ merge: false });
    expect(resolveModes('-m 42')).toMatchObject({ merge: true, mergeSrc: 'flag' });
  });

  it('clears inapplicable modifiers per workflow mode', () => {
    expect(resolveModes('-t 42', SDD_ON)).toMatchObject({ workflow: 'ticket', sdd: true, verify: false, merge: false });
    expect(resolveModes('-r 42', SDD_ON)).toMatchObject({ workflow: 'research', sdd: false, verify: false });
    expect(resolveModes('--epic-branch foo 42', 'merge:\n  auto: true\n')).toMatchObject({ merge: false });
  });

  it('handles an empty argument string', () => {
    expect(resolveModes('', SDD_ON)).toMatchObject({ workflow: 'full', sdd: true });
  });

  it('re-attributes a mode that applicability turned off', () => {
    // A false must never carry the source of the value it no longer has.
    expect(resolveModes('-r 42', SDD_ON)).toMatchObject({
      sdd: false, sddSrc: 'research mode produces no spec artifacts',
    });
    expect(resolveModes('--epic-branch foo 42', 'merge:\n  auto: true\n')).toMatchObject({
      merge: false, mergeSrc: '--epic-branch owns merging',
    });
  });
});

/**
 * The CLI fallback and bin/gate.cjs are separate implementations of the same
 * precedence rules — exactly the shape that let `sdd.default: true` be enforced
 * by one and ignored by the other. Assert they agree on every axis, so a change
 * to one that is not mirrored into the other fails here rather than in a
 * consumer's silently-non-SDD run.
 */
describe('flo sdd mode agrees with bin/gate.cjs', () => {
  const GATE = resolve(__dirname, '../../../../bin/gate.cjs');

  function gateModes(floArgs: string, moflo: string): Record<string, boolean | string> {
    writeFileSync(join(tmpDir, 'moflo.yaml'), moflo);
    const out = execFileSync('node', [GATE, 'prompt-reminder'], {
      env: {
        ...(process.env as Record<string, string>),
        CLAUDE_PROJECT_DIR: tmpDir,
        CLAUDE_USER_PROMPT: `/flo ${floArgs}`,
        TOOL_INPUT_command: '', TOOL_INPUT_file_path: '', TOOL_INPUT_skill: '', HOOK_SESSION_ID: '',
      },
      encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const line = out.split(/\r?\n/).find((l) => l.includes('/flo run modes')) ?? '';
    const grab = (k: string) => (line.match(new RegExp(`${k}=(ON|off)`)) || [])[1] === 'ON';
    return {
      sdd: grab('sdd'), verify: grab('verify'), merge: grab('merge'),
      workflow: (line.match(/workflow=(\w[\w-]*)/) || [])[1] ?? '',
    };
  }

  const CASES: Array<[string, string]> = [
    ['42', SDD_ON],
    ['42', ''],
    ['-sd 42', ''],
    ['--no-sdd 42', SDD_ON],
    ['-s 42', SDD_ON],
    ['-r 42', SDD_ON],
    ['-t 42', SDD_ON],
    ['-sd --no-verify 42', ''],
    ['42', 'merge:\n  auto: true\n'],
    ['--no-merge 42', 'merge:\n  auto: true\n'],
    ['42', 'gates:\n  verify_before_done: false\n'],
    ['--epic-branch foo 42', 'merge:\n  auto: true\n'],
  ];

  it.each(CASES)('resolves %j (config %j) the same way', (floArgs, moflo) => {
    const cli = resolveModes(floArgs, moflo);
    expect({
      sdd: cli.sdd, verify: cli.verify, merge: cli.merge, workflow: cli.workflow,
    }).toEqual(gateModes(floArgs, moflo));
  });
});
