/**
 * #1397 (Epic #1392) — prompt-hook.mjs must forward Claude Code's session_id.
 *
 * `prompt-reminder` stamps `HOOK_SESSION_ID` onto `.claude/workflow-state.json`
 * (gate.cjs), and `readStampedSessionId()` in `flo runs start` has no other
 * source for it. But `prompt-reminder` is invoked through prompt-hook.mjs, NOT
 * gate-hook.mjs — and only gate-hook.mjs forwarded the id. So the stamp never
 * happened, every `flo runs` record carried `sessionId: null`, and its token
 * rollup was permanently zero (unrecoverable once Claude Code prunes the
 * transcript ~2 days later).
 *
 * This is the #879-shaped asymmetry — wrapper forwards, direct invocation
 * doesn't — so the test drives the real script end-to-end rather than asserting
 * on its source text.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '..', '..');
const BIN_HOOK = join(REPO_ROOT, 'bin', 'prompt-hook.mjs');
const HELPERS_HOOK = join(REPO_ROOT, '.claude', 'helpers', 'prompt-hook.mjs');

/**
 * Drive prompt-hook.mjs against a throwaway project whose `.claude/helpers/
 * gate.cjs` is a stub that simply dumps the env vars it received. That isolates
 * the one behaviour under test — what the wrapper puts in the child env —
 * without dragging the real gate's state machine in.
 */
function runPromptHook(payload: Record<string, unknown>): Record<string, string> {
  const projectDir = mkdtempSync(join(tmpdir(), 'moflo-1397-'));
  mkdirSync(join(projectDir, '.claude', 'helpers'), { recursive: true });
  writeFileSync(
    join(projectDir, '.claude', 'helpers', 'gate.cjs'),
    // Report both vars so an absent id is distinguishable from an empty one.
    'process.stdout.write(JSON.stringify({\n' +
    '  HOOK_SESSION_ID: process.env.HOOK_SESSION_ID === undefined ? "<unset>" : process.env.HOOK_SESSION_ID,\n' +
    '  CLAUDE_USER_PROMPT: process.env.CLAUDE_USER_PROMPT === undefined ? "<unset>" : process.env.CLAUDE_USER_PROMPT,\n' +
    '}));\n',
  );

  const out = execFileSync(process.execPath, [BIN_HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    timeout: 20000,
  });

  return JSON.parse(out.trim());
}

describe('#1397 — prompt-hook forwards session_id to gate.cjs', () => {
  it('sets HOOK_SESSION_ID from the stdin payload', () => {
    const env = runPromptHook({ session_id: 'sess-abc-123', prompt: 'hello' });
    expect(env.HOOK_SESSION_ID).toBe('sess-abc-123');
  });

  it('still forwards the user prompt (no regression to the existing var)', () => {
    const env = runPromptHook({ session_id: 'sess-abc-123', prompt: 'hello' });
    expect(env.CLAUDE_USER_PROMPT).toBe('hello');
  });

  it('leaves HOOK_SESSION_ID unset when the host sends no session_id', () => {
    // Outside Claude Code this is the correct outcome — `flo runs` records a
    // null sessionId and a zeroed rollup by design, which must not become an
    // empty-string id that reads as "stamped".
    const env = runPromptHook({ prompt: 'hello' });
    expect(env.HOOK_SESSION_ID).toBe('<unset>');
  });

  it('leaves HOOK_SESSION_ID unset for a non-string or empty session_id', () => {
    expect(runPromptHook({ session_id: '', prompt: 'x' }).HOOK_SESSION_ID).toBe('<unset>');
    expect(runPromptHook({ session_id: 12345, prompt: 'x' }).HOOK_SESSION_ID).toBe('<unset>');
  });
});

describe('#1397 — the copy a consumer runs stays in sync', () => {
  it('bin/prompt-hook.mjs and .claude/helpers/prompt-hook.mjs are byte-identical', () => {
    // `.claude/helpers/` is what actually executes; bin/ is the sync source
    // (binHelperFiles in bin/lib/shipped-scripts.json).
    expect(readFileSync(HELPERS_HOOK, 'utf-8')).toBe(readFileSync(BIN_HOOK, 'utf-8'));
  });

  it('prompt-hook.mjs is in the shipped manifest, so an upgrade delivers it', () => {
    // The upgrade path for this fix IS the manifest entry: existing consumers
    // get the regenerated file from the session-start launcher's version-change
    // sync, with no `flo init` re-run. Without this entry the fix would reach
    // fresh installs only.
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'bin', 'lib', 'shipped-scripts.json'), 'utf-8'),
    ) as { binHelperFiles: string[] };
    expect(manifest.binHelperFiles).toContain('prompt-hook.mjs');
  });

  it('the flo-init generator emits the forwarding too (fresh installs)', async () => {
    const { generatePromptHookScript } = await import(
      join(REPO_ROOT, 'dist', 'src', 'cli', 'init', 'helpers-generator.js')
    );
    const generated: string = generatePromptHookScript();
    expect(generated).toContain('HOOK_SESSION_ID');
    expect(generated).toContain("typeof hookContext.session_id === 'string'");
  });
});
