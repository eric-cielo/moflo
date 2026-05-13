/**
 * System verification for #1063 — daemon-RPC fallback path under concurrent
 * writes.
 *
 * Original repro (from the issue body):
 *   "Two concurrent CLI subprocesses do `flo memory store` against an
 *    installed moflo with the daemon up. Under CI fork contention or any
 *    environment with fastembed cold-load latency, at least one writer will
 *    see a transient daemon-rpc failure, fall through to bridge-direct, and
 *    the daemon's next persist clobbers it."
 *
 * Status post #1078 (sql.js → node:sqlite Phase 4 / PR #1096):
 *   The clobber mechanism is structurally gone. The bridge-direct write path
 *   no longer calls `db.export()` + `atomicWriteFileSync` — `persistBridgeDb`
 *   is a no-op under node:sqlite (commits land in WAL incrementally). Two
 *   concurrent writers (daemon-via-RPC + bridge-direct fallback) both engage
 *   SQLite's page-level lock manager + WAL; no whole-file flush can clobber
 *   a peer.
 *
 * This fixture is the verification AC the issue explicitly demanded — proof
 * by reproduction. Exercises the full `storeEntry` codepath end-to-end:
 *   1. Subprocess writers call shipped `dist/.../memory-initializer.js#storeEntry`
 *      (the code consumer projects load from `node_modules/moflo/`)
 *   2. MOFLO_DAEMON_PORT routes their `tryDaemonStore` through a fake daemon
 *   3. The fake induces RPC failures (5xx) to force fallback to bridge-direct,
 *      AND for the mixed-mode test, also persists rows via the same
 *      `openDaemonDatabase` factory the real daemon uses — modelling the
 *      contention shape of the original issue (daemon + bridge-direct both
 *      writing concurrently)
 *   4. After all subprocesses complete, assert row count in `memory_entries`
 *      equals the total number of `storeEntry` calls — zero loss
 *
 * Closes AC2 ("Cross-process write smoke fixture") on issue #1063 (#1103
 * explicitly carved this fixture out as separate from the per-shape
 * contract work). Companion to #1104 which tests the openBackend layer
 * under the same architecture.
 *
 * Cross-platform: spawns via `process.execPath`, paths via node:path,
 * cleanup tolerant of Windows WAL/shm release latency.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';

import { openDaemonDatabase } from '../../src/cli/memory/daemon-backend.js';
import { initializeMemoryDatabase } from '../../src/cli/memory/memory-initializer.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_INITIALIZER = path.join(
  REPO_ROOT,
  'dist',
  'src',
  'cli',
  'memory',
  'memory-initializer.js',
);

/** Counters the test inspects to confirm both code paths actually fired. */
interface FaultStats {
  storeOk: number;
  store5xx: number;
}

interface FakeDaemon {
  port: number;
  stats: FaultStats;
  stop(): Promise<void>;
}

type FaultMode =
  | 'always-fail'      // every /api/memory/store → 5xx (every caller falls back)
  | 'mixed-persist';   // alternating 200-with-persist vs 5xx — the actual #1063 contention shape

/**
 * In-test HTTP daemon that mimics the real moflo daemon's RPC surface enough
 * to exercise `storeEntry`'s fallback path. The fake holds a single long-
 * lived `openDaemonDatabase` handle for its lifetime — the same shape the
 * real daemon uses (single in-process writer, commits land in WAL
 * incrementally). Subprocess writers open their own short-lived handles via
 * `storeEntry`'s bridge-direct fallback. Concurrent writes from those two
 * shapes are the production contention the original issue worried about.
 */
async function startFakeDaemon(projectRoot: string, mode: FaultMode): Promise<FakeDaemon> {
  const stats: FaultStats = { storeOk: 0, store5xx: 0 };
  let requestIdx = 0;
  const dbPath = path.join(projectRoot, '.moflo', 'moflo.db');
  // Long-lived writer handle — models the daemon's actual persistence shape.
  // Closed in `stop()` after the HTTP server stops accepting requests.
  const db = openDaemonDatabase(dbPath);
  const insertStmt = db.prepare(
    `INSERT INTO memory_entries (
       id, key, namespace, content, type,
       embedding, embedding_dimensions, embedding_model,
       tags, metadata, created_at, updated_at, expires_at, status
     ) VALUES (?, ?, ?, ?, 'semantic', NULL, NULL, NULL, NULL, '{}', ?, ?, NULL, 'active')`,
  );

  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (chunk: Buffer) => { buf += chunk.toString('utf8'); });
    req.on('end', () => {
      const url = req.url ?? '';

      // Health probe — every `isDaemonAvailable()` call hits this first.
      if (url === '/api/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ running: true }));
        return;
      }

      if (req.method === 'POST' && url === '/api/memory/store') {
        const idx = requestIdx++;
        const shouldFail = mode === 'always-fail' || (mode === 'mixed-persist' && (idx % 2 === 0));
        if (shouldFail) {
          stats.store5xx++;
          // 5xx → daemon-write-client returns `routed: false` → caller falls
          // back to bridge-direct. This is the literal #1063 trigger.
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'simulated daemon-RPC fault (#1063 repro)' }));
          return;
        }
        // Daemon-success path: persist via `openDaemonDatabase` — the same
        // factory the real daemon uses. Models the production case where the
        // daemon is writing to `.moflo/moflo.db` at the same time bridge-
        // direct fallbacks are writing to it from CLI subprocesses.
        let payload: { namespace?: string; key?: string; value?: string } = {};
        try { payload = JSON.parse(buf); } catch { /* fall through to 400 */ }
        if (!payload.namespace || !payload.key || payload.value === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid payload' }));
          return;
        }
        const id = 'daemon_' + randomUUID();
        const now = Date.now();
        // Same column shape `storeEntry`'s direct path writes. For ephemeral
        // namespaces (`tasklist`) both paths set embedding_model = NULL, so
        // the rows are indistinguishable downstream.
        insertStmt.run([id, payload.key, payload.namespace, String(payload.value), now, now]);
        stats.storeOk++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, stored: true, id }));
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Fake daemon address unavailable');
  }

  return {
    port: addr.port,
    stats,
    async stop() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      insertStmt.free();
      db.close();
    },
  };
}

interface StoreResult {
  success: boolean;
  id: string;
  error?: string;
}

interface SpawnResult {
  writerId: string;
  storeResults: StoreResult[];
}

/**
 * Spawn one writer subprocess. The subprocess imports the SHIPPED dist
 * initializer (the code consumers load) and calls `storeEntry` `count` times
 * with unique keys. Routing config points at the fake daemon.
 */
function spawnStoreWriter(opts: {
  projectRoot: string;
  scriptDir: string;
  daemonPort: number;
  writerId: string;
  namespace: string;
  count: number;
}): Promise<SpawnResult> {
  const { projectRoot, scriptDir, daemonPort, writerId, namespace, count } = opts;
  const distUrl = 'file://' + DIST_INITIALIZER.replace(/\\/g, '/');
  const scriptPath = path.join(scriptDir, `writer-${writerId}.mjs`);
  const script = `
    const { storeEntry } = await import(${JSON.stringify(distUrl)});
    const writerId = ${JSON.stringify(writerId)};
    const namespace = ${JSON.stringify(namespace)};
    const count = ${count};
    const results = [];
    for (let i = 0; i < count; i++) {
      try {
        const r = await storeEntry({
          key: writerId + '_' + i,
          value: 'val_' + writerId + '_' + i,
          namespace,
        });
        results.push({ success: r.success, id: r.id, error: r.error });
      } catch (err) {
        results.push({ success: false, id: '', error: String(err && err.stack || err) });
      }
    }
    process.stdout.write(JSON.stringify({ writerId, storeResults: results }));
  `;
  fs.writeFileSync(scriptPath, script);

  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [scriptPath], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: {
        ...process.env,
        MOFLO_DAEMON_PORT: String(daemonPort),
        // Pin the unified project-root resolver to the temp DB (#1057).
        CLAUDE_PROJECT_DIR: projectRoot,
        // Defensive — the parent process may carry stale daemon env vars
        // from other tests.
        MOFLO_IS_DAEMON: '',
        MOFLO_DISABLE_DAEMON_ROUTING: '',
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
        reject(new Error(`writer ${writerId} exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`writer ${writerId} produced unparsable stdout: ${stdout} (${String(err)})`));
      }
    });
  });
}

function countRows(projectRoot: string, namespace: string): number {
  const dbPath = path.join(projectRoot, '.moflo', 'moflo.db');
  const db = openDaemonDatabase(dbPath);
  try {
    const stmt = db.prepare(
      `SELECT COUNT(*) AS n FROM memory_entries WHERE namespace = ? AND status = 'active'`,
    );
    try {
      stmt.bind([namespace]);
      if (stmt.step()) {
        const row = stmt.getAsObject() as { n: number };
        return Number(row.n ?? 0);
      }
      return 0;
    } finally {
      stmt.free();
    }
  } finally {
    db.close();
  }
}

function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `moflo-1063-${prefix}-`));
}

function cleanupRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* best-effort — Windows can hold a brief WAL/shm sidecar lock */
  }
}

describe('System verification — daemon-RPC fallback under concurrency (#1063)', () => {
  beforeAll(() => {
    if (!fs.existsSync(DIST_INITIALIZER)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[daemon-fallback-cross-process-1063] skipping suite — ${DIST_INITIALIZER} not found. Run: npm run build`,
      );
    }
  });

  let projectRoot: string;
  let scriptDir: string;
  let daemon: FakeDaemon | null = null;

  beforeEach(async () => {
    if (!fs.existsSync(DIST_INITIALIZER)) return;
    projectRoot = makeTempRoot('proj');
    scriptDir = makeTempRoot('scripts');
    fs.mkdirSync(path.join(projectRoot, '.moflo'), { recursive: true });
    // Seed the V3 schema before any writer runs. Mirrors production: the
    // bridge runs migrations pre-boot (#1057); writers find the schema in
    // place when they open. `migrate: false` skips legacy-DB scanning since
    // we built the temp root from scratch.
    const init = await initializeMemoryDatabase({
      dbPath: path.join(projectRoot, '.moflo', 'moflo.db'),
      force: true,
      verbose: false,
      migrate: false,
    });
    expect(init.success).toBe(true);
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = null;
    }
    if (projectRoot) cleanupRoot(projectRoot);
    if (scriptDir) cleanupRoot(scriptDir);
  });

  it('every daemon-RPC store fails 5xx → all writers fall through to bridge-direct → zero loss', async () => {
    if (!fs.existsSync(DIST_INITIALIZER)) {
      // eslint-disable-next-line no-console
      console.warn('  → skipped (no dist build)');
      return;
    }
    daemon = await startFakeDaemon(projectRoot, 'always-fail');
    // `tasklist` is in EPHEMERAL_NAMESPACES — skips embedding generation,
    // which keeps the test fast AND mirrors the high-frequency write pattern
    // (Flo Runs dashboard rows) that historically tripped this race.
    const ns = 'tasklist';
    const COUNT = 25;
    const WRITERS = 2;

    const results = await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        spawnStoreWriter({
          projectRoot,
          scriptDir,
          daemonPort: daemon!.port,
          writerId: `w${i}`,
          namespace: ns,
          count: COUNT,
        }),
      ),
    );

    // Every storeEntry call must have succeeded — fallback to bridge-direct
    // delivered durability even though the daemon RPC failed.
    for (const r of results) {
      expect(r.storeResults).toHaveLength(COUNT);
      for (const sr of r.storeResults) {
        expect(sr.success).toBe(true);
        expect(typeof sr.id).toBe('string');
        expect(sr.id.length).toBeGreaterThan(0);
      }
    }

    // Every request hit the 5xx branch — none persisted via the daemon, all
    // via the bridge-direct fallback path.
    expect(daemon.stats.storeOk).toBe(0);
    expect(daemon.stats.store5xx).toBe(WRITERS * COUNT);

    // The win condition. Total rows in the DB equals total storeEntry calls —
    // zero loss across N concurrent bridge-direct writers.
    expect(countRows(projectRoot, ns)).toBe(WRITERS * COUNT);
  }, 60_000);

  it('mixed daemon success + 5xx with concurrent persists — both paths converge, zero loss', async () => {
    if (!fs.existsSync(DIST_INITIALIZER)) {
      // eslint-disable-next-line no-console
      console.warn('  → skipped (no dist build)');
      return;
    }
    // The literal #1063 scenario: the daemon is up and writing to .moflo/moflo.db,
    // some RPC calls fail (forcing the caller to fall back to bridge-direct),
    // and BOTH write paths must end up durable. Under sql.js this lost rows
    // (whole-file flush from either side clobbered the peer); under WAL the
    // page-level lock manager arbitrates.
    daemon = await startFakeDaemon(projectRoot, 'mixed-persist');
    const ns = 'tasklist';
    const COUNT = 25;
    const WRITERS = 2;

    const results = await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        spawnStoreWriter({
          projectRoot,
          scriptDir,
          daemonPort: daemon!.port,
          writerId: `m${i}`,
          namespace: ns,
          count: COUNT,
        }),
      ),
    );

    for (const r of results) {
      expect(r.storeResults).toHaveLength(COUNT);
      for (const sr of r.storeResults) {
        expect(sr.success).toBe(true);
      }
    }

    // Both code paths fired — exercises the actual contention the issue
    // describes, not just the all-fallback or all-succeed degenerate cases.
    expect(daemon.stats.storeOk).toBeGreaterThan(0);
    expect(daemon.stats.store5xx).toBeGreaterThan(0);
    expect(daemon.stats.storeOk + daemon.stats.store5xx).toBe(WRITERS * COUNT);

    // The daemon-via-RPC writes plus the bridge-direct fallback writes both
    // landed in `memory_entries`. Total equals every storeEntry call ever
    // made — zero loss across the mixed write paths.
    expect(countRows(projectRoot, ns)).toBe(WRITERS * COUNT);
  }, 60_000);

  it('journal_mode reports WAL — the page-level mechanism that makes the above safe is engaged', async () => {
    if (!fs.existsSync(DIST_INITIALIZER)) {
      // eslint-disable-next-line no-console
      console.warn('  → skipped (no dist build)');
      return;
    }
    // The architectural fix for #1063 is node:sqlite + WAL. If WAL silently
    // regressed (e.g. a future engine swap, or a path that bypasses
    // openDaemonDatabase), the row-count tests above could still pass via
    // OS-level exclusive locking but the system would degrade severely under
    // real traffic. This guard surfaces that regression early.
    const dbPath = path.join(projectRoot, '.moflo', 'moflo.db');
    const db = openDaemonDatabase(dbPath);
    try {
      const result = db.exec('PRAGMA journal_mode');
      expect(result[0]?.values?.[0]?.[0]).toBe('wal');
    } finally {
      db.close();
    }
  }, 10_000);
});
