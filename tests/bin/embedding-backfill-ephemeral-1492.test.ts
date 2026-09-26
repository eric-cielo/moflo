/**
 * Regression tests for #1492 — the background backfill embedded rows their
 * writers had deliberately left unembedded.
 *
 * Ephemeral namespaces (tasklist, hive-mind, epic-state, swarm-*) and explicit
 * opt-outs (`embedding_model = 'none'`) are written with `embedding IS NULL`.
 * Every backfill selector read that NULL as "not embedded yet" and embedded
 * them on the next session, so /flo run records outranked real code-map and
 * test hits in ordinary `memory_search` results.
 *
 * Covers each selector the issue names: the backlog probe that gates the
 * index chain, `build-embeddings` (incl. `--force`), and `flo memory
 * rebuild-index` (incl. `--force`) — plus parity between the TypeScript source
 * of truth and the `bin/` mirror, which cannot import it.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DELIBERATELY_UNEMBEDDED_WHERE,
  EMBEDDABLE_WHERE,
  EMBEDDING_MODEL_OPT_OUT as BIN_OPT_OUT,
  EPHEMERAL_NAMESPACES as BIN_EPHEMERAL,
  EPHEMERAL_NAMESPACE_PREFIXES as BIN_EPHEMERAL_PREFIXES,
  PENDING_EMBEDDING_WHERE,
  hasPendingEmbeddings,
} from '../../bin/lib/embedding-backlog.mjs';
import {
  EMBEDDING_MODEL_OPT_OUT,
  EPHEMERAL_NAMESPACES,
  EPHEMERAL_NAMESPACE_PREFIXES,
  backfillExclusionSql,
} from '../../src/cli/memory/bridge-embedder.js';
import { MEMORY_SCHEMA_V3 } from '../../src/cli/memory/memory-initializer.js';
import { openDaemonDatabase } from '../../src/cli/memory/daemon-backend.js';
import { MOFLO_DIR, MEMORY_DB_FILE } from '../../src/cli/services/moflo-paths.js';
import { memoryCommand } from '../../src/cli/commands/memory.js';

const REPO_ROOT = resolve(__dirname, '..', '..');

let root: string;
let dbPath: string;
let savedProjectDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'moflo-1492-'));
  mkdirSync(join(root, MOFLO_DIR));
  dbPath = join(root, MOFLO_DIR, MEMORY_DB_FILE);
  const db = openDaemonDatabase(dbPath);
  db.run(MEMORY_SCHEMA_V3);
  db.close();
  savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
});

afterEach(() => {
  if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows handle lag */ }
});

/** Insert an unembedded active row. `model` undefined → writer's NULL; else the literal. */
function insert(id: string, namespace: string, model: string | null): void {
  const db = openDaemonDatabase(dbPath);
  try {
    db.run(
      `INSERT INTO memory_entries (id, key, namespace, content, embedding, embedding_model, status)
       VALUES (?, ?, ?, ?, NULL, ?, 'active')`,
      [id, `k-${id}`, namespace, `rename gear to equipment across schema ${id}`, model],
    );
  } finally {
    db.close();
  }
}

/** Seed the rows the writers actually produce for deliberately unembedded data. */
function seedDeliberatelyUnembedded(): void {
  insert('tasklist-run', 'tasklist', null);          // ephemeral writer: NULL model
  insert('hive-msg', 'hive-mind', null);
  insert('epic', 'epic-state', null);
  insert('swarm-agent', 'swarm-agents', null);       // post-#1492 swarm write
  insert('swarm-task-legacy', 'swarm-tasks', 'none'); // pre-#1492 swarm write (opt-out)
  insert('opt-out', 'default', EMBEDDING_MODEL_OPT_OUT);
}

function ids(where: string, params: unknown[] = []): string[] {
  const db = openDaemonDatabase(dbPath);
  try {
    const rows = db.exec(`SELECT id FROM memory_entries WHERE ${where} ORDER BY id`, params);
    return (rows[0]?.values ?? []).map((r) => String(r[0]));
  } finally {
    db.close();
  }
}

function embeddingState(): Array<[string, unknown, unknown]> {
  const db = openDaemonDatabase(dbPath);
  try {
    const rows = db.exec(`SELECT id, embedding, embedding_model FROM memory_entries ORDER BY id`);
    return (rows[0]?.values ?? []).map((r) => [String(r[0]), r[1], r[2]]);
  } finally {
    db.close();
  }
}

describe('bin/ mirror stays in lockstep with bridge-embedder (#1492)', () => {
  it('ephemeral names, prefixes and the opt-out tag match the TypeScript source', () => {
    expect([...BIN_EPHEMERAL].sort()).toEqual([...EPHEMERAL_NAMESPACES].sort());
    expect([...BIN_EPHEMERAL_PREFIXES].sort()).toEqual([...EPHEMERAL_NAMESPACE_PREFIXES].sort());
    expect(BIN_OPT_OUT).toBe(EMBEDDING_MODEL_OPT_OUT);
  });

  it('the bin/ predicate and the TS fragment select the same rows', () => {
    seedDeliberatelyUnembedded();
    insert('code-map-chunk', 'code-map', 'local');
    insert('legacy-null', 'guidance', null); // pre-model-tracking row: must still embed

    const ts = backfillExclusionSql();
    expect(ids(`status = 'active' ${ts.sql}`, ts.params)).toEqual(ids(EMBEDDABLE_WHERE));
    expect(ids(EMBEDDABLE_WHERE)).toEqual(['code-map-chunk', 'legacy-null']);
    expect(ids(DELIBERATELY_UNEMBEDDED_WHERE)).toHaveLength(6);
  });
});

describe('backlog probe (#1492)', () => {
  it('reports no backlog when only deliberately-unembedded rows lack a vector', () => {
    seedDeliberatelyUnembedded();
    expect(ids(PENDING_EMBEDDING_WHERE)).toEqual([]);
    expect(hasPendingEmbeddings(root, { dbPath })).toBe(false);
  });

  it('still counts a NULL-namespace row as pending (nullable column, negated match)', () => {
    const db = openDaemonDatabase(dbPath);
    try {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, status) VALUES ('no-ns', 'k', NULL, 'c', 'active')`,
      );
    } finally {
      db.close();
    }
    expect(ids(PENDING_EMBEDDING_WHERE)).toEqual(['no-ns']);
    const ts = backfillExclusionSql();
    expect(ids(`status = 'active' ${ts.sql}`, ts.params)).toEqual(['no-ns']);
  });

  it('still reports a real pending row alongside them', () => {
    seedDeliberatelyUnembedded();
    insert('fresh-chunk', 'guidance', 'local');
    expect(ids(PENDING_EMBEDDING_WHERE)).toEqual(['fresh-chunk']);
    expect(hasPendingEmbeddings(root, { dbPath })).toBe(true);
  });
});

describe('backfill leaves deliberately-unembedded rows alone end to end (#1492)', () => {
  it('build-embeddings --force embeds none of them', () => {
    seedDeliberatelyUnembedded();
    const before = embeddingState();

    const run = spawnSync(process.execPath, [join(REPO_ROOT, 'bin', 'build-embeddings.mjs'), '--force'], {
      cwd: root,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('All entries already have embeddings');
    expect(embeddingState()).toEqual(before);
  });

  it('flo memory rebuild-index --force embeds none of them', async () => {
    seedDeliberatelyUnembedded();
    const before = embeddingState();

    const rebuild = memoryCommand.subcommands!.find((c) => c.name === 'rebuild-index')!;
    const result = await rebuild.action!({ flags: { force: true }, cwd: root, args: [] } as never);
    expect(result).toMatchObject({ success: true });
    expect(embeddingState()).toEqual(before);
  });
});
