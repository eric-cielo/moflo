/**
 * The team artifact stops carrying captured tool-call markup (#1467).
 *
 * This is the half of the fix that helps a store which is ALREADY polluted. The
 * write-time guard only protects entries written from now on; the 68 corrupt
 * rows a consumer already has would keep flowing out to the artifact on every
 * export and back into every teammate's database on every import. So export
 * skips a corrupt local row and import skips a corrupt artifact line, each
 * reporting the count rather than dropping it silently.
 *
 * The subtle requirement is that skipping must not read as a DELETION. Export
 * drops the row from the source snapshot, and `planReconcile` derives deletions
 * from a local tombstone rather than from an absent key — so a skip publishes
 * nothing, and `does not publish a tombstone for the skipped entry` pins that.
 *
 * Real node:sqlite DBs and real files under os.tmpdir(); every path is joined
 * (Rule #1).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  exportTeamArtifact,
  importTeamArtifact,
  TOMBSTONE_NAMESPACE,
} from '../../services/team-artifact-sync.js';
import { memoryDbPath } from '../../services/moflo-paths.js';
import { memoryCommand } from '../../commands/memory.js';
import { output } from '../../output.js';
import type { Command, CommandContext } from '../../types.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';
import { makeMemoryDb, type FixtureDb } from '../_helpers/legacy-memory-db.js';
import { DatabaseSync } from 'node:sqlite';

/** The exact shape reported in #1467. */
const CORRUPT = 'the actual lesson text.",\n    <parameter name="tags">["a","b","source:manual"]';
const NOW = '2026-08-26T00:00:00.000Z';

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* Windows file lock — non-fatal */ }
  }
});

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'moflo-1467-team-'));
  tmpDirs.push(dir);
  return dir;
}

function seed(
  dbPath: string,
  rows: Array<{ key: string; content: string; status?: 'active' | 'archived'; updatedAt?: number }>,
): Promise<void> {
  return makeMemoryDb(dbPath, MEMORY_SCHEMA_V3, (db: FixtureDb) => {
    for (const r of rows) {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, created_at, updated_at, status)
         VALUES (?, ?, 'learnings', ?, ?, ?, ?)`,
        [`id-${r.key}`, r.key, r.content, 1_700_000_000_000, r.updatedAt ?? 1_700_000_000_000, r.status ?? 'active'],
      );
    }
  });
}

interface ArtifactLine { namespace: string; key: string; content?: string; deleted?: unknown }

function readLines(artifactPath: string): ArtifactLine[] {
  if (!existsSync(artifactPath)) return [];
  return readFileSync(artifactPath, 'utf-8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ArtifactLine);
}

function writeLines(artifactPath: string, lines: ArtifactLine[]): void {
  mkdirSync(dirname(artifactPath), { recursive: true });
  const provenance = { author: 'teammate', source: 'other-machine', sharedAt: NOW };
  writeFileSync(
    artifactPath,
    lines.map((l) => JSON.stringify({ type: 'semantic', updated_at: 1_700_000_000_000, provenance, ...l })).join('\n') + '\n',
    'utf-8',
  );
}

function localKeys(dbPath: string): string[] {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(`SELECT key FROM memory_entries WHERE status = 'active' ORDER BY key`).all() as Array<{ key: string }>)
      .map((r) => r.key);
  } finally {
    db.close();
  }
}

describe('exportTeamArtifact skips captured markup (#1467)', () => {
  it('shares the clean entry, skips the corrupt one, and reports the count', async () => {
    const root = await makeRoot();
    await seed(memoryDbPath(root), [
      { key: 'clean-lesson', content: 'An ordinary lesson about cache invalidation.' },
      { key: 'corrupt-lesson', content: CORRUPT },
    ]);
    const artifactPath = join(root, '.moflo', 'shared', 'learnings.jsonl');

    const report = exportTeamArtifact({ projectRoot: root, artifactPath, sharedAt: NOW });

    expect(report.skippedCorrupt).toBe(1);
    expect(report.added).toBe(1);
    expect(readLines(artifactPath).map((l) => l.key)).toEqual(['clean-lesson']);
  });

  it('does not publish a tombstone for the skipped entry', async () => {
    // The trap in dropping a row from the source: if a skip read as "deleted
    // locally", export would propagate a retraction and every teammate would
    // lose their own copy of the key.
    const root = await makeRoot();
    await seed(memoryDbPath(root), [{ key: 'corrupt-lesson', content: CORRUPT }]);
    const artifactPath = join(root, '.moflo', 'shared', 'learnings.jsonl');

    const report = exportTeamArtifact({ projectRoot: root, artifactPath, sharedAt: NOW });

    expect(report.deleted).toBe(0);
    expect(readLines(artifactPath)).toEqual([]);
  });

  it('still publishes the tombstone for a corrupt entry the user deleted', async () => {
    // Archiving leaves `content` intact, so a skip keyed on the row's body
    // would swallow the very deletion that retracts the corrupt line — and a
    // line already in the artifact would become permanently unretractable,
    // which is the opposite of what the skip is for.
    const root = await makeRoot();
    // Newer than the shared line, so the deletion wins the last-writer compare.
    await seed(memoryDbPath(root), [
      { key: 'corrupt-lesson', content: CORRUPT, status: 'archived', updatedAt: 1_800_000_000_000 },
    ]);
    const artifactPath = join(root, '.moflo', 'shared', 'learnings.jsonl');
    writeLines(artifactPath, [{ namespace: 'learnings', key: 'corrupt-lesson', content: CORRUPT }]);

    const report = exportTeamArtifact({ projectRoot: root, artifactPath, sharedAt: NOW });

    expect(report.skippedCorrupt).toBe(0);
    expect(report.deleted).toBe(1);
    const [line] = readLines(artifactPath);
    expect(line.namespace).toBe(TOMBSTONE_NAMESPACE);
  });

  it('leaves a corrupt line a teammate already shared untouched', async () => {
    // Removing someone else's line is a different decision than declining to
    // add our own; export only stops contributing.
    const root = await makeRoot();
    await seed(memoryDbPath(root), [{ key: 'corrupt-lesson', content: CORRUPT }]);
    const artifactPath = join(root, '.moflo', 'shared', 'learnings.jsonl');
    writeLines(artifactPath, [{ namespace: 'learnings', key: 'corrupt-lesson', content: CORRUPT }]);

    exportTeamArtifact({ projectRoot: root, artifactPath, sharedAt: NOW });

    expect(readLines(artifactPath).map((l) => l.key)).toEqual(['corrupt-lesson']);
  });
});

describe('flo memory team-export reports the skip (#1467)', () => {
  it('warns about the withheld entries rather than dropping them silently', async () => {
    // "skips (and reports)" — a silent skip would be the same invisibility the
    // ticket is about, one layer up: the store looks shared, and nobody knows
    // which entries were held back or why.
    const root = await makeRoot();
    await seed(memoryDbPath(root), [
      { key: 'clean-lesson', content: 'An ordinary lesson.' },
      { key: 'corrupt-lesson', content: CORRUPT },
    ]);
    const artifactPath = join(root, '.moflo', 'shared', 'learnings.jsonl');
    const teamExport = memoryCommand.subcommands?.find((c) => c.name === 'team-export') as Command;

    const warnings: string[] = [];
    const spy = vi.spyOn(output, 'printWarning').mockImplementation((m: string) => { warnings.push(m); });
    const saved = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = root;
    try {
      const ctx = { args: [], flags: { _: [], to: artifactPath } as CommandContext['flags'], cwd: root, interactive: false };
      const result = await teamExport.action!(ctx as CommandContext);
      expect(result.success).toBe(true);
    } finally {
      spy.mockRestore();
      if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = saved;
    }

    expect(warnings.join('\n')).toMatch(/1 entry NOT shared.*tool-call markup/s);
  });
});

describe('importTeamArtifact skips captured markup (#1467)', () => {
  it('imports the clean line, skips the corrupt one, and reports the count', async () => {
    const root = await makeRoot();
    const artifactPath = join(root, '.moflo', 'shared', 'learnings.jsonl');
    writeLines(artifactPath, [
      { namespace: 'learnings', key: 'clean-lesson', content: 'An ordinary lesson.' },
      { namespace: 'learnings', key: 'corrupt-lesson', content: CORRUPT },
    ]);

    const report = importTeamArtifact({ projectRoot: root, artifactPath });

    expect(report.skippedCorrupt).toBe(1);
    expect(report.imported).toBe(1);
    expect(localKeys(memoryDbPath(root))).toEqual(['clean-lesson']);
  });

  it('still applies a tombstone — a deletion must propagate', async () => {
    // Tombstones carry no content, so the content check must not swallow them.
    const root = await makeRoot();
    await seed(memoryDbPath(root), [{ key: 'retired', content: 'gone soon' }]);
    const artifactPath = join(root, '.moflo', 'shared', 'learnings.jsonl');
    writeLines(artifactPath, [{
      namespace: TOMBSTONE_NAMESPACE,
      key: 'retired',
      deleted: { namespace: 'learnings', key: 'retired', at: 1_800_000_000_000 },
    }]);

    const report = importTeamArtifact({ projectRoot: root, artifactPath });

    expect(report.skippedCorrupt).toBe(0);
    expect(report.deleted).toBe(1);
    expect(localKeys(memoryDbPath(root))).toEqual([]);
  });
});
