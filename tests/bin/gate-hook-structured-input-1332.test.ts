/**
 * Tests for #1332's gate-hook.mjs change — structured tool inputs are
 * forwarded to gate.cjs as JSON instead of being silently dropped.
 *
 * gate-hook.mjs previously forwarded ONLY string values from `tool_input`, so
 * an object-valued input was invisible to the gate. That blocked
 * check-before-done from reading `/verify`'s per-criterion verdict, which
 * #1328 stores in memory_store's `metadata` — an object.
 *
 * These run the real bin/gate-hook.mjs as a subprocess with a hook payload on
 * stdin, exactly as Claude Code invokes it, and use a stub gate.cjs that dumps
 * the TOOL_INPUT_* environment it received.
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

/**
 * Stand in for gate.cjs: print every TOOL_INPUT_* var it was handed. The hook
 * resolves `.claude/helpers/gate.cjs` under CLAUDE_PROJECT_DIR, so writing the
 * stub there intercepts the real call path rather than simulating it.
 */
const STUB_GATE = `
var out = {};
Object.keys(process.env).forEach(function (k) {
  if (k.indexOf('TOOL_INPUT_') === 0) out[k.slice('TOOL_INPUT_'.length)] = process.env[k];
});
process.stdout.write(JSON.stringify(out));
`;

function runHook(toolInput: unknown): Record<string, string> {
  const payload = JSON.stringify({ tool_name: 'mcp__moflo__memory_store', tool_input: toolInput });
  const stdout = execFileSync('node', [HOOK, 'record-verify-outcome'], {
    input: payload,
    env: { ...process.env as Record<string, string>, CLAUDE_PROJECT_DIR: tmpDir },
    encoding: 'utf-8',
    timeout: 30000,
    windowsHide: true,
  });
  return JSON.parse(stdout || '{}');
}

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-hook-1332-')));
  mkdirSync(join(tmpDir, '.claude', 'helpers'), { recursive: true });
  writeFileSync(join(tmpDir, '.claude', 'helpers', 'gate.cjs'), STUB_GATE);
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('#1332 gate-hook forwards structured tool inputs', () => {
  it('serialises an object-valued input to JSON', () => {
    const metadata = { type: 'verify-record', overall: 'FAIL', criteria: [{ id: 1, verdict: 'FAIL' }] };
    const env = runHook({ key: 'verify:1332', metadata });

    expect(env.metadata).toBeDefined();
    expect(JSON.parse(env.metadata)).toEqual(metadata);
  });

  it('still forwards string inputs unchanged', () => {
    const env = runHook({ key: 'verify:1332', value: 'PASS — prose summary' });
    expect(env.key).toBe('verify:1332');
    expect(env.value).toBe('PASS — prose summary');
  });

  it('does NOT cap string inputs — an oversized Bash command must still reach the gate', () => {
    // gate.cjs reads TOOL_INPUT_command; dropping a large heredoc command would
    // silently stop check-dangerous-command firing on the very inputs most
    // worth checking. Strings keep their pre-#1332 uncapped behaviour.
    const huge = 'x'.repeat(40000);
    const env = runHook({ command: huge });
    expect(env.command).toHaveLength(40000);
  });

  it('skips an oversized structured value rather than truncating it', () => {
    // A clipped JSON blob would parse as malformed downstream and read as a
    // corrupt record instead of an absent one. Windows also fails the spawn
    // outright past ~32KB per variable, so skipping is the safe direction.
    const env = runHook({ key: 'verify:1332', metadata: { blob: 'y'.repeat(20000) } });
    expect(env.metadata).toBeUndefined();
    expect(env.key).toBe('verify:1332'); // siblings still forwarded
  });

  it('forwards numbers and booleans as strings', () => {
    const env = runHook({ key: 'verify:1332', limit: 8, upsert: true });
    expect(env.limit).toBe('8');
    expect(env.upsert).toBe('true');
  });

  it('drops null without emitting the literal "null"', () => {
    const env = runHook({ key: 'verify:1332', metadata: null });
    expect(env.metadata).toBeUndefined();
  });

  it('serialises arrays too', () => {
    const env = runHook({ key: 'verify:1332', tags: ['verify', 'sdd'] });
    expect(JSON.parse(env.tags)).toEqual(['verify', 'sdd']);
  });
});
