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
  durationMs: number;
}

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
 * Inline script body is kept short — it's the minimum surface needed to
 * exercise openBackend + a prepared INSERT loop, matching how
 * bin/index-guidance.mjs, bin/index-tests.mjs, etc. write.
 */
function spawnWriter(
  projectRoot: string,
  scriptDir: string,
  role: string,
  rowCount: number,
): Promise<WriterResult> {
  const factoryUrl = 'file://' + FACTORY_PATH.replace(/\\/g, '/');
  const scriptPath = path.join(scriptDir, `writer-${role}.mjs`);
  // Single-quoted JSON literals inside the inline script keep injection-free.
  const script = `
    import { openBackend } from ${JSON.stringify(factoryUrl)};
    const projectRoot = ${JSON.stringify(projectRoot)};
    const role = ${JSON.stringify(role)};
    const rowCount = ${rowCount};
    const startedAt = Date.now();
    const db = await openBackend(projectRoot);
    try {
      const ins = db.prepare('INSERT INTO cross_writes (role, idx) VALUES (?, ?)');
      for (let i = 0; i < rowCount; i++) {
        ins.run([role, i]);
      }
      ins.free();
    } finally {
      db.close();
    }
    const durationMs = Date.now() - startedAt;
    process.stdout.write(JSON.stringify({ role, written: rowCount, durationMs }));
  `;
  fs.writeFileSync(scriptPath, script);

  return new Promise<WriterResult>((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
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

  it('two concurrent writers (indexer + daemon shape) lose no rows', async () => {
    const ROWS_PER_WRITER = 200;
    const [a, b] = await Promise.all([
      spawnWriter(projectRoot, scriptDir, 'indexer', ROWS_PER_WRITER),
      spawnWriter(projectRoot, scriptDir, 'daemon', ROWS_PER_WRITER),
    ]);

    expect(a.written).toBe(ROWS_PER_WRITER);
    expect(b.written).toBe(ROWS_PER_WRITER);

    const counts = await countRows(projectRoot);
    expect(counts.total).toBe(ROWS_PER_WRITER * 2);
    expect(counts.perRole.get('indexer')).toBe(ROWS_PER_WRITER);
    expect(counts.perRole.get('daemon')).toBe(ROWS_PER_WRITER);
  }, 60_000);

  it('four concurrent writers (overload — indexer chain steps + daemon) lose no rows', async () => {
    // The original repro's worst case: index-guidance, index-tests,
    // index-patterns, and the daemon's memory_store burst can all hit the file
    // in the same window if the user invokes MCP tools while the chain is
    // mid-flight. Under sql.js this multiplied the clobber probability; under
    // WAL all four serialize.
    const ROWS_PER_WRITER = 100;
    const roles = ['index-guidance', 'index-tests', 'index-patterns', 'daemon'];
    const results = await Promise.all(
      roles.map((r) => spawnWriter(projectRoot, scriptDir, r, ROWS_PER_WRITER)),
    );
    for (const r of results) {
      expect(r.written).toBe(ROWS_PER_WRITER);
    }

    const counts = await countRows(projectRoot);
    expect(counts.total).toBe(ROWS_PER_WRITER * roles.length);
    for (const role of roles) {
      expect(counts.perRole.get(role)).toBe(ROWS_PER_WRITER);
    }
  }, 90_000);

  it('journal_mode reports WAL — proves the page-level serialization mechanism is engaged', async () => {
    // If WAL ever silently regressed (e.g. journal_mode left at delete due to
    // a network-FS open), the two-writer test could still pass via OS-level
    // exclusive locking but degrade severely in real traffic.
    //
    // Reading PRAGMA journal_mode is the structural proof — and unlike the
    // -wal sidecar file (which may be checkpointed-and-removed after writers
    // close), the pragma value is stable as long as a handle is open.
    await spawnWriter(projectRoot, scriptDir, 'wal-probe', 5);
    const db = await openBackend(projectRoot, { readOnly: true });
    try {
      const result = db.exec('PRAGMA journal_mode');
      expect(result[0]?.values?.[0]?.[0]).toBe('wal');
    } finally {
      db.close();
    }
  }, 30_000);
});
