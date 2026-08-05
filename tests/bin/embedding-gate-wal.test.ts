/**
 * Regression tests for #1383 — `build-embeddings` skipped while rows sat
 * unembedded.
 *
 * The bug: the step was gated on `stat(.moflo/moflo.db).mtime`. The database
 * runs in WAL mode, so the indexer's row writes land in `moflo.db-wal` and
 * never move the main file. The gate read "unchanged" and skipped the step
 * that embeds rows written seconds earlier in the same chain — leaving chunks
 * present in `memory_entries` but invisible to `memory_search`, with recovery
 * only when some later WAL checkpoint incidentally bumped the main file.
 *
 * These tests drive the real thing: a real WAL-mode DB with a connection held
 * OPEN across the writes, which is what keeps the log un-checkpointed. That
 * detail is the bug's precondition, not incidental scaffolding — SQLite
 * checkpoints and unlinks `-wal` when the last connection closes, and that
 * checkpoint is precisely the accident that used to un-wedge a consumer. A
 * long-lived writer (moflo's daemon) is the normal state, and it is why the
 * skip persisted across restarts in the field.
 *
 * `pinMtime` additionally freezes the main file's mtime so the assertion does
 * not depend on filesystem timestamp granularity or on how fast the suite runs.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, statSync, utimesSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

import {
  decideStepGate,
  computeStepFingerprint,
  saveStepFingerprint,
  readSavedStepFingerprint,
  fingerprintsEqual,
  probeStepWork,
} from '../../bin/lib/index-fingerprint.mjs';
import { hasPendingEmbeddings, PENDING_EMBEDDING_WHERE } from '../../bin/lib/embedding-backlog.mjs';
import { openBackendSync } from '../../bin/lib/get-backend.mjs';
import { MOFLO_DIR, MEMORY_DB_FILE } from '../../src/cli/services/moflo-paths.js';

const SCHEMA = `
  CREATE TABLE memory_entries (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    namespace TEXT DEFAULT 'default',
    content TEXT NOT NULL,
    embedding TEXT,
    embedding_model TEXT DEFAULT 'local',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    status TEXT DEFAULT 'active',
    UNIQUE(namespace, key)
  )
`;

/**
 * The columns `applyIncrementalChunks` writes — a superset of {@link SCHEMA},
 * needed only by the end-to-end block below.
 */
const CHUNK_SCHEMA = `
  CREATE TABLE memory_entries (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    namespace TEXT DEFAULT 'default',
    content TEXT NOT NULL,
    type TEXT DEFAULT 'semantic',
    embedding TEXT,
    embedding_model TEXT DEFAULT 'local',
    embedding_dimensions INTEGER,
    tags TEXT,
    metadata TEXT,
    owner_id TEXT,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    last_accessed_at INTEGER,
    access_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    UNIQUE(namespace, key)
  )
`;

const DIM = 8;

/**
 * File URL of the real `get-backend` module, for the child process to import.
 * A URL — not a path — because a Windows path is not a valid ESM specifier.
 */
const getBackendUrl = pathToFileURL(
  resolve(__dirname, '..', '..', 'bin', 'lib', 'get-backend.mjs'),
).href;

/** Deterministic stand-in for the real embedder — a vector is a function of text. */
function vectorFor(content: string): number[] {
  return Array.from({ length: DIM }, (_, j) =>
    Number(Math.sin(content.length * 0.9 + j * 0.4).toFixed(6)),
  );
}

const roots: string[] = [];
const openHandles: Array<{ close: () => void }> = [];

function dbPathOf(root: string): string {
  return join(root, MOFLO_DIR, MEMORY_DB_FILE);
}

/** Open the store the way every bin/ script does — WAL pragmas included. */
function openStore(root: string) {
  return openBackendSync(root, { dbPath: dbPathOf(root) });
}

/**
 * A project whose store is held open by a long-lived writer, as moflo's daemon
 * holds it. Writes therefore accumulate in `-wal` and never checkpoint.
 */
function makeRoot(schema = SCHEMA): { root: string; writer: ReturnType<typeof openStore> } {
  const root = mkdtempSync(join(tmpdir(), 'moflo-1383-'));
  roots.push(root);
  mkdirSync(join(root, MOFLO_DIR));
  const writer = openStore(root);
  openHandles.push(writer);
  writer.run(schema);
  return { root, writer };
}

function insertRow(
  writer: ReturnType<typeof openStore>,
  id: string,
  embedding: string | null,
): void {
  writer.run(
    `INSERT INTO memory_entries (id, key, namespace, content, embedding, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
    [id, `key-${id}`, 'guidance', `content for ${id}`, embedding],
  );
}

/**
 * Stand-in for `build-embeddings`: select the backlog with the SAME exported
 * clause the gate probes on, and fill it. Returns how many rows it embedded.
 */
function embedBacklog(writer: ReturnType<typeof openStore>): number {
  const stmt = writer.prepare(
    `SELECT id, content FROM memory_entries WHERE ${PENDING_EMBEDDING_WHERE}`,
  );
  const pending: Array<{ id: string; content: string }> = [];
  while (stmt.step()) pending.push(stmt.getAsObject() as { id: string; content: string });
  stmt.free();

  for (const { id, content } of pending) {
    writer.run(
      `UPDATE memory_entries SET embedding = ?, embedding_dimensions = ?, updated_at = ? WHERE id = ?`,
      [JSON.stringify(vectorFor(content)), DIM, 1_700_000_000_000, id],
    );
  }
  return pending.length;
}

function idForKey(writer: ReturnType<typeof openStore>, key: string): string {
  const stmt = writer.prepare(`SELECT id FROM memory_entries WHERE key = ?`);
  stmt.bind([key]);
  stmt.step();
  const row = stmt.getAsObject() as { id: string };
  stmt.free();
  return row.id;
}

/**
 * Close every handle BEFORE removing the directories. Windows holds a
 * mandatory lock on an open SQLite file, so an rmSync ahead of the close
 * fails with EPERM/EBUSY there while passing silently on POSIX.
 */
function cleanup(): void {
  for (const h of openHandles.splice(0)) {
    try { h.close(); } catch { /* already closed */ }
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

/**
 * Hold `moflo.db`'s mtime at `at` — the WAL behaviour the bug depended on,
 * made explicit so the assertion isn't at the mercy of mtime granularity.
 */
function pinMtime(root: string, at: Date): void {
  utimesSync(dbPathOf(root), at, at);
}

/**
 * Capture, then later restore, the mtimes of the whole SQLite file set — the
 * hostile case where the filesystem gives up no signal at all. This is what
 * isolates the work probe from the WAL-aware fingerprint: with every timestamp
 * rewound to its pre-write value, only a real look at the data can decide
 * whether the step has something to do.
 */
const FROZEN_AT = new Date(1_700_000_000_000); // whole seconds — round-trips exactly

function freezeMtimes(root: string): void {
  for (const p of [dbPathOf(root), `${dbPathOf(root)}-wal`]) {
    if (existsSync(p)) utimesSync(p, FROZEN_AT, FROZEN_AT);
  }
}

describe('build-embeddings gate under WAL (#1383)', () => {
  afterEach(cleanup);

  it('runs when unembedded rows exist even though moflo.db mtime never moved', () => {
    const { root, writer } = makeRoot();
    insertRow(writer, 'embedded-1', JSON.stringify([0.1, 0.2]));

    // Session 1 equilibrium: the step ran, the post-run fingerprint was saved.
    saveStepFingerprint('build-embeddings', root, computeStepFingerprint('build-embeddings', root));
    expect(decideStepGate('build-embeddings', root, {})).toEqual({ skip: true, reason: 'unchanged' });

    const pinned = new Date(statSync(dbPathOf(root)).mtime);

    // The indexer writes new chunks with no embedding — into the WAL, with the
    // writer still connected so nothing checkpoints.
    insertRow(writer, 'pending-1', null);
    insertRow(writer, 'pending-2', '');
    pinMtime(root, pinned); // main file untouched, exactly as WAL leaves it

    // Pre-#1383 this returned { skip: true, reason: 'unchanged' } and the rows
    // stayed unembedded and unsearchable. Stat'ing the WAL is enough to catch
    // it — the first of the two layers.
    expect(decideStepGate('build-embeddings', root, {})).toEqual({
      skip: false,
      reason: 'inputs-changed',
    });
  });

  it('runs on a backlog even when every mtime is frozen — the second layer', () => {
    const { root, writer } = makeRoot();
    insertRow(writer, 'embedded-1', JSON.stringify([0.1]));
    freezeMtimes(root);
    saveStepFingerprint('build-embeddings', root, computeStepFingerprint('build-embeddings', root));

    insertRow(writer, 'pending-1', null);
    // Deny the gate every filesystem signal there is. A coarse-granularity or
    // timestamp-restoring filesystem, or a checkpoint that rewinds an mtime,
    // puts the gate here — and mtimes are a proxy, so the fix cannot rest on
    // them alone. Only reading the data answers this.
    freezeMtimes(root);

    // Precondition: the fingerprint genuinely still matches, so the probe is
    // demonstrably the thing forcing the run and not a stale-mtime accident.
    expect(
      fingerprintsEqual(
        computeStepFingerprint('build-embeddings', root),
        readSavedStepFingerprint('build-embeddings', root),
      ),
    ).toBe(true);
    expect(decideStepGate('build-embeddings', root, {})).toEqual({
      skip: false,
      reason: 'work-pending',
    });
  });

  it('a WAL-only write with no backlog still invalidates the fingerprint', () => {
    const { root, writer } = makeRoot();
    saveStepFingerprint('build-embeddings', root, computeStepFingerprint('build-embeddings', root));

    const pinned = new Date(statSync(dbPathOf(root)).mtime);
    insertRow(writer, 'embedded-1', JSON.stringify([0.3]));
    pinMtime(root, pinned);

    expect(existsSync(`${dbPathOf(root)}-wal`)).toBe(true);
    // No backlog, so the probe abstains — the WAL-aware fingerprint is what
    // still notices the store changed and refreshes the derived artifacts.
    expect(probeStepWork('build-embeddings', root)).toBe(false);
    expect(decideStepGate('build-embeddings', root, {})).toEqual({
      skip: false,
      reason: 'inputs-changed',
    });
  });

  it('hnsw-rebuild sees WAL-only writes too — it shared the blind spot', () => {
    const { root, writer } = makeRoot();
    insertRow(writer, 'embedded-1', JSON.stringify([0.4]));
    saveStepFingerprint('hnsw-rebuild', root, computeStepFingerprint('hnsw-rebuild', root));
    expect(decideStepGate('hnsw-rebuild', root, {})).toEqual({ skip: true, reason: 'unchanged' });

    const pinned = new Date(statSync(dbPathOf(root)).mtime);
    insertRow(writer, 'embedded-2', JSON.stringify([0.5]));
    pinMtime(root, pinned);

    expect(decideStepGate('hnsw-rebuild', root, {})).toEqual({
      skip: false,
      reason: 'inputs-changed',
    });
  });

  it('still skips when there is genuinely nothing to do', () => {
    const { root, writer } = makeRoot();
    insertRow(writer, 'embedded-1', JSON.stringify([0.6]));
    saveStepFingerprint('build-embeddings', root, computeStepFingerprint('build-embeddings', root));

    expect(decideStepGate('build-embeddings', root, {})).toEqual({ skip: true, reason: 'unchanged' });
  });

  it('probing does not perturb the fingerprint it is paired with', () => {
    const { root, writer } = makeRoot();
    insertRow(writer, 'embedded-1', JSON.stringify([0.65]));
    saveStepFingerprint('build-embeddings', root, computeStepFingerprint('build-embeddings', root));

    // A read-only SQLite open materialises -wal/-shm when they are absent. If
    // the gate probed before reading its inputs, that side effect would read
    // as an input change and re-run the step on every quiet session.
    for (let i = 0; i < 3; i++) {
      expect(decideStepGate('build-embeddings', root, {})).toEqual({
        skip: true,
        reason: 'unchanged',
      });
    }
  });

  it('a backlog overrides a matching fingerprint — the probe cannot be vetoed', () => {
    const { root, writer } = makeRoot();
    insertRow(writer, 'pending-1', null);

    // Simulate a run that "succeeded" but left the row unembedded: the POST
    // fingerprint is saved and matches on the next session. Fingerprint-only
    // gating would skip forever; the probe forces the retry.
    saveStepFingerprint('build-embeddings', root, computeStepFingerprint('build-embeddings', root));

    expect(decideStepGate('build-embeddings', root, {})).toEqual({
      skip: false,
      reason: 'work-pending',
    });
  });

  it('FLO_FORCE_INDEX still wins over everything', () => {
    const { root } = makeRoot();
    saveStepFingerprint('build-embeddings', root, computeStepFingerprint('build-embeddings', root));

    expect(decideStepGate('build-embeddings', root, { FLO_FORCE_INDEX: '1' })).toEqual({
      skip: false,
      reason: 'forced',
    });
  });
});

describe('hasPendingEmbeddings (#1383)', () => {
  afterEach(cleanup);

  it('distinguishes "no work" from "cannot tell"', () => {
    const bare = mkdtempSync(join(tmpdir(), 'moflo-1383-bare-'));
    roots.push(bare);
    expect(hasPendingEmbeddings(bare)).toBeNull(); // no DB yet

    const noSchema = mkdtempSync(join(tmpdir(), 'moflo-1383-'));
    roots.push(noSchema);
    mkdirSync(join(noSchema, MOFLO_DIR));
    const handle = openStore(noSchema); // DB exists, memory_entries does not
    openHandles.push(handle);
    expect(hasPendingEmbeddings(noSchema)).toBeNull();

    const { root: clean, writer } = makeRoot();
    insertRow(writer, 'embedded-1', JSON.stringify([0.7]));
    expect(hasPendingEmbeddings(clean)).toBe(false);
  });

  it('counts NULL and empty-string embeddings, ignores inactive rows', () => {
    const { root, writer } = makeRoot();
    insertRow(writer, 'embedded-1', JSON.stringify([0.8]));
    expect(hasPendingEmbeddings(root)).toBe(false);

    writer.run(
      `INSERT INTO memory_entries (id, key, namespace, content, embedding, status)
       VALUES ('archived-1', 'k-archived', 'guidance', 'c', NULL, 'archived')`,
    );
    expect(hasPendingEmbeddings(root)).toBe(false); // status filter holds

    insertRow(writer, 'pending-empty', '');
    expect(hasPendingEmbeddings(root)).toBe(true);
  });

  it('does not create .moflo state just by asking', () => {
    const bare = mkdtempSync(join(tmpdir(), 'moflo-1383-bare-'));
    roots.push(bare);
    expect(hasPendingEmbeddings(bare)).toBeNull();
    expect(existsSync(join(bare, MOFLO_DIR))).toBe(false);
  });
});

/**
 * The user-visible end of #1383: a doc gets a new section, and that section is
 * findable. This drives the real chain order — indexer writes chunks, gate
 * decides, embedder fills the backlog, sidecar reconciles — with the store held
 * open throughout so nothing checkpoints.
 *
 * Retrieval is asserted at the HNSW graph layer, which is what `memory_search`
 * queries. The MCP tool itself is not exercised because that would require
 * loading the real fastembed model (~90MB, several seconds); the stub embedder
 * here is deterministic on content, which is what makes the assertion sharp.
 */
describe('doc append → gate → embed → searchable (#1383)', () => {
  afterEach(cleanup);

  it('a section appended to an indexed doc becomes retrievable in the same chain', async () => {
    const { applyIncrementalChunks } = await import('../../bin/lib/incremental-write.mjs');
    const { syncHnswSidecar, tryLoadHnswSidecar } =
      await import('../../src/cli/memory/hnsw-persistence.js');

    const { root, writer } = makeRoot(CHUNK_SCHEMA);

    const chunks = [
      { key: 'doc:1', content: 'the first section' },
      { key: 'doc:2', content: 'the second section' },
    ];
    applyIncrementalChunks(writer, 'guidance', chunks);

    // Settle the gate as a prior session would have, then pin the main file so
    // only the WAL reflects what the indexer just wrote.
    const pinned = new Date(statSync(dbPathOf(root)).mtime);
    saveStepFingerprint('build-embeddings', root, computeStepFingerprint('build-embeddings', root));
    pinMtime(root, pinned);

    // Either layer may be the one that fires here; what the chain guarantees
    // is that the step is not skipped while rows await embedding.
    expect(decideStepGate('build-embeddings', root, {}).skip).toBe(false);
    expect(embedBacklog(writer)).toBe(2);
    await syncHnswSidecar(dbPathOf(root), root, { dimensions: DIM });

    // The doc gains a section. The indexer rewrites its chunk list; only the
    // new one lacks an embedding.
    applyIncrementalChunks(writer, 'guidance', [
      ...chunks,
      { key: 'doc:3', content: 'a freshly appended third section' },
    ]);
    pinMtime(root, pinned);

    expect(decideStepGate('build-embeddings', root, {}).skip).toBe(false);
    expect(embedBacklog(writer)).toBe(1);
    await syncHnswSidecar(dbPathOf(root), root, { dimensions: DIM });

    expect(hasPendingEmbeddings(root)).toBe(false);

    const appendedId = idForKey(writer, 'doc:3');
    const graph = tryLoadHnswSidecar(root)!;
    expect(graph).not.toBeNull();
    const hits = graph.search(new Float32Array(vectorFor('a freshly appended third section')), 1);
    expect(hits[0].id).toBe(appendedId);
  });
});

/**
 * The probe must answer correctly while a SEPARATE PROCESS holds the store —
 * the normal state in the field, where moflo's daemon is connected for the
 * life of the session. Everything above runs the writer in-process, which
 * never contends for the same locks.
 */
describe('probe under cross-process contention (#1383)', () => {
  afterEach(cleanup);

  it('sees a backlog written by another process that still holds the DB open', async () => {
    const { root, writer } = makeRoot();
    // Release the in-process handle; the child becomes the sole live writer.
    writer.close();

    const holderScript = join(root, 'holder.mjs');
    writeFileSync(
      holderScript,
      [
        `import { openBackendSync } from ${JSON.stringify(getBackendUrl)};`,
        `const db = openBackendSync(${JSON.stringify(root)}, { dbPath: ${JSON.stringify(dbPathOf(root))} });`,
        `db.run("INSERT INTO memory_entries (id, key, namespace, content, embedding, status) `
          + `VALUES ('pending-x', 'k-x', 'guidance', 'c', NULL, 'active')");`,
        // Hold the connection open indefinitely so nothing checkpoints.
        `process.stdout.write('ready\\n');`,
        `setInterval(() => {}, 1000);`,
      ].join('\n'),
    );

    const child = spawn(process.execPath, [holderScript], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error('holder never signalled ready')), 20_000);
        let buf = '';
        child.stdout.on('data', (d) => {
          buf += String(d);
          if (buf.includes('ready')) {
            clearTimeout(timer);
            resolveReady();
          }
        });
        child.on('error', (e) => { clearTimeout(timer); rejectReady(e); });
        child.on('exit', (code) => {
          clearTimeout(timer);
          rejectReady(new Error(`holder exited early with code ${code}`));
        });
      });

      expect(hasPendingEmbeddings(root)).toBe(true);
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
  }, 30_000);
});

/**
 * A read-only open must not acquire a retry budget it was not asked for.
 *
 * `session-continuity.mjs` and `semantic-search.mjs` both open read-only
 * inside the session-start chain and are written to fail fast and degrade.
 * Blanket-applying the writer's 15s budget to every read-only open turned
 * their instant SQLITE_BUSY into a 15-second block, serialising the chain
 * behind whatever held the lock — which is how `flo doctor` hit its 60s
 * timeout on the Windows populated smoke while every POSIX job stayed green.
 */
describe('read-only busy budget is opt-in (#1383)', () => {
  it('get-backend only sets busy_timeout on a read-only open when asked', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'bin', 'lib', 'get-backend.mjs'), 'utf-8');
    const readOnlyBranch = src.slice(
      src.indexOf('if (readOnly) {'),
      src.indexOf('} else {', src.indexOf('if (readOnly) {')),
    );
    expect(readOnlyBranch).toContain('busyTimeoutMs');
    // No unconditional budget in the read-only branch.
    expect(readOnlyBranch).not.toMatch(/PRAGMA busy_timeout = \d+/);
  });

  it('a read-only handle opened without a budget still works', () => {
    const { root, writer } = makeRoot();
    insertRow(writer, 'embedded-1', JSON.stringify([0.9]));
    const reader = openBackendSync(root, { dbPath: dbPathOf(root), readOnly: true });
    openHandles.push(reader);
    const rows = reader.exec(`SELECT COUNT(*) AS n FROM memory_entries`);
    expect(Number(rows[0].values[0][0])).toBe(1);
  });

  it('the probe asks for a budget, and a short one', async () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'bin', 'lib', 'embedding-backlog.mjs'), 'utf-8');
    expect(src).toMatch(/busyTimeoutMs:\s*PROBE_BUSY_TIMEOUT_MS/);
    const budget = Number(/PROBE_BUSY_TIMEOUT_MS\s*=\s*(\d+)/.exec(src)?.[1]);
    expect(budget).toBeGreaterThan(0);
    // Sits in the session-start critical path — must stay well under the
    // writer's 15s, which is sized for a very different job.
    expect(budget).toBeLessThanOrEqual(5000);
  });
});

describe('gate/producer predicate parity (#1383)', () => {
  it('build-embeddings selects on the exported clause rather than restating it', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'bin', 'build-embeddings.mjs'), 'utf-8');
    expect(src).toMatch(/import\s*\{\s*PENDING_EMBEDDING_WHERE\s*\}\s*from\s*'\.\/lib\/embedding-backlog\.mjs'/);
    // The selection query must be built from the shared constant, not from an
    // inline copy of the clause. (The namespace-stats summary further down the
    // file legitimately mentions the same columns; this pins the SELECT that
    // decides what gets embedded.)
    expect(src).toMatch(/WHERE\s*`?\s*\n?\s*\+?\s*\(forceAll\s*\?[^)]*:\s*PENDING_EMBEDDING_WHERE\)/);
  });

  it('the exported clause is the one that filters unembedded active rows', () => {
    expect(PENDING_EMBEDDING_WHERE).toContain(`status = 'active'`);
    expect(PENDING_EMBEDDING_WHERE).toContain(`embedding IS NULL`);
    expect(PENDING_EMBEDDING_WHERE).toContain(`embedding = ''`);
  });
});
