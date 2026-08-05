/**
 * Tests for `flo runs start|finalize|show` (#1333).
 *
 * The behaviour under test is the ledger contract: one code path owns the
 * `flo-*` record, finalize snapshots token cost into THAT record (not a
 * parallel store), and a run whose cost cannot be measured says so rather than
 * reporting zero as if it were a measurement.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from '../../types.js';

const SESSION = '11111111-2222-3333-4444-555555555555';

/** In-memory stand-in for the shared accessor: records every write. */
const writes: Array<{ namespace: string; key: string; value: unknown }> = [];
const store = new Map<string, unknown>();

vi.mock('../../services/daemon-dashboard.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/daemon-dashboard.js')>(
    '../../services/daemon-dashboard.js',
  );
  return {
    ...actual,
    // Only the accessor is faked — buildFloRunContext and storeFloRunRecord
    // stay real, so these specs exercise the shipped record shape.
    getSharedMemoryAccessor: async () => ({
      async read(namespace: string, key: string) {
        return store.get(`${namespace}::${key}`) ?? null;
      },
      async write(namespace: string, key: string, value: unknown) {
        // Mirrors createDashboardMemoryAccessor in the detail that bites:
        // `write` JSON-stringifies and `read` hands the RAW STRING back
        // unparsed (only its `search` path parses). An object-in/object-out
        // double let a broken `finalize` pass every spec here — dogfooding
        // caught it, not the suite. Keep the asymmetry.
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        writes.push({ namespace, key, value: JSON.parse(serialized) });
        store.set(`${namespace}::${key}`, serialized);
      },
      async search() { return []; },
    }),
  };
});

const { runsCommand, readStampedSessionId } = await import('../../commands/runs.js');
const { _resetStateRootCacheForTest } = await import('../../services/project-root.js');

let root: string;
const ORIGINAL_PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR;

function ctx(args: string[], flags: Record<string, string | boolean> = {}): CommandContext {
  return { args, flags: { _: [], ...flags }, cwd: root, interactive: false };
}

function stampSession(sessionId: string): void {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'workflow-state.json'),
    JSON.stringify({ interactionCount: 3, sessionId }),
    'utf-8',
  );
}

beforeEach(() => {
  writes.length = 0;
  store.clear();
  // realpath: macOS hands back /var/folders/... while resolveStateRoot
  // canonicalizes to /private/var/folders/... (see CLAUDE.md Rule #1 / #1145).
  root = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-run-cmd-')));
  process.env.CLAUDE_PROJECT_DIR = root;
  _resetStateRootCacheForTest();
});

afterEach(() => {
  if (ORIGINAL_PROJECT_DIR === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
  _resetStateRootCacheForTest();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('readStampedSessionId', () => {
  it('reads the id gate.cjs stamps on UserPromptSubmit', () => {
    stampSession(SESSION);
    expect(readStampedSessionId(root)).toBe(SESSION);
  });

  it('returns null when there is no state file or no id in it', () => {
    expect(readStampedSessionId(root)).toBeNull();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'workflow-state.json'), '{"interactionCount":1}', 'utf-8');
    expect(readStampedSessionId(root)).toBeNull();
  });

  it('returns null on a corrupt state file rather than throwing', () => {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'workflow-state.json'), '{not json', 'utf-8');
    expect(readStampedSessionId(root)).toBeNull();
  });
});

describe('flo runs start', () => {
  it('writes one running record to tasklist, keyed by a derived run id', async () => {
    stampSession(SESSION);
    const result = await runsCommand.action(
      ctx(['start'], { issue: '1333', title: 'Join tokens to runs' }),
    );

    expect(result.success).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].namespace).toBe('tasklist');
    expect(writes[0].key).toMatch(/^flo-1333-\d+$/);

    const record = writes[0].value as Record<string, unknown>;
    expect(record.status).toBe('running');
    expect(record.sessionId).toBe(SESSION);
    expect((record.context as { issueNumber: number }).issueNumber).toBe(1333);
    expect((record.context as { label: string }).label).toBe('#1333 — Join tokens to runs');
  });

  it('honours an explicit --run-id and --started-at', async () => {
    await runsCommand.action(
      ctx(['start'], { issue: '7', title: 'x', runId: 'flo-7-42', startedAt: '42' }),
    );
    expect(writes[0].key).toBe('flo-7-42');
    expect((writes[0].value as { startedAt: number }).startedAt).toBe(42);
  });

  it('records no sessionId when none is stamped — nothing to attribute against', async () => {
    await runsCommand.action(ctx(['start'], { issue: '9', title: 'y' }));
    expect((writes[0].value as Record<string, unknown>).sessionId).toBeUndefined();
  });

  it('reads flags under the camelCase key the parser emits AND the declared kebab name', async () => {
    // parser.ts:normalizeKey rewrites `--session-id` to `sessionId` before the
    // command runs, so a lookup on the declared kebab name alone silently misses
    // every multi-word flag — the CLI accepted `--session-id` and recorded null
    // while the specs, written in kebab, passed. Pin both shapes so neither the
    // parser's contract nor the fallback can rot unnoticed.
    await runsCommand.action(
      ctx(['start'], { issue: '1', title: 'camel', runId: 'flo-camel', sessionId: 'sess-camel' }),
    );
    expect(writes[0].key).toBe('flo-camel');
    expect((writes[0].value as { sessionId: string }).sessionId).toBe('sess-camel');

    writes.length = 0;
    await runsCommand.action(
      ctx(['start'], { issue: '1', title: 'kebab', 'run-id': 'flo-kebab', 'session-id': 'sess-kebab' }),
    );
    expect(writes[0].key).toBe('flo-kebab');
    expect((writes[0].value as { sessionId: string }).sessionId).toBe('sess-kebab');
  });

  it('builds a research context under --research', async () => {
    await runsCommand.action(ctx(['start'], { issue: '5', title: 'z', research: true }));
    expect((writes[0].value as { context: { type: string } }).context.type).toBe('research');
  });
});

describe('flo runs finalize', () => {
  async function startRun(): Promise<string> {
    stampSession(SESSION);
    await runsCommand.action(
      ctx(['start'], { issue: '1333', title: 'Join tokens', runId: 'flo-1333-1000', startedAt: '1000' }),
    );
    writes.length = 0;
    return 'flo-1333-1000';
  }

  it('writes the token rollup into the SAME tasklist record — no parallel store', async () => {
    const runId = await startRun();
    const result = await runsCommand.action(ctx(['finalize'], { runId: runId }));

    expect(result.success).toBe(true);
    // Exactly one write, to the same namespace and key the run already had.
    // This is what makes the rollup inherit the 200-row tasklist trim rather
    // than needing orphan handling of its own.
    expect(writes).toHaveLength(1);
    expect(writes[0].namespace).toBe('tasklist');
    expect(writes[0].key).toBe(runId);

    const record = writes[0].value as Record<string, unknown>;
    expect(record.status).toBe('completed');
    expect(record.success).toBe(true);
    expect(record.tokens).toBeDefined();
  });

  it('preserves the context and startedAt from the running record', async () => {
    const runId = await startRun();
    await runsCommand.action(ctx(['finalize'], { runId: runId, endedAt: '5000' }));

    const record = writes[0].value as Record<string, unknown>;
    expect((record.context as { issueNumber: number }).issueNumber).toBe(1333);
    expect(record.startedAt).toBe(1000);
    expect(record.duration).toBe(4000);
  });

  it('records a zeroed rollup with transcripts: 0 when the transcript is absent', async () => {
    const runId = await startRun();
    await runsCommand.action(ctx(['finalize'], { runId: runId }));

    const tokens = (writes[0].value as { tokens: Record<string, number> }).tokens;
    expect(tokens.total).toBe(0);
    // Not a measurement of zero cost — a statement that nothing was measurable.
    expect(tokens.transcripts).toBe(0);
  });

  it('marks a failed run without claiming a verified outcome', async () => {
    const runId = await startRun();
    await runsCommand.action(
      ctx(['finalize'], { runId: runId, status: 'failed', error: 'tests red' }),
    );

    const record = writes[0].value as Record<string, unknown>;
    expect(record.status).toBe('failed');
    expect(record.success).toBe(false);
    expect(record.error).toBe('tests red');
    // The record must not carry anything that reads as external verification
    // (#1322 — no exit-code signal exists to back such a claim).
    expect(Object.keys(record)).not.toContain('verified');
    expect(Object.keys(record)).not.toContain('verifiedOutcome');
  });

  it('fails loudly when the run was never started', async () => {
    const result = await runsCommand.action(ctx(['finalize'], { runId: 'flo-does-not-exist' }));
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(writes).toHaveLength(0);
  });

  it('rejects a status outside completed|failed', async () => {
    const runId = await startRun();
    const result = await runsCommand.action(ctx(['finalize'], { runId: runId, status: 'running' }));
    expect(result.success).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('requires --run-id', async () => {
    const result = await runsCommand.action(ctx(['finalize']));
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});

describe('flo runs show', () => {
  it('prints the stored record', async () => {
    await runsCommand.action(ctx(['start'], { issue: '3', title: 'q', runId: 'flo-3-1' }));
    const result = await runsCommand.action(ctx(['show'], { runId: 'flo-3-1' }));
    expect(result.success).toBe(true);
    expect((result.data as { status: string }).status).toBe('running');
  });

  it('fails for an unknown id', async () => {
    const result = await runsCommand.action(ctx(['show'], { runId: 'nope' }));
    expect(result.success).toBe(false);
  });
});

describe('flo runs <unknown>', () => {
  it('rejects an unknown subcommand', async () => {
    const result = await runsCommand.action(ctx(['wibble']));
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});
