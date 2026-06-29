/**
 * Tests for the git-tracked team learnings artifact (#1234, epic #1231).
 *
 * Covers:
 *   - resolveTeamArtifactPath: off by default, env > config precedence, relative.
 *   - exportTeamArtifact: only durable namespaces, no embeddings in the file,
 *     provenance stamped, first-write-wins (existing lines preserved), sorted.
 *   - importTeamArtifact: JSONL → local DB INSERT OR IGNORE, provenance retained
 *     in metadata, idempotent re-import, malformed lines skipped.
 *   - round-trip A→B (the #1234 repro at the service layer).
 *   - ensureSharedArtifactTracked: rewrites a bare `.moflo/` ignore to
 *     `.moflo/*` + a negation, idempotently; creates a .gitignore when absent.
 *
 * Real node:sqlite DBs + real files in tmp dirs (pure IO, no daemon). All paths
 * via path.join / os.tmpdir for cross-platform safety (Rule #1).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  resolveTeamArtifactPath,
  exportTeamArtifact,
  importTeamArtifact,
  ensureSharedArtifactTracked,
  DEFAULT_TEAM_ARTIFACT_REL,
  type TeamArtifactEntry,
} from '../../services/team-artifact-sync.js';
import { loadMofloConfig, type MofloConfig } from '../../config/moflo-config.js';
import { memoryDbPath } from '../../services/moflo-paths.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/memory-initializer.js';
import { makeMemoryDb, type FixtureDb } from '../_helpers/legacy-memory-db.js';
import { DatabaseSync } from 'node:sqlite';

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows file-lock — non-fatal for tests */
    }
  }
});

const savedEnv = process.env.MOFLO_TEAM_ARTIFACT;
beforeEach(() => {
  delete process.env.MOFLO_TEAM_ARTIFACT;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.MOFLO_TEAM_ARTIFACT;
  else process.env.MOFLO_TEAM_ARTIFACT = savedEnv;
});

async function makeRoot(prefix = 'moflo-team-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function configWith(root: string, teamArtifact?: string): MofloConfig {
  const cfg = loadMofloConfig(root);
  cfg.memory.team_artifact = teamArtifact;
  return cfg;
}

function makeDbWith(
  dbPath: string,
  rows: Array<{ key: string; namespace: string; content?: string; embedding?: number[]; tags?: string[] }>,
): Promise<void> {
  return makeMemoryDb(dbPath, MEMORY_SCHEMA_V3, (db: FixtureDb) => {
    for (const r of rows) {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, embedding, tags) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          `id-${r.namespace}-${r.key}`,
          r.key,
          r.namespace,
          r.content ?? `content-${r.key}`,
          r.embedding ? JSON.stringify(r.embedding) : null,
          r.tags ? JSON.stringify(r.tags) : null,
        ],
      );
    }
  });
}

function readArtifactLines(artifactPath: string): TeamArtifactEntry[] {
  if (!existsSync(artifactPath)) return [];
  return readFileSync(artifactPath, 'utf-8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TeamArtifactEntry);
}

function readDbRows(dbPath: string): Array<{ namespace: string; key: string; embedding: string | null; metadata: string | null }> {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(`SELECT namespace, key, embedding, metadata FROM memory_entries ORDER BY namespace, key`)
      .all() as Array<{ namespace: string; key: string; embedding: string | null; metadata: string | null }>;
  } finally {
    db.close();
  }
}

const NOW = '2026-06-28T00:00:00.000Z';

describe('resolveTeamArtifactPath (#1234)', () => {
  it('returns null when unconfigured (solo default)', async () => {
    const root = await makeRoot();
    expect(resolveTeamArtifactPath(root, configWith(root, undefined))).toBeNull();
  });

  it('resolves a relative config path against the project root', async () => {
    const root = await makeRoot();
    expect(resolveTeamArtifactPath(root, configWith(root, '.moflo/shared/learnings.jsonl'))).toBe(
      join(root, '.moflo', 'shared', 'learnings.jsonl'),
    );
  });

  it('env MOFLO_TEAM_ARTIFACT takes precedence over config', async () => {
    const root = await makeRoot();
    const envPath = join(await makeRoot('moflo-env-'), 'team.jsonl');
    process.env.MOFLO_TEAM_ARTIFACT = envPath;
    expect(resolveTeamArtifactPath(root, configWith(root, '/some/config.jsonl'))).toBe(envPath);
  });
});

describe('exportTeamArtifact (#1234)', () => {
  it('writes only durable namespaces, no embeddings, provenance stamped', async () => {
    const root = await makeRoot();
    const artifact = join(root, '.moflo', 'shared', 'learnings.jsonl');
    await makeDbWith(memoryDbPath(root), [
      { key: 'lesson-1', namespace: 'learnings', content: 'worrying does no good', embedding: [0.1, 0.2], tags: ['t'] },
      { key: 'kb-1', namespace: 'knowledge' },
      { key: 'cm-1', namespace: 'code-map' }, // structural — must NOT travel
    ]);

    const report = exportTeamArtifact({ projectRoot: root, artifactPath: artifact, sharedAt: NOW });
    expect(report.added).toBe(2);
    expect(report.total).toBe(2);

    const lines = readArtifactLines(artifact);
    expect(lines.map((l) => `${l.namespace}/${l.key}`).sort()).toEqual(['knowledge/kb-1', 'learnings/lesson-1']);
    const lesson = lines.find((l) => l.key === 'lesson-1')!;
    // No embedding field in the diffable artifact.
    expect((lesson as Record<string, unknown>).embedding).toBeUndefined();
    expect(lesson.tags).toEqual(['t']);
    expect(lesson.provenance.author).toBeTruthy();
    expect(lesson.provenance.source).toBeTruthy();
    expect(lesson.provenance.sharedAt).toBe(NOW);
  });

  it('is sorted by (namespace, key) for deterministic diffs', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    await makeDbWith(memoryDbPath(root), [
      { key: 'zeta', namespace: 'learnings' },
      { key: 'alpha', namespace: 'learnings' },
      { key: 'mid', namespace: 'knowledge' },
    ]);
    exportTeamArtifact({ projectRoot: root, artifactPath: artifact, sharedAt: NOW });
    const keys = readArtifactLines(artifact).map((l) => `${l.namespace}/${l.key}`);
    expect(keys).toEqual(['knowledge/mid', 'learnings/alpha', 'learnings/zeta']);
  });

  it('first-write-wins: an existing artifact entry is never overwritten on re-export', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    mkdirSync(dirname(artifact), { recursive: true });
    // A teammate already shared lesson-1 with their own provenance.
    const original: TeamArtifactEntry = {
      namespace: 'learnings',
      key: 'lesson-1',
      content: 'original teammate content',
      type: 'semantic',
      provenance: { author: 'Teammate A', source: 'host-a', sharedAt: '2020-01-01T00:00:00.000Z' },
    };
    writeFileSync(artifact, JSON.stringify(original) + '\n', 'utf-8');

    // Locally we have a different lesson-1 + a brand-new lesson-2.
    await makeDbWith(memoryDbPath(root), [
      { key: 'lesson-1', namespace: 'learnings', content: 'my divergent content' },
      { key: 'lesson-2', namespace: 'learnings' },
    ]);
    const report = exportTeamArtifact({ projectRoot: root, artifactPath: artifact, sharedAt: NOW });
    expect(report.added).toBe(1); // only lesson-2

    const lines = readArtifactLines(artifact);
    const lesson1 = lines.find((l) => l.key === 'lesson-1')!;
    expect(lesson1.content).toBe('original teammate content'); // preserved
    expect(lesson1.provenance.author).toBe('Teammate A'); // preserved
  });
});

describe('importTeamArtifact (#1234)', () => {
  it('merges durable rows with provenance retained, no embedding (regenerated later)', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    const entry: TeamArtifactEntry = {
      namespace: 'learnings',
      key: 'lesson-x',
      content: 'shared insight',
      type: 'semantic',
      tags: ['team'],
      provenance: { author: 'Dev A', source: 'laptop-a', sharedAt: NOW },
    };
    writeFileSync(artifact, JSON.stringify(entry) + '\n', 'utf-8');

    const report = importTeamArtifact({ projectRoot: root, artifactPath: artifact });
    expect(report.imported).toBe(1);

    const rows = readDbRows(memoryDbPath(root));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ namespace: 'learnings', key: 'lesson-x' });
    expect(rows[0].embedding).toBeNull(); // regenerated by the daemon index pass
    expect(JSON.parse(rows[0].metadata!).provenance.author).toBe('Dev A');
  });

  it('is idempotent and first-write-wins (existing local row survives re-import)', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    const entry: TeamArtifactEntry = {
      namespace: 'learnings',
      key: 'dup',
      content: 'from artifact',
      type: 'semantic',
      provenance: { author: 'A', source: 'h', sharedAt: NOW },
    };
    writeFileSync(artifact, JSON.stringify(entry) + '\n', 'utf-8');

    const first = importTeamArtifact({ projectRoot: root, artifactPath: artifact });
    expect(first.imported).toBe(1);
    const second = importTeamArtifact({ projectRoot: root, artifactPath: artifact });
    expect(second.imported).toBe(0); // INSERT OR IGNORE
    expect(readDbRows(memoryDbPath(root))).toHaveLength(1);
  });

  it('coerces an out-of-CHECK-set type to semantic instead of silently dropping', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    const entry = {
      namespace: 'learnings',
      key: 'weird-type',
      content: 'c',
      type: 'totally-invalid-type',
      provenance: { author: 'A', source: 'h', sharedAt: NOW },
    };
    writeFileSync(artifact, JSON.stringify(entry) + '\n', 'utf-8');

    const report = importTeamArtifact({ projectRoot: root, artifactPath: artifact });
    expect(report.imported).toBe(1); // imported, not dropped
    const db = new DatabaseSync(memoryDbPath(root));
    try {
      const row = db.prepare(`SELECT type FROM memory_entries WHERE key='weird-type'`).get() as { type: string };
      expect(row.type).toBe('semantic');
    } finally {
      db.close();
    }
  });

  it('skips non-durable namespaces (only learnings/knowledge are shared)', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    const rows = [
      { namespace: 'learnings', key: 'keep', content: 'c', type: 'semantic', provenance: { author: 'A', source: 'h', sharedAt: NOW } },
      { namespace: 'code-map', key: 'drop', content: 'c', type: 'semantic', provenance: { author: 'A', source: 'h', sharedAt: NOW } },
    ];
    writeFileSync(artifact, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

    const report = importTeamArtifact({ projectRoot: root, artifactPath: artifact });
    expect(report.imported).toBe(1);
    expect(report.skippedNonDurable).toBe(1);
    expect(report.considered).toBe(1); // non-durable not counted as "considered"
    expect(readDbRows(memoryDbPath(root)).map((r) => r.namespace)).toEqual(['learnings']);
  });

  it('skips malformed lines without throwing', async () => {
    const root = await makeRoot();
    const artifact = join(root, 'team.jsonl');
    const good: TeamArtifactEntry = {
      namespace: 'learnings',
      key: 'ok',
      content: 'c',
      type: 'semantic',
      provenance: { author: 'A', source: 'h', sharedAt: NOW },
    };
    writeFileSync(artifact, `${JSON.stringify(good)}\n{not valid json\n{"missing":"keys"}\n`, 'utf-8');

    const report = importTeamArtifact({ projectRoot: root, artifactPath: artifact });
    expect(report.imported).toBe(1);
    expect(report.skippedMalformed).toBe(2);
  });
});

describe('round-trip A→B (#1234 repro, service layer)', () => {
  it('a learning shared by dev A appears in dev B after import', async () => {
    const devA = await makeRoot('moflo-A-');
    const devB = await makeRoot('moflo-B-');
    const artifact = join(await makeRoot('moflo-shared-'), 'learnings.jsonl');

    await makeDbWith(memoryDbPath(devA), [
      { key: 'pattern-1', namespace: 'learnings', content: 'always realpath both sides' },
      { key: 'cm', namespace: 'code-map' }, // must not leak
    ]);

    const exp = exportTeamArtifact({ projectRoot: devA, artifactPath: artifact, sharedAt: NOW });
    expect(exp.added).toBe(1);

    const imp = importTeamArtifact({ projectRoot: devB, artifactPath: artifact });
    expect(imp.imported).toBe(1);

    const bRows = readDbRows(memoryDbPath(devB));
    expect(bRows.map((r) => `${r.namespace}/${r.key}`)).toEqual(['learnings/pattern-1']);
  });
});

describe('ensureSharedArtifactTracked (#1234)', () => {
  it('rewrites a bare `.moflo/` ignore to `.moflo/*` + a negation', async () => {
    const root = await makeRoot();
    const gitignore = join(root, '.gitignore');
    writeFileSync(gitignore, 'node_modules/\n.moflo/\ndist/\n', 'utf-8');

    const action = ensureSharedArtifactTracked(root, join(root, '.moflo', 'shared', 'learnings.jsonl'));
    expect(action).toBe('updated');

    const lines = readFileSync(gitignore, 'utf-8').split('\n');
    expect(lines).toContain('.moflo/*');
    expect(lines).not.toContain('.moflo/'); // bare rule replaced
    expect(lines).toContain('!/.moflo/shared/');
    // negation must come after the contents rule for git to honour it
    expect(lines.indexOf('!/.moflo/shared/')).toBeGreaterThan(lines.indexOf('.moflo/*'));
  });

  it('is idempotent — a second call makes no change', async () => {
    const root = await makeRoot();
    const gitignore = join(root, '.gitignore');
    writeFileSync(gitignore, '.moflo/\n', 'utf-8');
    const artifact = join(root, '.moflo', 'shared', 'learnings.jsonl');

    ensureSharedArtifactTracked(root, artifact);
    const after1 = readFileSync(gitignore, 'utf-8');
    const action2 = ensureSharedArtifactTracked(root, artifact);
    expect(action2).toBe('unchanged');
    expect(readFileSync(gitignore, 'utf-8')).toBe(after1);
  });

  it('creates a .gitignore when none exists', async () => {
    const root = await makeRoot();
    const action = ensureSharedArtifactTracked(root, join(root, '.moflo', 'shared', 'learnings.jsonl'));
    expect(action).toBe('created');
    const content = readFileSync(join(root, '.gitignore'), 'utf-8');
    expect(content).toContain('!/.moflo/shared/');
  });

  it('removes a bare `.moflo/` even when a `.moflo/*` contents rule already exists', async () => {
    const root = await makeRoot();
    const gitignore = join(root, '.gitignore');
    // Both rules present — git still can't re-include because the bare dir is excluded.
    writeFileSync(gitignore, '.moflo/\n.moflo/*\n', 'utf-8');

    const action = ensureSharedArtifactTracked(root, join(root, '.moflo', 'shared', 'learnings.jsonl'));
    expect(action).toBe('updated');

    const lines = readFileSync(gitignore, 'utf-8').split('\n');
    expect(lines).not.toContain('.moflo/'); // bare rule stripped
    expect(lines).toContain('.moflo/*');
    expect(lines).toContain('!/.moflo/shared/');
  });

  it('leaves .gitignore untouched for a custom artifact outside .moflo/', async () => {
    const root = await makeRoot();
    const gitignore = join(root, '.gitignore');
    writeFileSync(gitignore, 'node_modules/\n', 'utf-8');
    const before = readFileSync(gitignore, 'utf-8');

    const action = ensureSharedArtifactTracked(root, join(root, 'team', 'shared.jsonl'));
    expect(action).toBe('unchanged');
    expect(readFileSync(gitignore, 'utf-8')).toBe(before);
  });

  it('default artifact rel path is .moflo/shared/learnings.jsonl', () => {
    expect(DEFAULT_TEAM_ARTIFACT_REL).toBe(join('.moflo', 'shared', 'learnings.jsonl'));
  });
});
