/**
 * `flo memory audit-learnings` end-to-end against a real store (#1466).
 *
 * Covers the halves the pure-module tests cannot: that the default run writes
 * nothing, that a verdict is requested only for the mechanically nominated
 * entries, that `--apply` archives rather than deletes and the archived rows
 * really do leave every read surface, and that an immediate re-run is quiet.
 *
 * The model call is exercised through the same node-stub seam
 * `bin/meditate-distill.mjs` uses, so the spawn path is real (argument array,
 * no shell) on all three platforms without a Claude CLI on PATH — Rule #1.
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { output } from '../../output.js';
import { openDaemonDatabase } from '../../memory/daemon-backend.js';
import { getNamespaceCounts, listEntries, searchEntries } from '../../memory/entries-read.js';
import { getLearningsOverview } from '../../memory/learnings-overview.js';
import { syncHnswSidecar } from '../../memory/hnsw-persistence.js';
import { hasMemoryEntriesTable } from '../../services/cherry-pick-learnings.js';
import {
  auditLearningsCommand,
  AUDIT_STATE_FILE,
  JUDGE_STUB_ENV,
  readAuditState,
} from '../../commands/memory-audit-learnings.js';
import { CommandParser } from '../../parser.js';
import type { CommandContext } from '../../types.js';

const DAY = 24 * 60 * 60 * 1000;
const DIM = 8;

/**
 * A stub Claude CLI. Reads the prompt off argv, echoes the keys it was asked
 * about into a log file so a test can assert exactly what was sent, and answers
 * with a verdict chosen by the key's own name.
 */
const STUB_SOURCE = `
const fs = require('fs');
let prompt = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  const keys = [];
  for (const line of prompt.split('\\n')) {
    const m = /^### \\d+\\. (.+)$/.exec(line.trim());
    if (m) keys.push(m[1]);
  }
  const logPath = process.env.MOFLO_AUDIT_TEST_LOG;
  if (logPath) {
    fs.writeFileSync(logPath, JSON.stringify({
      keys,
      promptLength: prompt.length,
      // Recorded so a test can prove the prompt never rode on the command line.
      argv: process.argv.slice(2),
    }), 'utf-8');
  }
  const verdictFor = (k) =>
    k.includes('retire') ? 'RETIRE'
    : k.includes('merge') ? 'MERGE'
    : k.includes('compress') ? 'COMPRESS'
    : 'KEEP';
  process.stdout.write(keys.map((k) => k + '\\t' + verdictFor(k) + '\\treason for ' + k).join('\\n'));
});
`;

interface SeedRow {
  key: string;
  content?: string;
  embedding?: number[];
  updatedAt?: number;
  accessCount?: number;
}

let tmp: string;
let dbPath: string;
let stubPath: string;
let judgeLog: string;
let written: string[];
let now: number;

/** A unit vector rotated by `angle`, padded to DIM — dials cosine similarity. */
function vec(angle: number): number[] {
  const v = new Array(DIM).fill(0);
  v[0] = Math.cos(angle);
  v[1] = Math.sin(angle);
  return v;
}

function seed(rows: SeedRow[]): void {
  const db = openDaemonDatabase(dbPath);
  try {
    db.run(`CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY, key TEXT NOT NULL, namespace TEXT DEFAULT 'default',
      content TEXT NOT NULL, type TEXT DEFAULT 'semantic',
      embedding TEXT, embedding_model TEXT, embedding_dimensions INTEGER,
      tags TEXT, metadata TEXT, owner_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      expires_at INTEGER, last_accessed_at INTEGER,
      access_count INTEGER DEFAULT 0, status TEXT DEFAULT 'active',
      UNIQUE(namespace, key)
    )`);
    for (const r of rows) {
      const updatedAt = r.updatedAt ?? now - 300 * DAY;
      db.run(
        `INSERT OR REPLACE INTO memory_entries
           (id, key, namespace, content, embedding, embedding_model, embedding_dimensions,
            created_at, updated_at, access_count, status)
         VALUES (?, ?, 'learnings', ?, ?, 'local', ?, ?, ?, ?, 'active')`,
        [
          `id-${r.key}`,
          r.key,
          r.content ?? `body for ${r.key}`,
          r.embedding ? JSON.stringify(r.embedding) : null,
          r.embedding ? DIM : null,
          updatedAt,
          updatedAt,
          r.accessCount ?? 0,
        ],
      );
    }
  } finally {
    db.close();
  }
}

function ctx(flags: Record<string, unknown> = {}): CommandContext {
  return { args: [], flags: { _: [], ...flags } as CommandContext['flags'], cwd: tmp, interactive: false };
}

function statusOf(key: string): string | null {
  const db = openDaemonDatabase(dbPath);
  try {
    const res = db.exec(`SELECT status FROM memory_entries WHERE key = ? AND namespace = 'learnings'`, [key]);
    const value = res[0]?.values?.[0]?.[0];
    return value == null ? null : String(value);
  } finally {
    db.close();
  }
}

/**
 * ONE project root for the whole file, cleared between cases.
 *
 * The write path is `deleteEntry`, which resolves the store through a
 * process-wide bridge singleton that pins to the first project it sees — the
 * same shape production runs in, one project per process. A fresh temp root per
 * test would leave every case after the first writing into the first case's
 * database. Truncating the table per test gives the same isolation without
 * fighting a singleton that is correct for its actual environment.
 */
beforeAll(() => {
  // realpath: on macOS os.tmpdir() is a symlink into /private/var and
  // findProjectRoot resolves it, so an unresolved root would not match (Rule #1).
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-1466-')));
  fs.mkdirSync(path.join(tmp, '.moflo'), { recursive: true });
  dbPath = path.join(tmp, '.moflo', 'moflo.db');

  stubPath = path.join(tmp, 'judge-stub.cjs');
  fs.writeFileSync(stubPath, STUB_SOURCE, 'utf-8');
  judgeLog = path.join(tmp, 'judge-log.json');

  process.env.CLAUDE_PROJECT_DIR = tmp;
  process.env.MOFLO_AUDIT_TEST_LOG = judgeLog;
  process.env.MOFLO_DISABLE_DAEMON_ROUTING = '1';
});

afterAll(() => {
  delete process.env.CLAUDE_PROJECT_DIR;
  delete process.env[JUDGE_STUB_ENV];
  delete process.env.MOFLO_AUDIT_TEST_LOG;
  delete process.env.MOFLO_DISABLE_DAEMON_ROUTING;
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* best-effort — Windows can hold a brief handle */
  }
});

beforeEach(() => {
  now = Date.now();
  process.env[JUDGE_STUB_ENV] = stubPath;

  const db = openDaemonDatabase(dbPath);
  try {
    if (hasMemoryEntriesTable(db)) db.run('DELETE FROM memory_entries');
  } finally {
    db.close();
  }
  for (const stale of [AUDIT_STATE_FILE, 'hnsw.index', 'hnsw.manifest.json']) {
    fs.rmSync(path.join(tmp, '.moflo', stale), { force: true });
  }
  fs.rmSync(judgeLog, { force: true });

  written = [];
  vi.spyOn(output, 'writeln').mockImplementation((text = '') => { written.push(String(text)); });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('flo memory audit-learnings (#1466)', () => {
  it('is dry by default and prints per-bucket counts', async () => {
    seed([
      { key: 'dup-old-retire', embedding: vec(0), updatedAt: now - 5 * DAY, accessCount: 2 },
      { key: 'dup-new', embedding: vec(0.01), updatedAt: now, accessCount: 2 },
      { key: 'stale-retire', updatedAt: now - 300 * DAY, accessCount: 0 },
    ]);

    const result = await auditLearningsCommand.action(ctx());
    const printed = written.join('\n');

    expect(result.success).toBe(true);
    expect(printed).toContain('DRY RUN');
    expect(printed).toContain('Near-duplicate');
    expect(printed).toContain('Unused and old');
    expect(printed).toContain('Superseded vocabulary');

    const data = result.data as { dryRun: boolean; counts: Record<string, number> };
    expect(data.dryRun).toBe(true);
    expect(data.counts.duplicate).toBe(1);
    expect(data.counts.unused).toBe(1);
    expect(data.counts.superseded).toBe(0);

    // The whole point of "dry": nothing moved, even though the judge said RETIRE.
    expect(statusOf('dup-old-retire')).toBe('active');
    expect(statusOf('stale-retire')).toBe('active');
  });

  it('sends only the mechanically nominated entries to the judge, and reports how many', async () => {
    seed([
      { key: 'dup-old-retire', embedding: vec(0), updatedAt: now - 5 * DAY, accessCount: 2 },
      { key: 'dup-new', embedding: vec(0.01), updatedAt: now, accessCount: 2 },
      { key: 'healthy', updatedAt: now - DAY, accessCount: 9 },
    ]);

    const result = await auditLearningsCommand.action(ctx());

    const sent = JSON.parse(fs.readFileSync(judgeLog, 'utf-8')) as { keys: string[] };
    expect(sent.keys).toEqual(['dup-old-retire']);
    // Neither the cluster's surviving statement nor an unflagged entry costs tokens.
    expect(sent.keys).not.toContain('dup-new');
    expect(sent.keys).not.toContain('healthy');

    const data = result.data as { judged: number; nominated: number };
    expect(data.judged).toBe(1);
    expect(data.nominated).toBe(1);
  });

  it('makes no model call at all when nothing is nominated', async () => {
    seed([{ key: 'healthy', updatedAt: now - DAY, accessCount: 9 }]);

    const result = await auditLearningsCommand.action(ctx());

    expect(fs.existsSync(judgeLog)).toBe(false);
    expect((result.data as { judged: number }).judged).toBe(0);
  });

  it('reports a skipped judgement distinctly from a judgement that found nothing', async () => {
    seed([{ key: 'stale-retire', updatedAt: now - 300 * DAY, accessCount: 0 }]);

    const result = await auditLearningsCommand.action(ctx({ judge: false }));

    expect(fs.existsSync(judgeLog)).toBe(false);
    const data = result.data as { judged: number; judgeSkipped: boolean; nominated: number };
    expect(data.judged).toBe(0);
    expect(data.judgeSkipped).toBe(true);
    expect(data.nominated).toBe(1);
  });

  it('--apply archives rather than deletes, and archived rows leave every read surface', async () => {
    seed([
      { key: 'stale-retire', content: 'a lesson about a migration that finished', updatedAt: now - 300 * DAY, embedding: vec(0.9) },
      { key: 'keeper', content: 'a footgun that still exists', updatedAt: now - DAY, accessCount: 5, embedding: vec(2.0) },
    ]);

    const before = await syncHnswSidecar(dbPath, tmp, { dimensions: DIM });
    expect(before.vectorCount).toBe(2);

    const result = await auditLearningsCommand.action(ctx({ apply: true, force: true }));

    expect((result.data as { archived: number }).archived).toBe(1);

    // Archived, NOT deleted: the row survives so #1463's reconciler can emit a
    // tombstone from it instead of the entry being re-imported at session start.
    expect(statusOf('stale-retire')).toBe('archived');
    expect(statusOf('keeper')).toBe('active');

    const listed = await listEntries({ namespace: 'learnings', dbPath, limit: 50 });
    expect(listed.entries.map((e) => e.key)).toEqual(['keeper']);

    const counts = await getNamespaceCounts(dbPath);
    expect(counts.namespaces.learnings).toBe(1);

    const overview = await getLearningsOverview({ dbPath });
    expect(overview.total).toBe(1);
    expect(overview.recent.map((r) => r.key)).toEqual(['keeper']);

    // The search index is the fourth surface: the archived entry's vector is
    // gone, so a semantic search cannot reach it either.
    const after = await syncHnswSidecar(dbPath, tmp, { dimensions: DIM });
    expect(after.vectorCount).toBe(1);

    // And the search API itself. `threshold: -1` keeps the assertion about
    // presence rather than about how the seeded vectors happen to score — the
    // keeper coming back is what makes the archived entry's absence meaningful.
    const found = await searchEntries({
      query: 'a lesson about a migration that finished',
      namespace: 'learnings',
      dbPath,
      limit: 50,
      threshold: -1,
    });
    const hits = found.results.map((r) => r.key);
    expect(hits).toContain('keeper');
    expect(hits).not.toContain('stale-retire');
  }, 120_000);

  it('clusters on stored vectors only — never re-embeds on the default path', async () => {
    // Byte-identical content with no stored vectors. A pass that generated
    // embeddings would score these 1.0 and nominate one; reading the column
    // means it sees nothing to compare.
    seed([
      { key: 'twin-a', content: 'exactly the same words', updatedAt: now - DAY, accessCount: 5 },
      { key: 'twin-b', content: 'exactly the same words', updatedAt: now - 2 * DAY, accessCount: 5 },
      { key: 'dup-old-retire', content: 'unrelated', embedding: vec(0), updatedAt: now - 5 * DAY, accessCount: 5 },
      { key: 'dup-new', content: 'unrelated too', embedding: vec(0.01), updatedAt: now, accessCount: 5 },
    ]);

    const result = await auditLearningsCommand.action(ctx());
    const data = result.data as { counts: Record<string, number>; examined: number };

    // Only the vector-carrying pair clusters.
    expect(data.counts.duplicate).toBe(1);
    expect(data.examined).toBe(4);
    expect(written.join('\n')).toContain('have no stored vector');
  });

  it('sends the prompt over stdin, never on the command line', async () => {
    // ~36 KB at default settings. As a single argv element that is past
    // Windows' 32,767-char CreateProcess limit, so the judge would fail on
    // Windows only — at DEFAULT settings (Rule #1).
    seed(
      Array.from({ length: 40 }, (_, i) => ({
        key: `stale-keep-${i}`,
        content: 'x'.repeat(600),
        updatedAt: now - (300 + i) * DAY,
        accessCount: 0,
      })),
    );

    await auditLearningsCommand.action(ctx({ unusedLimit: 40 }));

    const sent = JSON.parse(fs.readFileSync(judgeLog, 'utf-8')) as {
      keys: string[]; promptLength: number; argv: string[];
    };
    expect(sent.keys.length).toBe(40);
    expect(sent.promptLength).toBeGreaterThan(10_000);
    for (const arg of sent.argv) expect(arg.length).toBeLessThan(200);
  });

  it('never archives a MERGE verdict — nothing here performs the merge', async () => {
    seed([
      { key: 'dup-old-merge', embedding: vec(0), updatedAt: now - 5 * DAY, accessCount: 2 },
      { key: 'dup-new', embedding: vec(0.01), updatedAt: now, accessCount: 2 },
    ]);

    const result = await auditLearningsCommand.action(ctx({ apply: true, force: true }));

    expect((result.data as { archived: number }).archived).toBe(0);
    expect(statusOf('dup-old-merge')).toBe('active');
    expect(written.join('\n')).toContain('MERGE into dup-new');
  });

  it('never archives every statement of a rule at once', async () => {
    // Both the cluster survivor and its restatement are old and unused, so the
    // unused pass nominates the survivor too and the judge answers RETIRE for
    // both. Archiving on that would leave the rule with no statement at all.
    seed([
      { key: 'survivor-retire', embedding: vec(0), updatedAt: now - 300 * DAY, accessCount: 0 },
      { key: 'restatement-retire', embedding: vec(0.01), updatedAt: now - 400 * DAY, accessCount: 0 },
    ]);

    const result = await auditLearningsCommand.action(ctx({ apply: true, force: true }));

    expect((result.data as { archived: number }).archived).toBe(1);
    expect(statusOf('survivor-retire')).toBe('active');
    expect(statusOf('restatement-retire')).toBe('archived');
  });

  it('--recheck re-examines without erasing the verdicts it bypasses', async () => {
    seed([
      { key: 'stale-keep', updatedAt: now - 300 * DAY, accessCount: 0 },
      { key: 'other-keep', updatedAt: now - 310 * DAY, accessCount: 0 },
    ]);

    await auditLearningsCommand.action(ctx({ apply: true, force: true }));
    expect(readAuditState(tmp).size).toBe(2);

    // The recheck deliberately nominates only ONE of the two, so a run that
    // started from an empty record and wrote it back leaves a record of one —
    // silently dropping the other entry's verdict and re-judging it next time.
    // Re-judging the same set would rewrite both and hide the loss.
    await auditLearningsCommand.action(ctx({ apply: true, force: true, recheck: true, unusedLimit: 1 }));

    expect(readAuditState(tmp).size).toBe(2);
  });

  it('declines instead of hanging when --apply has no terminal to confirm on', async () => {
    seed([{ key: 'stale-retire', updatedAt: now - 300 * DAY, accessCount: 0 }]);

    // No --force, and the test process has no TTY — the same shape as a cron
    // entry or a CI step. A bare confirm() would block on a pipe forever.
    const result = await auditLearningsCommand.action({ ...ctx({ apply: true }), interactive: false });

    expect((result.data as { applied: boolean }).applied).toBe(false);
    expect(statusOf('stale-retire')).toBe('active');
    expect(written.join('\n')).toContain('Confirmation required');
  });

  it('reports an empty store as zero learnings rather than failing', async () => {
    // beforeEach truncated the table; nothing seeded.
    const result = await auditLearningsCommand.action(ctx());

    expect(result.success).toBe(true);
    expect((result.data as { examined: number }).examined).toBe(0);
    expect((result.data as { nominated: number }).nominated).toBe(0);
  });

  it('never archives a COMPRESS verdict — that would delete the signal it said to keep', async () => {
    seed([{ key: 'stale-compress', updatedAt: now - 300 * DAY, accessCount: 0 }]);

    const result = await auditLearningsCommand.action(ctx({ apply: true, force: true }));

    expect((result.data as { archived: number }).archived).toBe(0);
    expect(statusOf('stale-compress')).toBe('active');
    expect(readAuditState(tmp).get('stale-compress')?.verdict).toBe('COMPRESS');
  });

  it('refuses to apply on nominations alone when no verdict came back', async () => {
    seed([{ key: 'stale-retire', updatedAt: now - 300 * DAY, accessCount: 0 }]);

    const result = await auditLearningsCommand.action(ctx({ apply: true, force: true, judge: false }));

    expect((result.data as { archived: number }).archived).toBe(0);
    expect(statusOf('stale-retire')).toBe('active');
    expect(written.join('\n')).toContain('nominations alone are not a decision');
  });

  it('re-running immediately after --apply reports zero remaining candidates', async () => {
    seed([
      { key: 'stale-retire', updatedAt: now - 300 * DAY, accessCount: 0 },
      { key: 'stale-keep', updatedAt: now - 310 * DAY, accessCount: 0 },
    ]);

    const first = await auditLearningsCommand.action(ctx({ apply: true, force: true }));
    expect((first.data as { nominated: number }).nominated).toBe(2);
    expect((first.data as { archived: number }).archived).toBe(1);
    expect(fs.existsSync(path.join(tmp, '.moflo', AUDIT_STATE_FILE))).toBe(true);

    fs.rmSync(judgeLog, { force: true });
    const second = await auditLearningsCommand.action(ctx());

    const data = second.data as { nominated: number; counts: Record<string, number>; judged: number };
    expect(data.nominated).toBe(0);
    expect(data.counts.unused).toBe(0);
    // Idempotence has to reach the model call too, or a quiet re-run still costs
    // a headless spawn every time.
    expect(data.judged).toBe(0);
    expect(fs.existsSync(judgeLog)).toBe(false);
  });

  it('--recheck re-examines entries that already carry a verdict', async () => {
    seed([{ key: 'stale-keep', updatedAt: now - 300 * DAY, accessCount: 0 }]);

    await auditLearningsCommand.action(ctx({ apply: true, force: true }));
    const rechecked = await auditLearningsCommand.action(ctx({ recheck: true }));

    expect((rechecked.data as { nominated: number }).nominated).toBe(1);
  });

  it('reaches the skip path from the real CLI spelling of the flag', async () => {
    // The parser turns `--no-<x>` into `<x> = false`, so an option NAMED
    // `no-judge` parses into a flag nothing reads and the skip silently never
    // happens. Asserted through the real parser rather than the option list,
    // because the list looks correct under either spelling.
    const parser = new CommandParser();
    parser.registerCommand(auditLearningsCommand);

    const parsed = parser.parse(['audit-learnings', '--no-judge']);

    expect(parsed.flags.judge).toBe(false);
    seed([{ key: 'stale-retire', updatedAt: now - 300 * DAY, accessCount: 0 }]);

    const result = await auditLearningsCommand.action({ ...ctx(), flags: parsed.flags });

    expect(fs.existsSync(judgeLog)).toBe(false);
    expect((result.data as { judgeSkipped: boolean }).judgeSkipped).toBe(true);
  });

  it('leaves the store untouched when the judge fails', async () => {
    seed([{ key: 'stale-retire', updatedAt: now - 300 * DAY, accessCount: 0 }]);
    const failing = path.join(tmp, 'failing-stub.cjs');
    fs.writeFileSync(failing, 'process.exit(3);\n', 'utf-8');
    process.env[JUDGE_STUB_ENV] = failing;

    const result = await auditLearningsCommand.action(ctx({ apply: true, force: true }));

    expect(result.success).toBe(true);
    expect((result.data as { archived: number }).archived).toBe(0);
    expect(statusOf('stale-retire')).toBe('active');
  });
});
