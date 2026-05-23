/**
 * End-to-end tests for the auto-reflect capture hook (#1198) —
 * bin/reflect-capture.mjs (`detect` = UserPromptSubmit, `scrape` = Stop).
 *
 * Driven as a subprocess with JSON on stdin, matching how Claude Code invokes
 * hooks. Verifies the opt-out + headless guards, signal-gated injection,
 * rate-limiting, and the assistant-only tag scrape into the ledger.
 *
 * Cross-platform (Rule #1): temp dirs via path, spawnSync arg arrays, no shell.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';

import { readLedger } from '../../bin/lib/reflect.mjs';

const CAPTURE_SCRIPT = resolve(__dirname, '../../bin/reflect-capture.mjs');

function makeTempRoot(label: string): string {
  const root = resolve(
    __dirname,
    '../../.testoutput/.test-reflectcap-' + label + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(join(root, '.moflo'), { recursive: true });
  return root;
}
function cleanTempRoot(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows handle hold */ }
}
function enable(root: string) {
  writeFileSync(resolve(root, 'moflo.yaml'), 'auto_reflect:\n  enabled: true\n', 'utf-8');
}
function disable(root: string) {
  writeFileSync(resolve(root, 'moflo.yaml'), 'auto_reflect:\n  enabled: false\n', 'utf-8');
}
function writeTranscript(root: string, events: object[]): string {
  const p = resolve(root, 'transcript.jsonl');
  writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  return p;
}
function run(root: string, sub: 'detect' | 'scrape', input: object, extraEnv: Record<string, string> = {}) {
  const argv = sub === 'detect' ? 'reflect-detect' : 'reflect-scrape';
  return spawnSync('node', [CAPTURE_SCRIPT, argv], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 20_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...extraEnv },
  });
}

describe('reflect-capture detect (UserPromptSubmit)', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot('detect'); });
  afterEach(() => cleanTempRoot(root));

  it('injects an answer-first directive on a correction (when enabled)', () => {
    enable(root);
    const r = run(root, 'detect', { session_id: 's1', prompt: 'No, that is wrong — use the daemon instead' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[auto-reflect]');
    expect(r.stdout).toContain('<reflect-capture>');
    expect(r.stdout).toContain('FIRST');
  });

  it('is silent when explicitly disabled (enabled: false)', () => {
    disable(root);
    const r = run(root, 'detect', { session_id: 's1', prompt: 'No, that is wrong, do it differently' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('is silent under CLAUDE_CODE_HEADLESS even when enabled (#860 guard)', () => {
    enable(root);
    const r = run(root, 'detect', { session_id: 's1', prompt: "no, that's wrong" }, { CLAUDE_CODE_HEADLESS: 'true' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('is silent on a neutral prompt', () => {
    enable(root);
    const r = run(root, 'detect', { session_id: 's1', prompt: 'Please add a new users endpoint' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('rate-limits a second fire within the window (same session)', () => {
    enable(root);
    const first = run(root, 'detect', { session_id: 's1', prompt: "no, that's wrong" });
    expect(first.stdout).toContain('[auto-reflect]');
    const second = run(root, 'detect', { session_id: 's1', prompt: "no, still wrong" });
    expect(second.stdout.trim()).toBe('');
  });

  it('detects error→fix from the transcript tail', () => {
    enable(root);
    const transcript = writeTranscript(root, [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_result', text: 'process exited with exit code 1' }] } },
    ]);
    const r = run(root, 'detect', { session_id: 's1', prompt: 'ok keep going', transcript_path: transcript });
    expect(r.stdout).toContain('[auto-reflect]');
    expect(r.stdout).toContain('error-then-fix');
  });
});

describe('reflect-capture scrape (Stop)', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot('scrape'); });
  afterEach(() => cleanTempRoot(root));

  it('appends an assistant <reflect-capture> tag to the ledger (when enabled)', () => {
    enable(root);
    const transcript = writeTranscript(root, [
      { type: 'user', message: { role: 'user', content: 'do it' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.\n<reflect-capture>Route learnings writes through the daemon, never a raw db write.</reflect-capture>' }] } },
    ]);
    const r = run(root, 'scrape', { session_id: 's1', transcript_path: transcript });
    expect(r.status).toBe(0);
    const led = readLedger(root);
    expect(led.entries).toHaveLength(1);
    expect(led.entries[0].lesson).toContain('Route learnings writes through the daemon');
    expect(led.entries[0].distilled).toBe(false);
  });

  it('does NOT scrape the injected directive (user-role context only carries the example tag)', () => {
    enable(root);
    // Simulate the directive having ridden in as user/context, with no real assistant capture.
    const transcript = writeTranscript(root, [
      { type: 'user', message: { role: 'user', content: 'fix it\n<reflect-capture>LESSON</reflect-capture>' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed it, no durable lesson here.' }] } },
    ]);
    const r = run(root, 'scrape', { session_id: 's1', transcript_path: transcript });
    expect(r.status).toBe(0);
    expect(readLedger(root).entries).toHaveLength(0);
  });

  it('is silent + writes nothing when explicitly disabled (enabled: false)', () => {
    disable(root);
    const transcript = writeTranscript(root, [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '<reflect-capture>A durable lesson that should not be stored.</reflect-capture>' }] } },
    ]);
    const r = run(root, 'scrape', { session_id: 's1', transcript_path: transcript });
    expect(r.status).toBe(0);
    expect(readLedger(root).entries).toHaveLength(0);
  });

  it('is silent under CLAUDE_CODE_HEADLESS even when enabled (#860 guard)', () => {
    enable(root);
    const transcript = writeTranscript(root, [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '<reflect-capture>A durable lesson captured in a headless run.</reflect-capture>' }] } },
    ]);
    const r = run(root, 'scrape', { session_id: 's1', transcript_path: transcript }, { CLAUDE_CODE_HEADLESS: 'true' });
    expect(r.status).toBe(0);
    expect(readLedger(root).entries).toHaveLength(0);
  });
});
