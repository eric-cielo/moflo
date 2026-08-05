/**
 * Tests for per-run token attribution (#1333).
 *
 * The unit under test answers "what did THIS run cost", so the cases that
 * matter are the ones where a naive sum would over-attribute: usage outside the
 * run's window, usage from another session, and usage on lines that carry no
 * timestamp to place them by.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeRunTokens,
  emptyRunTokenRollup,
} from '../../services/run-token-rollup.js';

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'moflo-rollup-'));
});

afterEach(() => {
  try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** One assistant line carrying usage, stamped at `iso`. */
function usageLine(
  iso: string,
  usage: Partial<Record<'input_tokens' | 'output_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens', number>>,
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: iso,
    sessionId: SESSION,
    message: { role: 'assistant', model: 'claude-opus-5', usage },
  });
}

function writeTranscript(sessionId: string, lines: string[], eol = '\n'): void {
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), lines.join(eol) + eol, 'utf-8');
}

function writeSubagentTranscript(sessionId: string, name: string, lines: string[]): void {
  const dir = join(projectDir, sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonl`), lines.join('\n') + '\n', 'utf-8');
}

const T0 = Date.parse('2026-08-04T10:00:00.000Z');
const MIN = 60_000;

describe('computeRunTokens', () => {
  it('sums only the usage inside the run window', async () => {
    writeTranscript(SESSION, [
      usageLine('2026-08-04T09:59:00.000Z', { input_tokens: 999 }),   // before
      usageLine('2026-08-04T10:01:00.000Z', { input_tokens: 10, output_tokens: 5 }),
      usageLine('2026-08-04T10:02:00.000Z', { cache_read_input_tokens: 7 }),
      usageLine('2026-08-04T10:30:00.000Z', { input_tokens: 888 }),   // after
    ]);

    const r = await computeRunTokens(process.cwd(), {
      projectDir, sessionId: SESSION, fromMs: T0, toMs: T0 + 5 * MIN,
    });

    expect(r.input).toBe(10);
    expect(r.output).toBe(5);
    expect(r.cacheRead).toBe(7);
    expect(r.total).toBe(22);
    expect(r.messages).toBe(2);
  });

  it('includes subagent transcripts — Task-tool spend is part of the run cost', async () => {
    writeTranscript(SESSION, [usageLine('2026-08-04T10:01:00.000Z', { input_tokens: 100 })]);
    writeSubagentTranscript(SESSION, 'agent-reviewer', [
      usageLine('2026-08-04T10:02:00.000Z', { output_tokens: 40 }),
    ]);

    const r = await computeRunTokens(process.cwd(), {
      projectDir, sessionId: SESSION, fromMs: T0, toMs: T0 + 5 * MIN,
    });

    expect(r.total).toBe(140);
    expect(r.transcripts).toBe(2);
  });

  it('ignores another session entirely', async () => {
    writeTranscript('other-session', [
      usageLine('2026-08-04T10:01:00.000Z', { input_tokens: 500 }),
    ]);

    const r = await computeRunTokens(process.cwd(), {
      projectDir, sessionId: SESSION, fromMs: T0, toMs: T0 + 5 * MIN,
    });

    expect(r).toEqual(emptyRunTokenRollup());
  });

  it('reports transcripts: 0 when the transcript has been pruned', async () => {
    // Distinguishing "cost nothing" from "could not be measured" is the whole
    // point of the field — a pruned transcript must not read as a free run.
    const r = await computeRunTokens(process.cwd(), {
      projectDir, sessionId: SESSION, fromMs: T0, toMs: T0 + 5 * MIN,
    });

    expect(r.total).toBe(0);
    expect(r.transcripts).toBe(0);
  });

  it('drops usage lines with no parseable timestamp rather than guessing', async () => {
    writeTranscript(SESSION, [
      JSON.stringify({
        type: 'assistant',
        sessionId: SESSION,
        message: { usage: { input_tokens: 4242 } },
      }),
    ]);

    const r = await computeRunTokens(process.cwd(), {
      projectDir, sessionId: SESSION, fromMs: T0, toMs: T0 + 5 * MIN,
    });

    expect(r.total).toBe(0);
    expect(r.messages).toBe(0);
  });

  it('ignores non-assistant lines that mention usage', async () => {
    writeTranscript(SESSION, [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-04T10:01:00.000Z',
        sessionId: SESSION,
        message: { usage: { input_tokens: 777 } },
      }),
      usageLine('2026-08-04T10:01:30.000Z', { input_tokens: 3 }),
    ]);

    const r = await computeRunTokens(process.cwd(), {
      projectDir, sessionId: SESSION, fromMs: T0, toMs: T0 + 5 * MIN,
    });

    expect(r.total).toBe(3);
  });

  it('tolerates a CRLF transcript (Rule #1)', async () => {
    writeTranscript(SESSION, [
      usageLine('2026-08-04T10:01:00.000Z', { input_tokens: 11 }),
      usageLine('2026-08-04T10:02:00.000Z', { output_tokens: 22 }),
    ], '\r\n');

    const r = await computeRunTokens(process.cwd(), {
      projectDir, sessionId: SESSION, fromMs: T0, toMs: T0 + 5 * MIN,
    });

    expect(r.total).toBe(33);
  });

  it('counts malformed lines without losing the valid ones', async () => {
    writeTranscript(SESSION, [
      '{"usage": not json',
      usageLine('2026-08-04T10:01:00.000Z', { input_tokens: 9 }),
    ]);

    const r = await computeRunTokens(process.cwd(), {
      projectDir, sessionId: SESSION, fromMs: T0, toMs: T0 + 5 * MIN,
    });

    expect(r.total).toBe(9);
    expect(r.parseErrors).toBe(1);
  });

  it('returns the empty rollup for an inverted or missing window', async () => {
    writeTranscript(SESSION, [usageLine('2026-08-04T10:01:00.000Z', { input_tokens: 5 })]);

    const inverted = await computeRunTokens(process.cwd(), {
      projectDir, sessionId: SESSION, fromMs: T0 + 5 * MIN, toMs: T0,
    });
    expect(inverted).toEqual(emptyRunTokenRollup());

    const noSession = await computeRunTokens(process.cwd(), {
      projectDir, sessionId: '', fromMs: T0, toMs: T0 + 5 * MIN,
    });
    expect(noSession).toEqual(emptyRunTokenRollup());
  });

  it('treats window bounds as inclusive', async () => {
    writeTranscript(SESSION, [
      usageLine(new Date(T0).toISOString(), { input_tokens: 1 }),
      usageLine(new Date(T0 + MIN).toISOString(), { input_tokens: 2 }),
    ]);

    const r = await computeRunTokens(process.cwd(), {
      projectDir, sessionId: SESSION, fromMs: T0, toMs: T0 + MIN,
    });

    expect(r.total).toBe(3);
  });
});
