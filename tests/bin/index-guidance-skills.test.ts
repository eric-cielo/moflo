/**
 * Tests for bin/index-guidance.mjs — skills indexing (#942)
 *
 * Verifies the indexer scans `.claude/skills/<name>/SKILL.md` files and writes
 * them into the `guidance` namespace under `doc-skill-<name>` / `chunk-skill-<name>-N`
 * keys with `metadata.kind === 'skill'` and `metadata.skill_name === '<name>'`.
 *
 * Smoke (file exists + node --check) is already covered by tests/bin/bin-scripts.test.ts.
 *
 * Pattern follows src/cli/__tests__/statusline-upgrade-notice.test.ts:
 *   - temp project root under <repo>/.testoutput/
 *   - GIT_CEILING_DIRECTORIES + CI=1 to short-circuit ambient git/IO
 *   - spawnSync with 25s timeout, vitest 30s testTimeout
 *   - Cross-platform path resolution; never bare slashes (feedback_cross_platform_mandatory)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');
const INDEXER = resolve(REPO_ROOT, 'bin', 'index-guidance.mjs');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function makeTempRoot(): string {
  const root = resolve(
    REPO_ROOT,
    '.testoutput',
    '.test-index-skills-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(root, { recursive: true });
  // The indexer walks parent dirs looking for package.json; without our own
  // package.json it would resolve to the moflo repo root and pick up real
  // guidance + skill fixtures under <moflo>/.claude/. Anchoring projectRoot
  // to the temp dir keeps the test hermetic.
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'moflo-skills-test-fixture', version: '0.0.0' }),
  );
  return root;
}

function cleanTempRoot(root: string) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows occasionally holds DB handles; non-fatal */
  }
}

function writeSkill(root: string, name: string, body: string) {
  const dir = join(root, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body);
}

function makeSkillBody(name: string, sectionASuffix = '', sectionBSuffix = ''): string {
  // Each section padded past MIN_CHUNK_SIZE (50 chars) to clear the chunker's
  // floor; MAX_CHUNK_SIZE (4000) is well above so the chunker takes the
  // header-split path and produces 2 chunks (one per H2).
  const padA = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6);
  const padB = 'Sed do eiusmod tempor incididunt ut labore et dolore magna. '.repeat(6);
  return [
    '---',
    `name: "${name}"`,
    `description: "Test fixture skill ${name}"`,
    '---',
    '',
    `# ${name}`,
    '',
    `Body intro for ${name}.`,
    '',
    '## Section A',
    '',
    `${padA}${sectionASuffix}`,
    '',
    '## Section B',
    '',
    `${padB}${sectionBSuffix}`,
    '',
  ].join('\n');
}

function runIndexer(cwd: string): RunResult {
  const result = spawnSync('node', [INDEXER, '--no-embeddings'], {
    cwd,
    encoding: 'utf-8',
    timeout: 25_000,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: cwd,
      CI: '1',
      // Cap git walk at the temp root's parent so the indexer's package.json
      // ascent + any incidental git execs don't escape into the moflo repo.
      GIT_CEILING_DIRECTORIES: dirname(cwd),
    },
    input: '',
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

interface DbRow {
  id: string;
  key: string;
  namespace: string;
  content: string;
  metadata: string | null;
}

async function readMemoryRows(dbPath: string, keyLike: string): Promise<DbRow[]> {
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const buffer = readFileSync(dbPath);
  const db = new SQL.Database(buffer);
  try {
    const stmt = db.prepare(
      `SELECT id, key, namespace, content, metadata
       FROM memory_entries
       WHERE namespace = 'guidance' AND key LIKE ?
       ORDER BY key ASC`,
    );
    stmt.bind([keyLike]);
    const rows: DbRow[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({
        id: String(row.id),
        key: String(row.key),
        namespace: String(row.namespace),
        content: String(row.content),
        metadata: row.metadata ? String(row.metadata) : null,
      });
    }
    stmt.free();
    return rows;
  } finally {
    db.close();
  }
}

describe('bin/index-guidance.mjs — skills (#942)', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanTempRoot(root);
  });

  it('indexes a single skill into the guidance namespace with kind=skill metadata', { timeout: 30_000 }, async () => {
    writeSkill(root, 'foo', makeSkillBody('foo'));

    const result = runIndexer(root);
    expect(result.status).toBe(0);

    const dbPath = join(root, '.moflo', 'moflo.db');
    expect(existsSync(dbPath)).toBe(true);

    const rows = await readMemoryRows(dbPath, 'doc-skill-foo');
    expect(rows.length).toBe(1);

    const meta = JSON.parse(rows[0].metadata || '{}');
    expect(meta.kind).toBe('skill');
    expect(meta.skill_name).toBe('foo');
  });

  it('does not collide between sibling skills foo and bar', { timeout: 30_000 }, async () => {
    writeSkill(root, 'foo', makeSkillBody('foo', 'foo-only-A', 'foo-only-B'));
    writeSkill(root, 'bar', makeSkillBody('bar', 'bar-only-A', 'bar-only-B'));

    const result = runIndexer(root);
    expect(result.status).toBe(0);

    const dbPath = join(root, '.moflo', 'moflo.db');
    const fooDoc = await readMemoryRows(dbPath, 'doc-skill-foo');
    const barDoc = await readMemoryRows(dbPath, 'doc-skill-bar');

    expect(fooDoc.length).toBe(1);
    expect(barDoc.length).toBe(1);
    expect(fooDoc[0].content).not.toBe(barDoc[0].content);
    expect(fooDoc[0].content).toContain('foo-only-A');
    expect(barDoc[0].content).toContain('bar-only-A');

    const fooMeta = JSON.parse(fooDoc[0].metadata || '{}');
    const barMeta = JSON.parse(barDoc[0].metadata || '{}');
    expect(fooMeta.skill_name).toBe('foo');
    expect(barMeta.skill_name).toBe('bar');
  });

  it('is idempotent — second run on unchanged content short-circuits to unchanged', { timeout: 30_000 }, async () => {
    writeSkill(root, 'foo', makeSkillBody('foo'));

    const first = runIndexer(root);
    expect(first.status).toBe(0);

    const dbPath = join(root, '.moflo', 'moflo.db');
    const before = await readMemoryRows(dbPath, 'doc-skill-foo');
    expect(before.length).toBe(1);
    const idBefore = before[0].id;

    const second = runIndexer(root);
    expect(second.status).toBe(0);

    // The indexer regenerates the row id on every storeEntry call (`mem_<ts>_<rand>`).
    // If the short-circuit fires, storeEntry is never called and the id is preserved.
    // The summary line `Documents indexed: 0` corroborates: nothing was re-written.
    expect(second.stdout).toMatch(/Documents indexed:\s*0/);

    const after = await readMemoryRows(dbPath, 'doc-skill-foo');
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(idBefore);
  });

  it('exits 0 when project .claude/skills/ is missing (bundled scan still runs)', { timeout: 30_000 }, async () => {
    // No project skills dir — but moflo's own bundled `.claude/skills/` is
    // still indexed via the bundled-skills branch (gated by `isSelfRef`, which
    // is false here because the fixture package.json name differs from moflo).
    // The AC is: missing project dir does not error. Bundled rows are expected
    // and should not be conflated with project-level skill rows.
    const result = runIndexer(root);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/Error|EACCES|ENOENT.*skills/i);

    const dbPath = join(root, '.moflo', 'moflo.db');
    if (existsSync(dbPath)) {
      // Look for a hypothetical project-level skill that we never wrote —
      // none exists, so the row count must be 0. Bundled keys carry the
      // `skill-bundled` prefix so they do not match `doc-skill-foo`.
      const fooRows = await readMemoryRows(dbPath, 'doc-skill-foo');
      expect(fooRows.length).toBe(0);
    }
    // No DB at all is also a valid outcome — nothing was indexed, so the
    // indexer may legitimately skip the saveDb path.
  });

  it('propagates kind=skill / skill_name to chunk rows, not just the doc row', { timeout: 30_000 }, async () => {
    writeSkill(root, 'foo', makeSkillBody('foo'));

    const result = runIndexer(root);
    expect(result.status).toBe(0);

    const dbPath = join(root, '.moflo', 'moflo.db');
    const chunks = await readMemoryRows(dbPath, 'chunk-skill-foo-%');
    expect(chunks.length).toBeGreaterThanOrEqual(2); // Section A + Section B

    for (const chunk of chunks) {
      const meta = JSON.parse(chunk.metadata || '{}');
      expect(meta.kind).toBe('skill');
      expect(meta.skill_name).toBe('foo');
    }
  });
});
