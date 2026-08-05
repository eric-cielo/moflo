/**
 * System E2E: concurrent HNSW sidecar writers (#1388).
 *
 * The bug in the wild was cross-process, not cross-async: `index-patterns`,
 * `index-reference` and `index-guidance` each fire-and-forget their own
 * namespace-scoped `build-embeddings`, `pm.spawn` dedups on exact label
 * equality so those four labels never match, and each spawned process ends by
 * writing `.moflo/hnsw.index`. On 4.12.4-rc.6 two of them interleaved and the
 * sidecar was left holding 5199 vectors while the DB had 5219 — the older
 * writer's graph overwrote the newer one's.
 *
 * In-process tests (`src/cli/__tests__/memory/hnsw-sidecar-lock.test.ts`)
 * cover the promise-chain half. This suite covers the half that only real
 * subprocesses can prove: that the `O_CREAT | O_EXCL` lock file actually
 * excludes across process boundaries, on all three platforms we ship to.
 * Rule #1 lives or dies here — there is no `flock`, so if the primitive
 * behaved differently on Windows this is where it would surface.
 *
 * Cross-platform: spawns via `process.execPath`, paths via node:path, temp
 * roots under `os.tmpdir()`, cleanup tolerant of Windows handle-release
 * latency.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_LOCK = path.join(REPO_ROOT, 'dist', 'src', 'cli', 'memory', 'hnsw-sidecar-lock.js');
const DIST_PERSISTENCE = path.join(REPO_ROOT, 'dist', 'src', 'cli', 'memory', 'hnsw-persistence.js');
const DIST_BACKEND = path.join(REPO_ROOT, 'dist', 'src', 'cli', 'memory', 'daemon-backend.js');

const DIM = 8;
/** Long enough that overlapping holds are unmistakable, short enough to stay quick. */
const HOLD_MS = 300;

function moduleUrl(filePath: string): string {
  return 'file://' + filePath.replace(/\\/g, '/');
}

interface HoldWindow {
  role: string;
  enteredAt: number;
  exitedAt: number;
}

/** Run one subprocess and parse the single JSON line it prints. */
function runScript<T>(scriptPath: string, source: string): Promise<T> {
  fs.writeFileSync(scriptPath, source, 'utf-8');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${path.basename(scriptPath)} exited ${code}: ${stderr || stdout}`));
        return;
      }
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      if (!line) {
        reject(new Error(`${path.basename(scriptPath)} printed nothing. stderr: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(line) as T);
      } catch (err) {
        reject(new Error(`${path.basename(scriptPath)} printed non-JSON: ${line} (${err})`));
      }
    });
  });
}

describe('HNSW sidecar concurrent writers (#1388)', () => {
  let tmp: string;
  let scriptDir: string;
  let dbPath: string;
  let distMissing = false;

  beforeAll(() => {
    // A source-only checkout has no dist. Skip loudly rather than fail with an
    // unresolvable-import error that reads like a real defect.
    distMissing = !fs.existsSync(DIST_LOCK) || !fs.existsSync(DIST_PERSISTENCE);
    if (distMissing) {
      console.warn(
        `[hnsw-sidecar-concurrent-writers] skipping suite — ${DIST_LOCK} not found. Run: npm run build`,
      );
    }
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-1388-sys-'));
    fs.mkdirSync(path.join(tmp, '.moflo'));
    scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-1388-scripts-'));
    dbPath = path.join(tmp, '.moflo', 'moflo.db');
  });

  afterEach(() => {
    for (const dir of [tmp, scriptDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* best-effort — Windows can hold a brief handle */
      }
    }
  });

  it('never lets two processes hold the sidecar lock at once', async () => {
    if (distMissing) return;

    const roles = ['patterns', 'reference', 'guidance', 'rebuild-index'];
    const windows = await Promise.all(
      roles.map((role) =>
        runScript<HoldWindow>(
          path.join(scriptDir, `holder-${role}.mjs`),
          `
          import { withHnswSidecarLock } from ${JSON.stringify(moduleUrl(DIST_LOCK))};
          const root = ${JSON.stringify(tmp)};
          let enteredAt = 0;
          await withHnswSidecarLock(root, async () => {
            enteredAt = Date.now();
            await new Promise(r => setTimeout(r, ${HOLD_MS}));
          });
          console.log(JSON.stringify({ role: ${JSON.stringify(role)}, enteredAt, exitedAt: Date.now() }));
          `,
        ),
      ),
    );

    expect(windows).toHaveLength(roles.length);

    // Sort by entry and require each hold to end before the next begins. With
    // no lock every process enters immediately and these intervals all overlap.
    const ordered = [...windows].sort((a, b) => a.enteredAt - b.enteredAt);
    for (let i = 1; i < ordered.length; i++) {
      const previous = ordered[i - 1];
      const current = ordered[i];
      expect(
        previous.exitedAt,
        `${previous.role} was still holding the lock when ${current.role} entered`,
      ).toBeLessThanOrEqual(current.enteredAt);
    }

    // Serialised holds cannot finish faster than their sum.
    const span = Math.max(...windows.map((w) => w.exitedAt)) -
      Math.min(...windows.map((w) => w.enteredAt));
    expect(span).toBeGreaterThanOrEqual(HOLD_MS * (roles.length - 1));
  }, 60_000);

  it('releases the lock file when every writer has finished', async () => {
    if (distMissing) return;

    await Promise.all(
      ['a', 'b'].map((role) =>
        runScript<HoldWindow>(
          path.join(scriptDir, `release-${role}.mjs`),
          `
          import { withHnswSidecarLock } from ${JSON.stringify(moduleUrl(DIST_LOCK))};
          let enteredAt = 0;
          await withHnswSidecarLock(${JSON.stringify(tmp)}, async () => {
            enteredAt = Date.now();
            await new Promise(r => setTimeout(r, 20));
          });
          console.log(JSON.stringify({ role: ${JSON.stringify(role)}, enteredAt, exitedAt: Date.now() }));
          `,
        ),
      ),
    );

    expect(fs.existsSync(path.join(tmp, '.moflo', 'hnsw.lock'))).toBe(false);
  }, 60_000);

  it('keeps every namespace\'s rows when three writers embed and sync at once', async () => {
    if (distMissing) return;

    // The shape from the wild: each process writes its own namespace's rows and
    // then reconciles the shared sidecar. Pre-#1388 the last writer to finish
    // decided the contents and the others' vectors were dropped.
    const namespaces = ['patterns', 'reference', 'guidance'];
    const rowsPerNamespace = 6;

    const results = await Promise.all(
      namespaces.map((namespace, index) =>
        runScript<{ namespace: string; vectorCount: number; mode: string; reason?: string }>(
          path.join(scriptDir, `writer-${namespace}.mjs`),
          `
          import { openDaemonDatabase } from ${JSON.stringify(moduleUrl(DIST_BACKEND))};
          import { syncHnswSidecar } from ${JSON.stringify(moduleUrl(DIST_PERSISTENCE))};

          const dbPath = ${JSON.stringify(dbPath)};
          const root = ${JSON.stringify(tmp)};
          const namespace = ${JSON.stringify(namespace)};
          const seedBase = ${index * 100};
          const vectorFor = (seed) =>
            Array.from({ length: ${DIM} }, (_, j) => Number(Math.sin(seed * 0.7 + j * 0.3).toFixed(6)));

          const db = openDaemonDatabase(dbPath);
          try {
            db.run(\`CREATE TABLE IF NOT EXISTS memory_entries (
              id TEXT PRIMARY KEY, key TEXT, namespace TEXT, content TEXT,
              embedding TEXT, updated_at INTEGER, status TEXT
            )\`);
            for (let i = 0; i < ${rowsPerNamespace}; i++) {
              db.run(
                \`INSERT OR REPLACE INTO memory_entries
                   (id, key, namespace, content, embedding, updated_at, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'active')\`,
                [namespace + '-' + i, 'key-' + (seedBase + i), namespace,
                 'content ' + (seedBase + i), JSON.stringify(vectorFor(seedBase + i)),
                 1700000000000],
              );
            }
          } finally {
            db.close();
          }

          const result = await syncHnswSidecar(dbPath, root, { dimensions: ${DIM} });
          console.log(JSON.stringify({
            namespace, vectorCount: result.vectorCount, mode: result.mode, reason: result.reason,
          }));
          `,
        ),
      ),
    );

    expect(results).toHaveLength(namespaces.length);

    // At most one full rebuild across the whole pass. The first writer finds no
    // sidecar and legitimately builds one; every writer after it inherits a
    // valid index+manifest pair and reconciles incrementally. Unserialised,
    // each writer found the same absent-or-mismatched pair and rebuilt from
    // scratch — the quadratic work #1384 exists to avoid, paid N times over.
    const fullRebuilds = results.filter((r) => r.mode === 'full');
    expect(
      fullRebuilds.length,
      `expected at most one full rebuild, got ${fullRebuilds.map((r) => r.reason).join(', ')}`,
    ).toBeLessThanOrEqual(1);

    // Read the final sidecar the way a cold-start consumer would.
    const { tryLoadHnswSidecar } = await import(moduleUrl(DIST_PERSISTENCE)) as {
      tryLoadHnswSidecar: (root: string) => { size: number } | null;
    };
    const loaded = tryLoadHnswSidecar(tmp);

    expect(loaded).not.toBeNull();
    expect(loaded!.size).toBe(namespaces.length * rowsPerNamespace);
    expect(fs.existsSync(path.join(tmp, '.moflo', 'hnsw.lock'))).toBe(false);
  }, 120_000);
});
