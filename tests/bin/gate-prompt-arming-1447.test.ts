/**
 * #1447 — the memory gate's per-prompt arming.
 *
 * Two UserPromptSubmit hooks share `workflow-state.json`: `prompt-hook.mjs`
 * (→ gate.cjs prompt-reminder) and `gate-hook.mjs prompt-state-reset`, wired as
 * a defensive safety-net so a throw in the first cannot skip the reset.
 *
 * `gate-hook.mjs` never forwarded the `prompt` field, so the safety-net
 * classified the EMPTY STRING on every prompt, concluded "no memory required",
 * and wrote that over the value the first hook had just computed correctly. The
 * memory gate therefore fired or didn't depending on which hook wrote last —
 * which is why it felt like it had stopped catching mid-session topic changes.
 *
 * Nothing tested the two hooks TOGETHER, which is exactly why the interaction
 * regressed unseen. These tests run them the way settings.json wires them, in
 * both orders.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

const BIN = resolve(__dirname, '../../bin');

let tmpDir: string;
let helpersDir: string;

function makeTmpProject(): string {
  const dir = resolve(tmpdir(), `moflo-1447-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  helpersDir = join(dir, '.claude', 'helpers');
  mkdirSync(helpersDir, { recursive: true });
  // The bridges resolve gate.cjs out of the project's own .claude/helpers/,
  // the way a consumer install does.
  for (const f of ['gate.cjs', 'gate-hook.mjs', 'prompt-hook.mjs']) {
    copyFileSync(join(BIN, f), join(helpersDir, f));
  }
  return dir;
}

/** Run one UserPromptSubmit hook exactly as Claude Code invokes it. */
function submitPrompt(script: string, args: string[], prompt: string): void {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CLAUDE_PROJECT_DIR: tmpDir };
  // An inherited value from the outer session would mask the very bug under test.
  for (const k of ['CLAUDE_USER_PROMPT', 'TOOL_INPUT_command', 'HOOK_SESSION_ID', 'HOOK_TRANSCRIPT_PATH']) {
    delete env[k];
  }
  spawnSync('node', [join(helpersDir, script), ...args], {
    input: JSON.stringify({ prompt, hook_event_name: 'UserPromptSubmit', session_id: 'main' }),
    env, encoding: 'utf-8', timeout: 30000,
  });
}

const primary = (prompt: string) => submitPrompt('prompt-hook.mjs', [], prompt);
const safetyNet = (prompt: string) => submitPrompt('gate-hook.mjs', ['prompt-state-reset'], prompt);

/** Run a gate case directly, with no prompt in the environment at all. */
function runGateDirect(gateCase: string): void {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CLAUDE_PROJECT_DIR: tmpDir };
  delete env.CLAUDE_USER_PROMPT;
  spawnSync('node', [join(helpersDir, 'gate.cjs'), gateCase], { env, encoding: 'utf-8', timeout: 30000 });
}

function readState(): Record<string, unknown> {
  const f = join(tmpDir, '.claude', 'workflow-state.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : {};
}
function writeState(state: Record<string, unknown>): void {
  writeFileSync(join(tmpDir, '.claude', 'workflow-state.json'), JSON.stringify(state, null, 2));
}

beforeEach(() => { tmpDir = makeTmpProject(); });
afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

describe('#1447 — the safety-net hook must not disarm the gate', () => {
  const TASK_PROMPT = 'now investigate why the swarm coordinator drops agents under load';

  it('the safety-net arms the gate on its own (it can see the prompt)', () => {
    writeState({ memoryRequired: false, memorySearched: true });
    safetyNet(TASK_PROMPT);
    expect(readState().memoryRequired).toBe(true);
  });

  it('leaves the gate armed when it runs AFTER the primary hook', () => {
    writeState({ memoryRequired: false, memorySearched: true });
    primary(TASK_PROMPT);
    expect(readState().memoryRequired).toBe(true);
    safetyNet(TASK_PROMPT);
    expect(readState().memoryRequired).toBe(true);
  });

  it('leaves the gate armed when it runs BEFORE the primary hook', () => {
    writeState({ memoryRequired: false, memorySearched: true });
    safetyNet(TASK_PROMPT);
    primary(TASK_PROMPT);
    expect(readState().memoryRequired).toBe(true);
  });

  it('both hooks clear the searched latch, so the new prompt needs its own search', () => {
    writeState({ memoryRequired: false, memorySearched: true, memorySearchedBy: { 'sub-A': true } });
    primary(TASK_PROMPT);
    safetyNet(TASK_PROMPT);
    const s = readState();
    expect(s.memorySearched).toBe(false);
    expect(s.memorySearchedBy).toEqual({});
  });

  it('a safety-net that cannot see the prompt does not DECIDE arming', () => {
    // Defence in depth: if the forwarding ever breaks again (a host that omits
    // the field, a payload change), the hook must not silently disarm what the
    // primary hook decided from text it actually had.
    writeState({ memoryRequired: true, memorySearched: false });
    runGateDirect('prompt-state-reset');
    expect(readState().memoryRequired).toBe(true);
  });

  it('…but still invalidates the credits, which needs no prompt', () => {
    // Skipping the reset wholesale would be its own bug: a stale per-actor
    // credit from the PREVIOUS prompt would satisfy the gate for a prompt
    // nothing ever classified.
    writeState({
      memoryRequired: true,
      memorySearched: true,
      memorySearchedBy: { 'sub-A': true },
    });
    runGateDirect('prompt-state-reset');
    const s = readState();
    expect(s.memorySearched).toBe(false);
    expect(s.memorySearchedBy).toEqual({});
    expect(s.memoryRequired, 'arming is left to the hook that has the text').toBe(true);
  });
});

describe('#1447 — arm by default, exempt only continuations', () => {
  // The old rule was `TASK_RE.test(p) || p.length > 20`, an invisible cliff:
  // "now look at the daemon" (22 chars) armed and "check the daemon" (16) did
  // not. Subject-bearing prompts arm regardless of length; filler does not.
  const arms: Array<[string, string]> = [
    ['check the daemon', 'short, no task word — the old cliff dropped this'],
    ['and the indexer?', 'very short pivot'],
    ['what about the statusline', 'short question pivot'],
    ['now look at the daemon', 'the 22-char case that used to arm'],
    ['always consider rule #1 and dogfooding', 'mid-session steer'],
    ['fix the daemon', 'short WITH a task word'],
    ['now investigate why the swarm coordinator drops agents', 'long investigative pivot'],
    ['yes, now fix the daemon', 'assent FOLLOWED by a real subject'],
    ['ok but check the launcher first', 'assent plus a subject'],
    ['/fl 1445', 'a moflo ticket run — the most task-shaped prompt there is'],
    // Non-Latin scripts. Stripping `[^A-Za-z0-9]` would erase these entirely
    // and score a substantive request as pure filler — the dangerous direction,
    // and a whole class of prompts rather than an edge case.
    ['修复认证漏洞', 'Chinese — fix the auth vulnerability'],
    ['почему падает демон', 'Russian — why is the daemon crashing'],
    ['なぜデーモンが落ちるのか', 'Japanese — why does the daemon die'],
    ['pourquoi le démon échoue-t-il', 'French, accented'],
    ['revisá el índice de búsqueda', 'Spanish, accented'],
  ];

  for (const [prompt, label] of arms) {
    it(`arms: ${label} — ${JSON.stringify(prompt)}`, () => {
      writeState({ memoryRequired: false, memorySearched: true });
      primary(prompt);
      expect(readState().memoryRequired).toBe(true);
    });
  }

  const exempt: Array<[string, string]> = [
    ['yes', 'bare assent'],
    ['ok', 'bare ack'],
    ['sure', 'assent'],
    ['go ahead', 'continuation'],
    ['continue', 'continuation'],
    ['keep going', 'continuation'],
    ['do it', 'continuation'],
    ['next', 'continuation'],
    ['thanks', 'acknowledgement'],
    ['thank you', 'acknowledgement'],
    ['sounds good', 'assent'],
    ['yes please', 'assent'],
    ['ok, go ahead.', 'assent with punctuation'],
    ['@@ just read this file', 'the @@ escape hatch'],
    // The old rule exempted EVERY prompt of <=20 chars without a task word.
    // Most of what that caught was trivia like this, and the inverted rule has
    // to keep catching it — a gate that fires on "hmm" is a gate people turn
    // off. These are the shapes that would otherwise regress.
    ['hmm', 'hesitation'],
    ['wait', 'interjection'],
    ['hold on', 'interjection'],
    ['got it', 'acknowledgement'],
    ['makes sense', 'acknowledgement'],
    ['nice work', 'praise'],
    ['great, thanks', 'praise + thanks'],
    ['perfect!', 'praise with punctuation'],
    ['oops', 'interjection'],
    ['never mind', 'retraction'],
    ['nvm', 'retraction, abbreviated'],
    ['lol', 'filler'],
    ['sorry', 'filler'],
    ['let me think', 'filler'],
    ['ok do that', 'assent + anaphora, no subject of its own'],
    ['yes please continue', 'stacked assent'],
    ['👍', 'emoji only — no letters or digits at all'],
    ['?', 'punctuation only'],
    ['...', 'ellipsis only'],
  ];

  for (const [prompt, label] of exempt) {
    it(`does NOT arm: ${label} — ${JSON.stringify(prompt)}`, () => {
      writeState({ memoryRequired: true, memorySearched: false });
      primary(prompt);
      expect(readState().memoryRequired).toBe(false);
    });
  }

  it('both UserPromptSubmit hooks agree on every shape', () => {
    // They share applyPromptStateReset, but only if both actually classify the
    // same text — the #1447 bug was precisely that they did not.
    for (const [prompt] of [...arms, ...exempt]) {
      writeState({ memoryRequired: false, memorySearched: true });
      primary(prompt);
      const viaPrimary = readState().memoryRequired;

      writeState({ memoryRequired: false, memorySearched: true });
      safetyNet(prompt);
      const viaSafetyNet = readState().memoryRequired;

      expect({ prompt, armed: viaSafetyNet }).toEqual({ prompt, armed: viaPrimary });
    }
  });
});
