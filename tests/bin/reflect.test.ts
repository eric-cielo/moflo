/**
 * Tests for auto-reflect pure logic (#1198) — bin/lib/reflect.mjs.
 *
 * Covers config read (default-OFF), headless guard, signal detection,
 * injection rate-limiting, <reflect-capture> tag extraction (incl. the
 * assistant-only transcript scrape that ignores the injected directive),
 * ledger round-trip + dedup + cap + mark-distilled, and the distill prompt.
 *
 * Cross-platform (Rule #1): temp dirs via path, Node fs only, no shell.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';

import {
  HAIKU_MODEL_ID,
  INJECT_WINDOW_MS,
  INJECT_MAX_PER_SESSION,
  MAX_LEDGER_ENTRIES,
  MAX_LESSON_CHARS,
  DURABILITY_BAR,
  readReflectConfig,
  isHeadless,
  detectSignal,
  recentTranscriptTurn,
  buildCaptureDirective,
  injectionAllowed,
  readReflectState,
  recordInjection,
  extractCaptureTags,
  extractCapturesFromTranscript,
  readLedger,
  pendingEntries,
  appendLedgerEntries,
  markLedgerDistilled,
  buildDistillPrompt,
} from '../../bin/lib/reflect.mjs';

function makeTempRoot(label: string): string {
  const root = resolve(
    __dirname,
    '../../.testoutput/.test-reflect-' + label + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(join(root, '.moflo'), { recursive: true });
  return root;
}
function cleanTempRoot(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows handle hold — non-fatal */ }
}

// ── Config (default ON, opt-out) ─────────────────────────────────────────────

describe('readReflectConfig', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot('cfg'); });
  afterEach(() => cleanTempRoot(root));

  it('defaults ON with no moflo.yaml (#1198 ships default-on)', () => {
    expect(readReflectConfig(root)).toEqual({ enabled: true });
  });

  it('defaults ON when the block is absent', () => {
    writeFileSync(resolve(root, 'moflo.yaml'), 'auto_update:\n  enabled: true\n');
    expect(readReflectConfig(root)).toEqual({ enabled: true });
  });

  it('parses an explicit enabled: true', () => {
    writeFileSync(resolve(root, 'moflo.yaml'), 'auto_reflect:\n  enabled: true\n');
    expect(readReflectConfig(root)).toEqual({ enabled: true });
  });

  it('opts out on an explicit enabled: false', () => {
    writeFileSync(resolve(root, 'moflo.yaml'), 'auto_reflect:\n  enabled: false\n');
    expect(readReflectConfig(root)).toEqual({ enabled: false });
  });
});

describe('isHeadless', () => {
  it('detects the headless env both forms', () => {
    expect(isHeadless({ CLAUDE_CODE_HEADLESS: 'true' })).toBe(true);
    expect(isHeadless({ CLAUDE_CODE_HEADLESS: '1' })).toBe(true);
    expect(isHeadless({})).toBe(false);
    expect(isHeadless({ CLAUDE_CODE_HEADLESS: 'false' })).toBe(false);
  });
});

// ── Signal detection ─────────────────────────────────────────────────────────

describe('detectSignal', () => {
  it('flags user corrections', () => {
    for (const p of [
      'No, that is wrong — use the daemon instead',
      "don't hardcode the port",
      'actually, revert that change',
      'why did you delete the test?',
      "that's not what I asked for",
    ]) {
      expect(detectSignal(p).kind).toBe('correction');
    }
  });

  it('flags explicit decisions (prompt or transcript)', () => {
    expect(detectSignal("let's go with the launcher approach").kind).toBe('decision');
    expect(detectSignal('neutral prompt', 'we decided to batch the writes').kind).toBe('decision');
  });

  it('flags error→fix from structured failure markers in the tail', () => {
    expect(detectSignal('ok continue', '{"is_error":true}').kind).toBe('error_fix');
    expect(detectSignal('ok', 'process exited with exit code 1').kind).toBe('error_fix');
    expect(detectSignal('ok', '3 failed, 10 passed').kind).toBe('error_fix');
  });

  it('does NOT fire on neutral prompts / benign "error" mentions', () => {
    expect(detectSignal('Please add a new endpoint for users').hit).toBe(false);
    // bare word "error" in prose must not trigger error_fix (tight markers only)
    expect(detectSignal('add better error handling to the parser').hit).toBe(false);
  });

  it('does NOT treat a "0 failed" SUCCESS line as error→fix ([1-9] guard)', () => {
    expect(detectSignal('ok', 'Total passed: 9138, 0 failed').hit).toBe(false);
    expect(detectSignal('ok', '9138 passed | 0 failed').hit).toBe(false);
    // a real non-zero failure still fires
    expect(detectSignal('ok', '3 failed, 10 passed').kind).toBe('error_fix');
  });

  it('precedence: correction beats decision beats error_fix', () => {
    expect(detectSignal("no, let's go with X", '{"is_error":true}').kind).toBe('correction');
  });
});

// ── Recent-turn scoping (stale-marker guard) ─────────────────────────────────

describe('recentTranscriptTurn', () => {
  it('returns only the text after the last user message', () => {
    const lines = [
      JSON.stringify({ message: { role: 'assistant', content: '3 failed earlier — STALE' } }),
      JSON.stringify({ message: { role: 'user', content: 'ok next thing' } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'all good, 0 failed' }] } }),
    ].join('\n') + '\n';
    const recent = recentTranscriptTurn(lines);
    expect(recent).toContain('all good, 0 failed');
    expect(recent).not.toContain('STALE');
  });

  it('scopes error detection so a stale failure before the last user turn does NOT fire', () => {
    const lines = [
      JSON.stringify({ message: { role: 'assistant', content: 'process exited with exit code 1' } }), // stale
      JSON.stringify({ message: { role: 'user', content: 'great, ship it' } }),
      JSON.stringify({ message: { role: 'assistant', content: 'done, everything green' } }),
    ].join('\n') + '\n';
    expect(detectSignal('great, ship it', recentTranscriptTurn(lines)).hit).toBe(false);
  });

  it('falls back to the whole tail when no user line is present', () => {
    const lines = JSON.stringify({ message: { role: 'assistant', content: 'exit code 1 here' } }) + '\n';
    expect(detectSignal('ok', recentTranscriptTurn(lines)).kind).toBe('error_fix');
  });
});

// ── Directive ────────────────────────────────────────────────────────────────

describe('buildCaptureDirective', () => {
  it('is answer-first and embeds the shared durability bar + the tag format', () => {
    const d = buildCaptureDirective('correction');
    expect(d).toContain('FIRST');
    expect(d).toContain('<reflect-capture>LESSON</reflect-capture>');
    expect(d).toContain(DURABILITY_BAR);
    expect(d).toContain('append nothing');
    expect(d).toContain('course-correction');
  });
});

// ── Rate-limiting ────────────────────────────────────────────────────────────

describe('injectionAllowed', () => {
  const now = 1_000_000;
  it('allows with no prior state', () => {
    expect(injectionAllowed(null, 's1', now)).toBe(true);
  });
  it('blocks a second fire inside the window (same session)', () => {
    expect(injectionAllowed({ sessionId: 's1', lastInjectMs: now - 1000, count: 1 }, 's1', now)).toBe(false);
  });
  it('allows again after the window elapses', () => {
    expect(injectionAllowed({ sessionId: 's1', lastInjectMs: now - INJECT_WINDOW_MS - 1, count: 1 }, 's1', now)).toBe(true);
  });
  it('blocks once the per-session cap is reached', () => {
    expect(injectionAllowed({ sessionId: 's1', lastInjectMs: now - INJECT_WINDOW_MS - 1, count: INJECT_MAX_PER_SESSION }, 's1', now)).toBe(false);
  });
  it('a new session resets the window + counter', () => {
    expect(injectionAllowed({ sessionId: 'old', lastInjectMs: now - 1, count: INJECT_MAX_PER_SESSION }, 'new', now)).toBe(true);
  });
});

describe('reflect state round-trip', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot('state'); });
  afterEach(() => cleanTempRoot(root));

  it('recordInjection persists and increments per-session count', () => {
    expect(readReflectState(root)).toBeNull();
    recordInjection(root, 's1', 100);
    let s = readReflectState(root);
    expect(s).toMatchObject({ sessionId: 's1', lastInjectMs: 100, count: 1 });
    recordInjection(root, 's1', 200, s);
    s = readReflectState(root);
    expect(s.count).toBe(2);
  });

  it('a new session resets count to 1', () => {
    recordInjection(root, 's1', 100);
    const prev = readReflectState(root);
    recordInjection(root, 's2', 200, prev);
    expect(readReflectState(root)).toMatchObject({ sessionId: 's2', count: 1 });
  });
});

// ── Tag extraction ───────────────────────────────────────────────────────────

describe('extractCaptureTags', () => {
  it('extracts one or many real lessons, bounded', () => {
    const text = 'answer\n<reflect-capture>For Windows spell steps, use node -e fs because mkdir is absent.</reflect-capture>';
    expect(extractCaptureTags(text)).toEqual(['For Windows spell steps, use node -e fs because mkdir is absent.']);
    const two = '<reflect-capture>Lesson one is long enough.</reflect-capture> mid <reflect-capture>Lesson two is also long.</reflect-capture>';
    expect(extractCaptureTags(two)).toHaveLength(2);
  });

  it('drops the directive placeholder, empties and fragments', () => {
    expect(extractCaptureTags('<reflect-capture>LESSON</reflect-capture>')).toEqual([]);
    expect(extractCaptureTags('<reflect-capture>   </reflect-capture>')).toEqual([]);
    expect(extractCaptureTags('<reflect-capture>none</reflect-capture>')).toEqual([]);
    expect(extractCaptureTags('<reflect-capture>tiny</reflect-capture>')).toEqual([]);
  });

  it('caps an over-long lesson', () => {
    const long = 'x'.repeat(MAX_LESSON_CHARS + 200);
    expect(extractCaptureTags(`<reflect-capture>${long}</reflect-capture>`)[0].length).toBe(MAX_LESSON_CHARS);
  });
});

describe('extractCapturesFromTranscript', () => {
  it('scrapes only assistant-role messages — ignores the injected directive', () => {
    const directive = buildCaptureDirective('correction'); // contains the example tag
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the thing\n' + directive } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.\n<reflect-capture>Route learnings writes through the daemon, never a raw db write.</reflect-capture>' }] } }),
    ];
    const got = extractCapturesFromTranscript(lines.join('\n') + '\n');
    expect(got).toEqual(['Route learnings writes through the daemon, never a raw db write.']);
  });

  it('tolerates a truncated leading JSONL line', () => {
    const good = JSON.stringify({ message: { role: 'assistant', content: 'x\n<reflect-capture>A genuinely durable captured lesson here.</reflect-capture>' } });
    const tail = '{"partial": "cut off mid li\n' + good + '\n';
    expect(extractCapturesFromTranscript(tail)).toHaveLength(1);
  });
});

// ── Ledger ───────────────────────────────────────────────────────────────────

describe('ledger', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot('ledger'); });
  afterEach(() => cleanTempRoot(root));

  it('append → read round-trips and dedups identical lessons', () => {
    expect(appendLedgerEntries(root, [{ lesson: 'Lesson alpha is durable here.', kind: 'correction', sessionId: 's1' }])).toBe(1);
    // identical lesson (re-scraped from an overlapping tail) is skipped
    expect(appendLedgerEntries(root, [{ lesson: 'Lesson alpha is durable here.', kind: 'correction', sessionId: 's1' }])).toBe(0);
    const led = readLedger(root);
    expect(led.entries).toHaveLength(1);
    expect(pendingEntries(led)).toHaveLength(1);
    expect(led.entries[0]).toMatchObject({ kind: 'correction', sessionId: 's1', distilled: false });
    expect(typeof led.entries[0].id).toBe('string');
  });

  it('skips fragments shorter than the floor', () => {
    expect(appendLedgerEntries(root, [{ lesson: 'short' }])).toBe(0);
  });

  it('markLedgerDistilled flips only the given ids; new captures survive', () => {
    appendLedgerEntries(root, [{ lesson: 'First durable lesson here.' }]);
    const led = readLedger(root);
    const id = led.entries[0].id;
    appendLedgerEntries(root, [{ lesson: 'Second durable lesson here.' }]);
    expect(markLedgerDistilled(root, [id])).toBe(1);
    const after = readLedger(root);
    expect(after.entries.find((e: any) => e.id === id).distilled).toBe(true);
    // the second, captured "during" the run, stays pending
    expect(pendingEntries(after)).toHaveLength(1);
    expect(pendingEntries(after)[0].lesson).toContain('Second');
  });

  it('readLedger tolerates absent + malformed files', () => {
    expect(readLedger(root)).toEqual({ entries: [] });
    writeFileSync(resolve(root, '.moflo', 'reflect-ledger.json'), '{ not json');
    expect(readLedger(root)).toEqual({ entries: [] });
  });

  it('caps the ledger at MAX_LEDGER_ENTRIES', () => {
    const many = Array.from({ length: MAX_LEDGER_ENTRIES + 25 }, (_, i) => ({ lesson: `Durable distinct lesson number ${i} here.` }));
    appendLedgerEntries(root, many);
    expect(readLedger(root).entries.length).toBeLessThanOrEqual(MAX_LEDGER_ENTRIES);
  });
});

// ── Distill prompt ───────────────────────────────────────────────────────────

describe('buildDistillPrompt', () => {
  it('reuses the /reflect protocol, numbers candidates, and embeds the bar', () => {
    const p = buildDistillPrompt([{ lesson: 'Alpha lesson.' }, { lesson: 'Beta lesson.' }]);
    expect(p).toContain('1. Alpha lesson.');
    expect(p).toContain('2. Beta lesson.');
    expect(p).toContain('mcp__moflo__memory_search');
    expect(p).toContain('mcp__moflo__memory_store');
    expect(p).toContain('>= 0.80');
    expect(p).toContain(DURABILITY_BAR);
  });
});

describe('exported constants', () => {
  it('Haiku model id is the cheap formatter model', () => {
    expect(HAIKU_MODEL_ID).toBe('claude-haiku-4-5-20251001');
  });
});
