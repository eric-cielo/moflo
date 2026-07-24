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
});
