/**
 * System verification for #1061 — cross-process writer race under node:sqlite + WAL.
 *
 * Original repro (from the issue body):
 *   "hooks.mjs session-start forks daemon + indexer chain at the same instant.
 *    They each open their own sql.js handle and write to .moflo/moflo.db via
 *    atomic-write. If the daemon performs any write during the seconds-to-minutes
 *    the indexer chain runs, its next flush overwrites the indexer's on-disk
 *    state with the daemon's stale in-RAM snapshot."
 *
 * Status post #1096 (epic #1078 Phase 4):
 *   sql.js is retired. Every bin/* and TS writer routes through
 *   `bin/lib/get-backend.mjs::openBackend()` → `node:sqlite` with WAL +
 *   busy_timeout. SQLite serializes page-level writes via the OS file lock;
 *   there is no whole-file flush that can clobber another writer.
 *
 * This test reproduces the exact shape of the original race — N real OS
 * subprocesses, each opening `.moflo/moflo.db` through the canonical factory
 * consumers use, each doing M writes concurrently — and asserts no row loss.
 * Under sql.js this would have lost rows (last-flusher-wins). Under WAL it
 * must be lossless and order-independent.
 *
 * Closes the verification AC on issue #1061 (acceptance: re-test against
 * original repro post-migration; close on proof of non-reproduction).
 *
 * Cross-platform: spawns via `process.execPath`, paths via node:path,
 * cleanup tolerant of Windows WAL/shm handle release latency.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openBackend } from '../../bin/lib/get-backend.mjs';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FACTORY_PATH = path.join(REPO_ROOT, 'bin', 'lib', 'get-backend.mjs');

interface WriterResult {
  role: string;
  written: number;
}

type WriteShape = 'autocommit' | 'transaction';

function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `moflo-1061-${prefix}-`));
}

function cleanupRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* best-effort — Windows can hold a brief WAL/shm sidecar lock */
  }
}

/**
 * Spawn one writer subprocess. The subprocess imports the SAME factory that
 * bin/* scripts use (the path consumers exercise), opens .moflo/moflo.db, and
 * writes `rowCount` rows tagged with `role`. Returns parsed result JSON.
 *
 * `shape` controls the transaction wrapping:
 *   - 'autocommit' — one implicit transaction per INSERT. Matches the
 *     bin/index-*.mjs indexer chain.
 *   - 'transaction' — single explicit `BEGIN IMMEDIATE` … `COMMIT` around
 *     the loop. Matches src/cli/memory/sqlite-backend.ts:withTransaction
 *     and controllers/batch-operations.ts (the daemon's actual write path).
 *
 * Mixing shapes is deliberate: #1061's failure scenario is specifically the
 * indexer (autocommit) competing with the daemon (BEGIN IMMEDIATE batch),
 * which is the contention pattern that surfaced the busy_handler trap fixed
 * in #1099. Uniform autocommit would weaken the verification.
 */
function spawnWriter(
  projectRoot: string,
  scriptDir: string,
  role: string,
  rowCount: number,
  shape: WriteShape,
): Promise<WriterResult> {
  const factoryUrl = 'file://' + FACTORY_PATH.replace(/\\/g, '/');
  const scriptPath = path.join(scriptDir, `writer-${role}.mjs`);
  // Single-quoted JSON literals inside the inline script keep injection-free.
  const script = `
    import { openBackend } from ${JSON.stringify(factoryUrl)};
    const projectRoot = ${JSON.stringify(projectRoot)};
    const role = ${JSON.stringify(role)};
    const rowCount = ${rowCount};
    const shape = ${JSON.stringify(shape)};
    const db = await openBackend(projectRoot);
    try {
      const ins = db.prepare('INSERT INTO cross_writes (role, idx) VALUES (?, ?)');
      if (shape === 'transaction') db.run('BEGIN IMMEDIATE');
      try {
        for (let i = 0; i < rowCount; i++) {
          ins.run([role, i]);
        }
        if (shape === 'transaction') db.run('COMMIT');
      } catch (err) {
        if (shape === 'transaction') {
          try { db.run('ROLLBACK'); } catch { /* already closed */ }
        }
        throw err;
      } finally {
        ins.free();
      }
    } finally {
      db.close();
    }
    process.stdout.write(JSON.stringify({ role, written: rowCount }));
  `;
  fs.writeFileSync(scriptPath, script);

  return new Promise<WriterResult>((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: {
        ...process.env,
        // Pin the subprocess's project-root resolver to the temp DB. Today
        // openBackend takes projectRoot explicitly so this is belt-and-braces;
        // if the resolver ever becomes load-bearing for a sub-helper, this
        // prevents the subprocess from walking up into the moflo repo and
        // corrupting the real .moflo/moflo.db. See feedback_unified_project_root_resolver.
        CLAUDE_PROJECT_DIR: projectRoot,
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    child.on('error', reject);
    child.on('close', (code) => {
      try { fs.unlinkSync(scriptPath); } catch { /* best-effort */ }
      if (code !== 0) {
        reject(new Error(`writer "${role}" exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`writer "${role}" produced unparsable stdout: ${stdout} (${String(err)})`));
      }
    });
  });
}

/**
 * Seed the schema in the parent so the writer subprocesses only execute their
 * INSERT loop. Mirrors the production shape: the bridge runs migrations
 * pre-boot (#1057), and the indexer/daemon writers find the schema already in
 * place when they open.
 */
async function seedSchema(projectRoot: string): Promise<void> {
  const db = await openBackend(projectRoot);
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS cross_writes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        idx INTEGER NOT NULL
      )
    `);
  } finally {
    db.close();
  }
}

interface RowCounts {
  total: number;
  perRole: Map<string, number>;
}

async function countRows(projectRoot: string): Promise<RowCounts> {
  const db = await openBackend(projectRoot, { readOnly: true });
  try {
    const result = db.exec('SELECT role, COUNT(*) as n FROM cross_writes GROUP BY role');
    const perRole = new Map<string, number>();
    let total = 0;
    if (result.length > 0) {
      for (const row of result[0].values) {
        const role = String(row[0]);
        const n = Number(row[1]);
        perRole.set(role, n);
        total += n;
      }
    }
    return { total, perRole };
  } finally {
    db.close();
  }
}

describe('System verification — cross-process writer race (#1061)', () => {
  let projectRoot: string;
  let scriptDir: string;

  beforeEach(async () => {
    projectRoot = makeTempRoot('proj');
    scriptDir = makeTempRoot('scripts');
    await seedSchema(projectRoot);
  });

  afterEach(() => {
    cleanupRoot(projectRoot);
    cleanupRoot(scriptDir);
  });

  it('two concurrent writers (indexer autocommit + daemon BEGIN IMMEDIATE) lose no rows', async () => {
    const ROWS_PER_WRITER = 200;
    const [a, b] = await Promise.all([
      spawnWriter(projectRoot, scriptDir, 'indexer', ROWS_PER_WRITER, 'autocommit'),
      spawnWriter(projectRoot, scriptDir, 'daemon', ROWS_PER_WRITER, 'transaction'),
    ]);

    expect(a.written).toBe(ROWS_PER_WRITER);
    expect(b.written).toBe(ROWS_PER_WRITER);

    const counts = await countRows(projectRoot);
    expect(counts.total).toBe(ROWS_PER_WRITER * 2);
    expect(counts.perRole.get('indexer')).toBe(ROWS_PER_WRITER);
    expect(counts.perRole.get('daemon')).toBe(ROWS_PER_WRITER);
  }, 60_000);

  it('four concurrent writers (full indexer chain + daemon batch) lose no rows', async () => {
    // The original repro's worst case: index-guidance, index-tests,
    // index-patterns, and the daemon's memory_store burst can all hit the file
    // in the same window if the user invokes MCP tools while the chain is
    // mid-flight. Under sql.js this multiplied the clobber probability; under
    // WAL the indexers serialize via page locks and the daemon's transaction
    // exercises busy_timeout (#1099 path).
    const ROWS_PER_WRITER = 100;
    const writers: Array<{ role: string; shape: WriteShape }> = [
      { role: 'index-guidance', shape: 'autocommit' },
      { role: 'index-tests',    shape: 'autocommit' },
      { role: 'index-patterns', shape: 'autocommit' },
      { role: 'daemon',         shape: 'transaction' },
    ];
    const results = await Promise.all(
      writers.map((w) => spawnWriter(projectRoot, scriptDir, w.role, ROWS_PER_WRITER, w.shape)),
    );
    for (const r of results) {
      expect(r.written).toBe(ROWS_PER_WRITER);
    }

    const counts = await countRows(projectRoot);
    expect(counts.total).toBe(ROWS_PER_WRITER * writers.length);
    for (const w of writers) {
      expect(counts.perRole.get(w.role)).toBe(ROWS_PER_WRITER);
    }
  }, 90_000);

  it('journal_mode reports WAL — proves the page-level serialization mechanism is engaged', async () => {
    // If WAL ever silently regressed (e.g. journal_mode left at delete due to
    // a network-FS open), the row-count tests could still pass via OS-level
    // exclusive locking but degrade severely in real traffic.
    //
    // The PRAGMA value is stable across opens; the seed already wrote rows,
    // so no further activity is needed before reading it back.
    const db = await openBackend(projectRoot, { readOnly: true });
    try {
      const result = db.exec('PRAGMA journal_mode');
      expect(result[0]?.values?.[0]?.[0]).toBe('wal');
    } finally {
      db.close();
    }
  }, 10_000);
});
