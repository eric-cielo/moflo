/**
 * Both write surfaces refuse captured tool-call markup (#1467).
 *
 * The ticket asks for the CLI and the MCP tool explicitly, because they are
 * separate entry points and fixing one leaves half the writes exposed. They
 * turn out to share a chokepoint — both call `storeEntry` — so what this file
 * pins is that each surface actually REACHES it and reports the refusal in its
 * own idiom: a non-zero exit for the CLI, `success: false` for MCP. A guard
 * that a surface swallows into a cheerful `{stored: true}` is the failure this
 * fix exists to end.
 *
 * Real store, real registered command, real tool handler — no stubs, so a
 * surface that stopped calling `storeEntry` would turn this red.
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { output } from '../../output.js';
import { openDaemonDatabase } from '../../memory/daemon-backend.js';
import { memoryCommand } from '../../commands/memory.js';
import { memoryTools } from '../../mcp-tools/memory-tools.js';
import type { Command, CommandContext } from '../../types.js';

/** The exact shape reported in #1467. */
const CORRUPT = 'the actual lesson text.",\n    <parameter name="tags">["a","b","source:manual"]';

let tmp: string;
let dbPath: string;

const storeCommand = memoryCommand.subcommands?.find((c) => c.name === 'store') as Command;
const memoryStore = memoryTools.find((t) => t.name === 'memory_store')!;

function ctx(flags: Record<string, unknown>): CommandContext {
  return { args: [], flags: { _: [], ...flags } as CommandContext['flags'], cwd: tmp, interactive: false };
}

/** Rows actually on disk for `key`, whatever their status. */
function rowsFor(key: string): number {
  if (!fs.existsSync(dbPath)) return 0;
  const db = openDaemonDatabase(dbPath);
  try {
    const res = db.exec(`SELECT COUNT(*) FROM memory_entries WHERE key = ?`, [key]);
    return Number(res[0]?.values?.[0]?.[0] ?? 0);
  } catch {
    return 0; // no table yet — nothing was written, which is the assertion
  } finally {
    db.close();
  }
}

beforeAll(() => {
  // realpath: os.tmpdir() is a symlink into /private/var on macOS and the root
  // resolver follows it, so an unresolved root would not match (Rule #1).
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-1467-')));
  fs.mkdirSync(path.join(tmp, '.moflo'), { recursive: true });
  dbPath = path.join(tmp, '.moflo', 'moflo.db');
  process.env.CLAUDE_PROJECT_DIR = tmp;
  process.env.MOFLO_DISABLE_DAEMON_ROUTING = '1';
});

afterAll(() => {
  delete process.env.CLAUDE_PROJECT_DIR;
  delete process.env.MOFLO_DISABLE_DAEMON_ROUTING;
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch { /* Windows file lock — non-fatal */ }
});

beforeEach(() => {
  delete process.env.MOFLO_ALLOW_TOOL_CALL_MARKUP;
});

describe('flo memory store (#1467)', () => {
  it('fails with a non-zero exit and writes no row', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(output, 'printError').mockImplementation((m: string) => { errors.push(m); });
    try {
      const result = await storeCommand.action!(ctx({ key: 'cli-corrupt', value: CORRUPT, namespace: 'learnings' }));
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('tool-call markup');
    } finally {
      spy.mockRestore();
    }
    expect(rowsFor('cli-corrupt')).toBe(0);
  });
});

describe('mcp memory_store (#1467)', () => {
  it('returns success:false, stored:false, and writes no row', async () => {
    const result = await memoryStore.handler({
      key: 'mcp-corrupt',
      value: CORRUPT,
      namespace: 'learnings',
    }) as { success: boolean; stored: boolean; error?: string };

    expect(result.success).toBe(false);
    // `stored` is what a caller actually reads; #1467's entries all arrived
    // under a cheerful `{success: true, stored: true}`.
    expect(result.stored).toBe(false);
    expect(result.error).toContain('tool-call markup');
    expect(rowsFor('mcp-corrupt')).toBe(0);
  });

  it('still stores a value that merely discusses the markup', async () => {
    const lesson = [
      'A memory value can arrive carrying `<parameter name="tags">` or a stray',
      '`</value>` from the harness that wrote it. Reject those at the store, but',
      'anchor the detector to the trailing position — a bare marker match rejects',
      'this very lesson, and a rule that cannot describe itself is not usable.',
    ].join('\n');

    const result = await memoryStore.handler({
      key: 'mcp-lesson-about-1467',
      value: lesson,
      namespace: 'learnings',
    }) as { success: boolean; stored: boolean; error?: string };

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(rowsFor('mcp-lesson-about-1467')).toBe(1);
  });
});
