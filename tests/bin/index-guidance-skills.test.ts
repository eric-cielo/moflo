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
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
  // Phase 5 / #1084: read via the same node:sqlite factory the indexers use.
  const { openBackend } = await import('../../bin/lib/get-backend.mjs');
  const db = await openBackend(process.cwd(), { dbPath });
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

    // Post-#1053-S4 the chunker stopped writing `doc-*` rows (audit found
    // zero production readers; they duplicated chunk semantic territory).
    // The skill-level metadata lives on each chunk's `metadata` blob instead.
    const chunks = await readMemoryRows(dbPath, 'chunk-skill-foo-%');
    expect(chunks.length).toBeGreaterThanOrEqual(1);

    const meta = JSON.parse(chunks[0].metadata || '{}');
    expect(meta.kind).toBe('skill');
    expect(meta.skill_name).toBe('foo');
  });

  it('does not collide between sibling skills foo and bar', { timeout: 30_000 }, async () => {
    writeSkill(root, 'foo', makeSkillBody('foo', 'foo-only-A', 'foo-only-B'));
    writeSkill(root, 'bar', makeSkillBody('bar', 'bar-only-A', 'bar-only-B'));

    const result = runIndexer(root);
    expect(result.status).toBe(0);

    const dbPath = join(root, '.moflo', 'moflo.db');
    // Compare chunk rows since doc-* entries are no longer written
    // (#1053 S4). Per-skill content must remain distinct in chunk content
    // and metadata.skill_name.
    const fooChunks = await readMemoryRows(dbPath, 'chunk-skill-foo-%');
    const barChunks = await readMemoryRows(dbPath, 'chunk-skill-bar-%');

    expect(fooChunks.length).toBeGreaterThanOrEqual(1);
    expect(barChunks.length).toBeGreaterThanOrEqual(1);

    // Concatenate content so the assertion isn't sensitive to which chunk a
    // given suffix landed in (the chunker splits at H2 boundaries).
    const fooContent = fooChunks.map(r => r.content).join('\n');
    const barContent = barChunks.map(r => r.content).join('\n');
    expect(fooContent).not.toBe(barContent);
    expect(fooContent).toContain('foo-only-A');
    expect(barContent).toContain('bar-only-A');

    const fooMeta = JSON.parse(fooChunks[0].metadata || '{}');
    const barMeta = JSON.parse(barChunks[0].metadata || '{}');
    expect(fooMeta.skill_name).toBe('foo');
    expect(barMeta.skill_name).toBe('bar');
  });

  it('is idempotent — second run on unchanged content short-circuits to unchanged', { timeout: 30_000 }, async () => {
    writeSkill(root, 'foo', makeSkillBody('foo'));

    const first = runIndexer(root);
    expect(first.status).toBe(0);

    const dbPath = join(root, '.moflo', 'moflo.db');
    // The skip-if-unchanged check reads docContentHash off `chunk-skill-foo-0`
    // (post-#1053-S4), so chunk-0 is the load-bearing fixture for idempotency.
    const before = await readMemoryRows(dbPath, 'chunk-skill-foo-0');
    expect(before.length).toBe(1);
    const idBefore = before[0].id;

    const second = runIndexer(root);
    expect(second.status).toBe(0);

    // The indexer regenerates the row id on every storeEntry call (`mem_<ts>_<rand>`).
    // If the short-circuit fires, storeEntry is never called and the id is preserved.
    // The summary line `Documents indexed: 0` corroborates: nothing was re-written.
    expect(second.stdout).toMatch(/Documents indexed:\s*0/);

    const after = await readMemoryRows(dbPath, 'chunk-skill-foo-0');
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

describe('bin/index-guidance.mjs — SDD specs are excluded from the index', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });
  afterEach(() => {
    cleanTempRoot(root);
  });

  // Cross-platform: split the /-written relative dir, join with the OS separator.
  function writeSpec(specsRel: string, slug: string) {
    const dir = join(root, ...specsRel.split('/'), slug);
    mkdirSync(dir, { recursive: true });
    const padA = 'Acceptance criterion detail that clears the chunker floor. '.repeat(6);
    const padB = 'Second section body padded past the minimum chunk size. '.repeat(6);
    writeFileSync(
      join(dir, 'spec.md'),
      [
        '---',
        'kind: spec',
        `slug: ${slug}`,
        `title: "${slug}"`,
        'status: draft',
        'created: 2026-01-01T00:00:00.000Z',
        'updated: 2026-01-01T00:00:00.000Z',
        '---',
        '',
        `# ${slug}`,
        '',
        '## Acceptance Criteria',
        '',
        `- ${padA}`,
        '',
        '## Notes',
        '',
        padB,
        '',
      ].join('\n'),
    );
  }

  it('does not index specs from the default .moflo/specs', { timeout: 30_000 }, async () => {
    writeSpec('.moflo/specs', 'my-feature');

    const result = runIndexer(root);
    expect(result.status).toBe(0);

    const dbPath = join(root, '.moflo', 'moflo.db');
    expect((await readMemoryRows(dbPath, 'chunk-spec-%')).length).toBe(0);
    expect((await readMemoryRows(dbPath, '%my-feature%')).length).toBe(0);
  });

  it('does not index specs from a configured specs_dir', { timeout: 30_000 }, async () => {
    // The blank line between sdd keys is the #1294 parser regression: a naive
    // contiguous-line regex silently falls back to .moflo/specs. The parse must
    // still resolve `sdd-artifacts` — now so the dir can be EXCLUDED, where
    // before it decided what to include. A silent fallback would leave the
    // configured dir indexed as ordinary guidance.
    writeFileSync(join(root, 'moflo.yaml'), 'sdd:\n  default: false\n\n  specs_dir: sdd-artifacts\n');
    writeSpec('sdd-artifacts', 'my-feature');

    const result = runIndexer(root);
    expect(result.status).toBe(0);

    const dbPath = join(root, '.moflo', 'moflo.db');
    expect((await readMemoryRows(dbPath, 'chunk-spec-%')).length).toBe(0);
    expect((await readMemoryRows(dbPath, '%my-feature%')).length).toBe(0);
  });

  it('excludes specs even when specs_dir sits inside a guidance dir', { timeout: 30_000 }, async () => {
    // The config moflo-sdd.md recommends for REVIEWABLE specs: a tracked
    // specs_dir under a guidance directory. Merely dropping the dedicated spec
    // step would leave the guidance walk picking these up as ordinary markdown
    // under the guidance prefix — the same pollution, harder to spot. Sibling
    // guidance in the same dir must survive, proving the prune is scoped to the
    // specs subtree and not the whole guidance dir.
    writeFileSync(
      join(root, 'moflo.yaml'),
      ['guidance:', '  directories:', '    - docs', 'sdd:', '  specs_dir: docs/specs', ''].join('\n'),
    );
    writeSpec('docs/specs', 'inside-guidance');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(
      join(root, 'docs', 'real-guidance.md'),
      ['# Real guidance', '', '## A section', '', 'Body padded past the chunker floor. '.repeat(4), ''].join('\n'),
    );

    const result = runIndexer(root);
    expect(result.status).toBe(0);

    const dbPath = join(root, '.moflo', 'moflo.db');
    expect((await readMemoryRows(dbPath, 'chunk-spec-%')).length).toBe(0);
    expect((await readMemoryRows(dbPath, '%inside-guidance%')).length).toBe(0);
    // The guidance dir itself is still indexed — only the specs subtree is pruned.
    expect((await readMemoryRows(dbPath, '%real-guidance%')).length).toBeGreaterThan(0);
  });

  it('does not prune a sibling dir sharing the specs_dir name prefix', { timeout: 30_000 }, async () => {
    // `docs/specs` must not also prune `docs/specs-guide` — the exclusion
    // matches on a path.sep boundary, not a raw string prefix.
    writeFileSync(
      join(root, 'moflo.yaml'),
      ['guidance:', '  directories:', '    - docs', 'sdd:', '  specs_dir: docs/specs', ''].join('\n'),
    );
    mkdirSync(join(root, 'docs', 'specs-guide'), { recursive: true });
    writeFileSync(
      join(root, 'docs', 'specs-guide', 'how-to-spec.md'),
      ['# How to spec', '', '## A section', '', 'Body padded past the chunker floor. '.repeat(4), ''].join('\n'),
    );

    const result = runIndexer(root);
    expect(result.status).toBe(0);

    const dbPath = join(root, '.moflo', 'moflo.db');
    expect((await readMemoryRows(dbPath, '%how-to-spec%')).length).toBeGreaterThan(0);
  });
});

describe('bin/index-guidance.mjs — stale sweep for deleted files', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });
  afterEach(() => {
    cleanTempRoot(root);
  });

  function writeGuidanceDoc(name: string) {
    const dir = join(root, '.claude', 'guidance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${name}.md`),
      [`# ${name}`, '', '## A section', '', `Body for ${name} padded past the chunker floor. `.repeat(4), ''].join('\n'),
    );
  }

  it('removes chunks for a guidance file deleted between runs', { timeout: 60_000 }, async () => {
    // Regression: the sweep keyed on `doc-*` rows, which #1053 S4 retired. On
    // any current install that query returns nothing, so deleting a file left
    // its chunks in the namespace permanently.
    writeGuidanceDoc('keeper');
    writeGuidanceDoc('doomed');

    expect(runIndexer(root).status).toBe(0);
    const dbPath = join(root, '.moflo', 'moflo.db');
    expect((await readMemoryRows(dbPath, '%doomed%')).length).toBeGreaterThan(0);

    rmSync(join(root, '.claude', 'guidance', 'doomed.md'));
    expect(runIndexer(root).status).toBe(0);

    expect((await readMemoryRows(dbPath, '%doomed%')).length).toBe(0);
    // The surviving file's chunks are untouched — including on the second run,
    // where it is skipped as `unchanged` rather than re-indexed. An unchanged
    // file must still count as live or the sweep would eat the whole namespace.
    expect((await readMemoryRows(dbPath, '%keeper%')).length).toBeGreaterThan(0);
  });

  it('sweeps chunks for a directory dropped from guidance.directories', { timeout: 60_000 }, async () => {
    // A dir removed from config is stale the same way a deleted file is: the
    // sweep diffs against what THIS run indexed, not against what exists on
    // disk. Pinned because it is a behaviour change — before the fix nothing
    // was ever swept, so a reconfigure left the old dir's chunks serving
    // results forever.
    //
    // Note this is why the sweep bails on an empty live set (see
    // cleanStaleEntries): that guard is a defensive backstop against a broken
    // install wiping the namespace, and is not reachable from here — moflo's
    // own bundled guidance always indexes, so a run is never truly empty.
    writeGuidanceDoc('keeper');
    expect(runIndexer(root).status).toBe(0);
    const dbPath = join(root, '.moflo', 'moflo.db');
    expect((await readMemoryRows(dbPath, '%keeper%')).length).toBeGreaterThan(0);

    writeFileSync(
      join(root, 'moflo.yaml'),
      ['guidance:', '  directories:', '    - docs', ''].join('\n'),
    );
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(
      join(root, 'docs', 'replacement.md'),
      ['# Replacement', '', '## A section', '', 'Body padded past the chunker floor. '.repeat(4), ''].join('\n'),
    );
    expect(runIndexer(root).status).toBe(0);

    expect((await readMemoryRows(dbPath, '%keeper%')).length).toBe(0);
    expect((await readMemoryRows(dbPath, '%replacement%')).length).toBeGreaterThan(0);
  });

  it('editing a doc does not wipe a sibling whose name extends it', { timeout: 60_000 }, async () => {
    // Regression: the per-file orphan sweep scoped itself with a bare SQL LIKE
    // on `chunk-guidance-foo-%`, which also matches every chunk of `foo-bar`.
    // Those rows are absent from foo's chunk list, so editing foo.md deleted
    // foo-bar.md's entire index. It came back only on the NEXT indexer run,
    // re-inserted with a NULL embedding — so a sibling doc silently dropped out
    // of search for a whole session and was then re-vectorised from scratch.
    // Real instance in this repo: the `flo` skill shadows `flo-simplify`.
    writeGuidanceDoc('foo');
    writeGuidanceDoc('foo-bar');

    expect(runIndexer(root).status).toBe(0);
    const dbPath = join(root, '.moflo', 'moflo.db');
    const before = (await readMemoryRows(dbPath, 'chunk-guidance-foo-bar-%')).length;
    expect(before).toBeGreaterThan(0);

    // Edit ONLY foo.md — foo-bar.md is untouched and must survive intact.
    writeFileSync(
      join(root, '.claude', 'guidance', 'foo.md'),
      ['# foo', '', '## A section', '', 'Edited body padded past the chunker floor. '.repeat(4), ''].join('\n'),
    );
    expect(runIndexer(root).status).toBe(0);

    expect((await readMemoryRows(dbPath, 'chunk-guidance-foo-bar-%')).length).toBe(before);
  });

  it('keeps chunks for a doc whose filename ends in digits', { timeout: 60_000 }, async () => {
    // `chunk-guidance-issue-1402-0` must reduce to `chunk-guidance-issue-1402`,
    // not `chunk-guidance-issue` — otherwise every such doc reads as stale and
    // is swept on the very next run.
    writeGuidanceDoc('issue-1402');

    expect(runIndexer(root).status).toBe(0);
    const dbPath = join(root, '.moflo', 'moflo.db');
    expect((await readMemoryRows(dbPath, '%issue-1402%')).length).toBeGreaterThan(0);

    // Second run: file unchanged, so it takes the `unchanged` path.
    expect(runIndexer(root).status).toBe(0);
    expect((await readMemoryRows(dbPath, '%issue-1402%')).length).toBeGreaterThan(0);
  });
});
