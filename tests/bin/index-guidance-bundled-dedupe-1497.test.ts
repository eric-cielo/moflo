/**
 * #1497 — shipped guidance and skills must be indexed exactly once.
 *
 * Session start syncs every shipped doc into `.claude/guidance/` and every
 * skill into `.claude/skills/<name>/`, and index-guidance then indexed both the
 * synced copy AND the bundled original in `node_modules/moflo` — so each hit
 * had a twin and a limit-6 search returned 3 distinct docs.
 *
 * The indexer resolves its "bundled" tree from its own location, so running it
 * from the source tree against a fixture project treats this repo's
 * `.claude/guidance/shipped` + `.claude/skills` as the bundled copies — exactly
 * the consumer layout. Paths via path.join throughout (Rule #1).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, realpathSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');
const INDEXER = join(REPO_ROOT, 'bin', 'index-guidance.mjs');
const SHIPPED_DIR = join(REPO_ROOT, '.claude', 'guidance', 'shipped');
const BUNDLED_SKILLS = join(REPO_ROOT, '.claude', 'skills');

// Two real shipped docs / skills: one gets a synced copy, one does not.
const SYNCED_DOC = 'moflo-core-guidance.md';
const UNSYNCED_DOC = 'moflo-task-icons.md';
const SYNCED_SKILL = 'healer';
const UNSYNCED_SKILL = 'ward';

function runIndexer(root: string) {
  const result = spawnSync('node', [INDEXER, '--no-embeddings'], {
    cwd: root,
    encoding: 'utf-8',
    timeout: 50_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, CI: '1', GIT_CEILING_DIRECTORIES: dirname(root) },
    input: '',
  });
  expect(result.status, `index-guidance failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
}

async function guidanceKeys(root: string): Promise<string[]> {
  const { openBackend } = await import('../../bin/lib/get-backend.mjs');
  const db = await openBackend(root, { dbPath: join(root, '.moflo', 'moflo.db') });
  try {
    const stmt = db.prepare(`SELECT key FROM memory_entries WHERE namespace = 'guidance'`);
    const keys: string[] = [];
    while (stmt.step()) keys.push(String(stmt.getAsObject().key));
    stmt.free();
    return keys;
  } finally {
    db.close();
  }
}

const has = (keys: string[], prefix: string) => keys.some(k => k.startsWith(prefix));
const stem = (file: string) => file.replace(/\.md$/, '');

function syncCopies(root: string) {
  mkdirSync(join(root, '.claude', 'guidance'), { recursive: true });
  copyFileSync(join(SHIPPED_DIR, SYNCED_DOC), join(root, '.claude', 'guidance', SYNCED_DOC));
  mkdirSync(join(root, '.claude', 'skills', SYNCED_SKILL), { recursive: true });
  copyFileSync(
    join(BUNDLED_SKILLS, SYNCED_SKILL, 'SKILL.md'),
    join(root, '.claude', 'skills', SYNCED_SKILL, 'SKILL.md'),
  );
}

describe('#1497 index-guidance — bundled twins of synced copies are not indexed', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-1497-guidance-')));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'guidance-fixture', version: '0.0.0' }));
    // Fixture guards: the chosen docs/skills must really ship, or the test proves nothing.
    expect(readdirSync(SHIPPED_DIR)).toEqual(expect.arrayContaining([SYNCED_DOC, UNSYNCED_DOC]));
    expect(readdirSync(BUNDLED_SKILLS)).toEqual(expect.arrayContaining([SYNCED_SKILL, UNSYNCED_SKILL]));
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('indexes each shipped doc and skill exactly once when the synced copy exists', { timeout: 60_000 }, async () => {
    syncCopies(root);
    runIndexer(root);
    const keys = await guidanceKeys(root);

    expect(has(keys, `chunk-guidance-${stem(SYNCED_DOC)}-`)).toBe(true);
    expect(has(keys, `chunk-moflo-bundled-${stem(SYNCED_DOC)}-`)).toBe(false);
    // No synced copy → the bundled doc is the only copy and must still index.
    expect(has(keys, `chunk-moflo-bundled-${stem(UNSYNCED_DOC)}-`)).toBe(true);

    expect(has(keys, `chunk-skill-${SYNCED_SKILL}-`)).toBe(true);
    expect(has(keys, `chunk-skill-bundled-${SYNCED_SKILL}-`)).toBe(false);
    expect(has(keys, `chunk-skill-bundled-${UNSYNCED_SKILL}-`)).toBe(true);
  });

  it('reindexing after the sync removes previously written bundled twins', { timeout: 90_000 }, async () => {
    runIndexer(root);
    let keys = await guidanceKeys(root);
    expect(has(keys, `chunk-moflo-bundled-${stem(SYNCED_DOC)}-`)).toBe(true);
    expect(has(keys, `chunk-skill-bundled-${SYNCED_SKILL}-`)).toBe(true);

    syncCopies(root);
    runIndexer(root);
    keys = await guidanceKeys(root);
    expect(has(keys, `chunk-moflo-bundled-${stem(SYNCED_DOC)}-`)).toBe(false);
    expect(has(keys, `chunk-skill-bundled-${SYNCED_SKILL}-`)).toBe(false);
  });

  it('keeps the bundled doc when .claude/guidance is not a configured directory', { timeout: 60_000 }, async () => {
    // The synced copy exists but is never indexed — shadowing it would drop the doc entirely.
    writeFileSync(join(root, 'moflo.yaml'), 'guidance:\n  directories:\n    - docs\n');
    mkdirSync(join(root, 'docs'), { recursive: true });
    syncCopies(root);
    runIndexer(root);
    const keys = await guidanceKeys(root);
    expect(has(keys, `chunk-moflo-bundled-${stem(SYNCED_DOC)}-`)).toBe(true);
  });
});
