/**
 * Tests for the Claude Stats aggregator (#1044).
 *
 * Drive the JSONL streaming aggregator against a real on-disk tmpdir of
 * fixture transcripts. The time-bucketing, model canonicalisation, and
 * tool/error extraction logic is what's at risk of regression — exercise
 * each end-to-end rather than mocking out fs and re-implementing the loop.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetClaudeStatsCache,
  aggregateClaudeStats,
  canonicalModelKey,
  encodeCwdForClaudeProjects,
} from '../../services/claude-stats.js';

// ============================================================================
// Helpers
// ============================================================================

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AssistantLineOpts {
  ts: string;
  sessionId: string;
  model: string;
  usage: UsageBlock;
  toolName?: string;
}

function assistantLine(o: AssistantLineOpts): string {
  const content: object[] = [{ type: 'text', text: 'hi' }];
  if (o.toolName) content.push({ type: 'tool_use', name: o.toolName });
  return JSON.stringify({
    type: 'assistant',
    timestamp: o.ts,
    sessionId: o.sessionId,
    message: { role: 'assistant', model: o.model, content, usage: o.usage },
  });
}

function toolErrorLine(ts: string, sessionId: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    sessionId,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', is_error: true }],
    },
  });
}

let dir: string;

beforeEach(() => {
  _resetClaudeStatsCache();
  dir = mkdtempSync(join(tmpdir(), 'moflo-claude-stats-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// Path encoding
// ============================================================================

describe('encodeCwdForClaudeProjects', () => {
  it('encodes Windows-style CWDs to the dashed form Claude Code uses', () => {
    expect(encodeCwdForClaudeProjects('C:\\Users\\eric\\Projects\\moflo'))
      .toBe('C--Users-eric-Projects-moflo');
  });

  it('encodes POSIX-style CWDs', () => {
    expect(encodeCwdForClaudeProjects('/Users/alice/proj/moflo'))
      .toBe('-Users-alice-proj-moflo');
  });

  // Issue #1048: every non-alphanumeric character in the cwd must collapse
  // to a dash, matching Claude Code's own directory naming.
  it('replaces underscores, dots, plus, and spaces with dashes', () => {
    expect(encodeCwdForClaudeProjects('/Users/me/dev/some_project'))
      .toBe('-Users-me-dev-some-project');
    expect(encodeCwdForClaudeProjects('C:\\Users\\me\\foo.bar'))
      .toBe('C--Users-me-foo-bar');
    expect(encodeCwdForClaudeProjects('/var/lib/app+v2'))
      .toBe('-var-lib-app-v2');
    expect(encodeCwdForClaudeProjects('/path with space/x'))
      .toBe('-path-with-space-x');
  });

  it('leaves an all-alphanumeric CWD untouched', () => {
    expect(encodeCwdForClaudeProjects('alphaOnly42')).toBe('alphaOnly42');
  });
});

// ============================================================================
// Model name canonicalisation
// ============================================================================

describe('canonicalModelKey', () => {
  it('maps dated/dotted model names to canonical keys', () => {
    expect(canonicalModelKey('claude-opus-4-7')).toBe('opus');
    expect(canonicalModelKey('claude-3-5-sonnet-20241022')).toBe('sonnet');
    expect(canonicalModelKey('haiku-4-5')).toBe('haiku');
    expect(canonicalModelKey('Opus')).toBe('opus');
    expect(canonicalModelKey('made-up-model')).toBe('unknown');
    expect(canonicalModelKey(undefined)).toBe('unknown');
  });
});

// ============================================================================
// Aggregation
// ============================================================================

describe('aggregateClaudeStats', () => {
  it('returns the all-zero unavailable shape when the project dir is empty', async () => {
    const stats = await aggregateClaudeStats('cwd-ignored', { projectDir: dir });
    expect(stats.available).toBe(false);
    expect(stats.totalSessions).toBe(0);
    expect(stats.windows.lifetime.tokens.total).toBe(0);
  });

  it('returns the all-zero unavailable shape when the dir does not exist', async () => {
    const stats = await aggregateClaudeStats('cwd', { projectDir: join(dir, 'no-such') });
    expect(stats.available).toBe(false);
  });

  it('parses a single assistant line and surfaces token totals', async () => {
    writeFileSync(
      join(dir, 'session-a.jsonl'),
      assistantLine({
        ts: '2026-05-09T12:00:00Z',
        sessionId: 'A',
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 500,
        },
      }),
    );

    const stats = await aggregateClaudeStats('cwd', {
      projectDir: dir,
      now: Date.parse('2026-05-09T12:30:00Z'),
    });

    expect(stats.available).toBe(true);
    expect(stats.totalSessions).toBe(1);
    expect(stats.windows.lifetime.tokens.input).toBe(100);
    expect(stats.windows.lifetime.tokens.output).toBe(50);
    expect(stats.windows.lifetime.tokens.cacheCreate).toBe(1000);
    expect(stats.windows.lifetime.tokens.cacheRead).toBe(500);
    expect(stats.windows.lifetime.tokens.total).toBe(1650);
  });

  it('buckets tokens correctly across today / 7d / 30d / lifetime', async () => {
    const now = Date.parse('2026-05-09T12:00:00Z');
    const within24h = new Date(now - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    const within7d = new Date(now - 5 * 86_400_000).toISOString();
    const within30d = new Date(now - 20 * 86_400_000).toISOString();
    const beyond30d = new Date(now - 100 * 86_400_000).toISOString();

    const lines = [
      assistantLine({ ts: within24h, sessionId: 'today', model: 'opus', usage: { input_tokens: 1 } }),
      assistantLine({ ts: within7d, sessionId: 'week', model: 'opus', usage: { input_tokens: 2 } }),
      assistantLine({ ts: within30d, sessionId: 'month', model: 'opus', usage: { input_tokens: 4 } }),
      assistantLine({ ts: beyond30d, sessionId: 'old', model: 'opus', usage: { input_tokens: 8 } }),
    ];
    writeFileSync(join(dir, 'multi.jsonl'), lines.join('\n'));

    const stats = await aggregateClaudeStats('cwd', { projectDir: dir, now });

    expect(stats.windows.today.tokens.input).toBe(1);
    expect(stats.windows.last7d.tokens.input).toBe(1 + 2);
    expect(stats.windows.last30d.tokens.input).toBe(1 + 2 + 4);
    expect(stats.windows.lifetime.tokens.input).toBe(1 + 2 + 4 + 8);
    expect(stats.windows.lifetime.sessions).toBe(4);
    expect(stats.windows.last30d.sessions).toBe(3);
  });

  it('skips lines with no usage block (user/system/etc)', async () => {
    const ts = '2026-05-09T12:00:00Z';
    const lines = [
      JSON.stringify({ type: 'permission-mode', sessionId: 'x', timestamp: ts }),
      JSON.stringify({ type: 'user', timestamp: ts, sessionId: 'x', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      assistantLine({ ts, sessionId: 'x', model: 'opus', usage: { input_tokens: 7 } }),
    ];
    writeFileSync(join(dir, 'mixed.jsonl'), lines.join('\n'));

    const stats = await aggregateClaudeStats('cwd', { projectDir: dir });
    expect(stats.windows.lifetime.tokens.input).toBe(7);
    expect(stats.parseErrors).toBe(0);
  });

  it('counts malformed lines as parseErrors without throwing', async () => {
    const ts = '2026-05-09T12:00:00Z';
    const lines = [
      '{ this is not json',
      assistantLine({ ts, sessionId: 'a', model: 'sonnet', usage: { input_tokens: 1 } }),
      'also { broken',
    ];
    writeFileSync(join(dir, 'broken.jsonl'), lines.join('\n'));

    const stats = await aggregateClaudeStats('cwd', { projectDir: dir });
    expect(stats.parseErrors).toBe(2);
    expect(stats.windows.lifetime.tokens.input).toBe(1);
  });

  it('aggregates the model distribution sorted by tokens desc', async () => {
    const ts = '2026-05-09T12:00:00Z';
    const lines = [
      assistantLine({ ts, sessionId: 'a', model: 'haiku', usage: { input_tokens: 1 } }),
      assistantLine({ ts, sessionId: 'a', model: 'opus', usage: { input_tokens: 100 } }),
      assistantLine({ ts, sessionId: 'b', model: 'sonnet', usage: { input_tokens: 10 } }),
      assistantLine({ ts, sessionId: 'b', model: 'opus', usage: { input_tokens: 50 } }),
    ];
    writeFileSync(join(dir, 'models.jsonl'), lines.join('\n'));

    const stats = await aggregateClaudeStats('cwd', { projectDir: dir });
    expect(stats.models[0].model).toBe('opus');
    expect(stats.models[0].tokens).toBe(150);
    expect(stats.models[0].messages).toBe(2);
    expect(stats.models[1].model).toBe('sonnet');
    expect(stats.models[2].model).toBe('haiku');
  });

  it('captures top tools and counts each tool_use block', async () => {
    const ts = '2026-05-09T12:00:00Z';
    const lines = [
      assistantLine({ ts, sessionId: 'a', model: 'opus', usage: { input_tokens: 1 }, toolName: 'Read' }),
      assistantLine({ ts, sessionId: 'a', model: 'opus', usage: { input_tokens: 1 }, toolName: 'Read' }),
      assistantLine({ ts, sessionId: 'a', model: 'opus', usage: { input_tokens: 1 }, toolName: 'Bash' }),
    ];
    writeFileSync(join(dir, 'tools.jsonl'), lines.join('\n'));

    const stats = await aggregateClaudeStats('cwd', { projectDir: dir });
    const byName = Object.fromEntries(stats.tools.map(t => [t.name, t.count]));
    expect(byName.Read).toBe(2);
    expect(byName.Bash).toBe(1);
  });

  it('marks sessions with tool_result errors and counts only distinct sessions', async () => {
    const ts = '2026-05-09T12:00:00Z';
    const lines = [
      assistantLine({ ts, sessionId: 'happy', model: 'opus', usage: { input_tokens: 1 } }),
      assistantLine({ ts, sessionId: 'sad', model: 'opus', usage: { input_tokens: 1 } }),
      toolErrorLine(ts, 'sad'),
      toolErrorLine(ts, 'sad'), // second error on same session — still 1
    ];
    writeFileSync(join(dir, 'errors.jsonl'), lines.join('\n'));

    const stats = await aggregateClaudeStats('cwd', { projectDir: dir });
    expect(stats.errorSessions).toBe(1);
    expect(stats.totalSessions).toBe(2);
  });

  it('computes session duration from first/last timestamp per session', async () => {
    const lines = [
      assistantLine({ ts: '2026-05-09T12:00:00Z', sessionId: 's1', model: 'opus', usage: { input_tokens: 1 } }),
      assistantLine({ ts: '2026-05-09T12:30:00Z', sessionId: 's1', model: 'opus', usage: { input_tokens: 1 } }),
      assistantLine({ ts: '2026-05-09T11:00:00Z', sessionId: 's2', model: 'opus', usage: { input_tokens: 1 } }),
      assistantLine({ ts: '2026-05-09T11:10:00Z', sessionId: 's2', model: 'opus', usage: { input_tokens: 1 } }),
    ];
    writeFileSync(join(dir, 'durations.jsonl'), lines.join('\n'));

    const stats = await aggregateClaudeStats('cwd', { projectDir: dir });
    // Two durations: 30min + 10min. Median (lower-of-2 by Math.floor) = 30min.
    expect(stats.sessionDurationMs.median).toBe(30 * 60 * 1000);
    expect(stats.sessionDurationMs.p95).toBe(30 * 60 * 1000);
  });

  it('caches results for repeat calls within TTL', async () => {
    writeFileSync(
      join(dir, 'cache.jsonl'),
      assistantLine({ ts: '2026-05-09T12:00:00Z', sessionId: 'A', model: 'opus', usage: { input_tokens: 1 } }),
    );

    const first = await aggregateClaudeStats('cwd', { projectDir: dir });
    const second = await aggregateClaudeStats('cwd', { projectDir: dir });
    // Same object reference proves the cache short-circuited.
    expect(second).toBe(first);

    const fresh = await aggregateClaudeStats('cwd', { projectDir: dir, skipCache: true });
    // Fresh aggregation produces a structurally identical but distinct object.
    expect(fresh).not.toBe(first);
    expect(fresh.windows.lifetime.tokens.input).toBe(first.windows.lifetime.tokens.input);
  });
});
