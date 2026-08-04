/**
 * Tests for #1322's gate-hook.mjs change — `tool_response` is forwarded to
 * gate.cjs so a gate can observe an OUTCOME, not only the intent it was handed.
 *
 * The payload shape asserted here is the one Claude Code actually delivers,
 * probed on v2.1.220: `{stdout, stderr, interrupted, isImage, noOutputExpected}`
 * with **no exit status anywhere**. Nothing in this file should ever grow an
 * `exitCode` expectation — that field's absence is the premise of the fix.
 *
 * These run the real bin/gate-hook.mjs as a subprocess with a hook payload on
 * stdin, exactly as Claude Code invokes it, and use a stub gate.cjs that dumps
 * the TOOL_RESPONSE_* environment it received.
 *
 * Cross-platform (Rule #1): temp roots go through `realpathSync` (macOS
 * /var -> /private/var); the stub gate is spawned by the hook itself via
 * execFileSync with an argv array, so no shell is involved on any platform.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const HOOK = resolve(__dirname, '../../bin/gate-hook.mjs');

let tmpDir: string;

/** Stand in for gate.cjs: print every TOOL_RESPONSE_* var it was handed. */
const STUB_GATE = `
var out = {};
Object.keys(process.env).forEach(function (k) {
  if (k.indexOf('TOOL_RESPONSE_') === 0) out[k.slice('TOOL_RESPONSE_'.length)] = process.env[k];
});
process.stdout.write(JSON.stringify(out));
`;

function runHook(payload: Record<string, unknown>): Record<string, string> {
  // Delete rather than blank any TOOL_RESPONSE_* the outer process carries: an
  // empty-string var is still a *present* key, which would mask the
  // absent-means-absent assertions below.
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const key of Object.keys(env)) {
    if (key.startsWith('TOOL_RESPONSE_')) delete env[key];
  }
  env.CLAUDE_PROJECT_DIR = tmpDir;

  const stdout = execFileSync('node', [HOOK, 'record-test-run'], {
    input: JSON.stringify({ tool_name: 'Bash', ...payload }),
    env,
    encoding: 'utf-8',
    timeout: 30000,
    windowsHide: true,
  });
  return JSON.parse(stdout || '{}');
}

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-hook-1322-')));
  mkdirSync(join(tmpDir, '.claude', 'helpers'), { recursive: true });
  writeFileSync(join(tmpDir, '.claude', 'helpers', 'gate.cjs'), STUB_GATE);
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('#1322 gate-hook forwards tool_response', () => {
  it('forwards stdout and stderr', () => {
    const env = runHook({
      tool_response: { stdout: 'Tests  2 failed | 8 passed', stderr: 'warn: slow', interrupted: false },
    });
    expect(env.stdout).toBe('Tests  2 failed | 8 passed');
    expect(env.stderr).toBe('warn: slow');
  });

  it('coerces the interrupted boolean to a string', () => {
    // The pre-existing tool_input loop forwards only strings; copying that
    // shape would silently drop `interrupted`, which is a boolean.
    expect(runHook({ tool_response: { interrupted: true } }).interrupted).toBe('true');
    expect(runHook({ tool_response: { interrupted: false } }).interrupted).toBe('false');
  });

  it('forwards nothing when tool_response is absent (PreToolUse)', () => {
    // gate-hook.mjs runs on PreToolUse for five commands where tool_response
    // cannot exist. Absent must stay absent — never a fabricated default.
    expect(runHook({ tool_input: { command: 'npm test' } })).toEqual({});
  });

  it('ignores a non-object tool_response', () => {
    expect(runHook({ tool_response: 'plain string result' })).toEqual({});
    expect(runHook({ tool_response: null })).toEqual({});
  });

  it('omits empty stdout/stderr rather than forwarding empty strings', () => {
    const env = runHook({ tool_response: { stdout: '', stderr: '', interrupted: false } });
    expect(env.stdout).toBeUndefined();
    expect(env.stderr).toBeUndefined();
    expect(env.interrupted).toBe('false');
  });

  it('keeps the TAIL of oversized stdout, not the head', () => {
    // Every runner prints its pass/fail summary LAST. Clipping the front of a
    // long log would discard the exact lines the gate exists to read.
    const summary = 'Tests  3 failed | 40 passed';
    const env = runHook({ tool_response: { stdout: 'x'.repeat(20000) + summary } });
    expect(env.stdout).toHaveLength(4096);
    expect(env.stdout.endsWith(summary)).toBe(true);
  });

  it('bounds stderr too', () => {
    const env = runHook({ tool_response: { stderr: 'y'.repeat(9000) + 'TAILMARK' } });
    expect(env.stderr).toHaveLength(2048);
    expect(env.stderr.endsWith('TAILMARK')).toBe(true);
  });

  it('keeps the combined forwarded payload well inside the Windows env budget', () => {
    // Windows caps the whole environment block at ~32K wide chars and fails the
    // spawn outright rather than truncating. TOOL_INPUT_command is already
    // forwarded uncapped alongside these, so these two must stay small.
    const env = runHook({ tool_response: { stdout: 'a'.repeat(99999), stderr: 'b'.repeat(99999) } });
    expect(env.stdout.length + env.stderr.length).toBeLessThanOrEqual(8192);
  });
});
