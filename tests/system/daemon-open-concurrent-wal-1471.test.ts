/**
 * System E2E: concurrent first-open of a fresh database (#1471).
 *
 * The failure was cross-process and only ever showed up under real contention:
 * `openDaemonDatabase` sets `PRAGMA busy_timeout` before `PRAGMA journal_mode
 * = WAL` precisely so concurrent openers survive the EXCLUSIVE lock the
 * conversion takes — but SQLite does not invoke the busy handler for a
 * journal-mode change, so the budget never applied to the one statement it was
 * put there for. Every opener but the winner threw `SQLITE_BUSY` and died.
 *
 * That is the ordinary consumer configuration, not a test contrivance: the
 * daemon, the MCP server and a foreground `flo` command routinely open the
 * same `.moflo/moflo.db` at session start, and on a fresh install that open is
 * the conversion. It surfaced as `tests/system/hnsw-sidecar-concurrent-writers
 * -1388.test.ts` failing ~2 runs in 10.
 *
 * In-process coverage of the retry itself (backoff, budget, error shape, both
 * twins) lives in `src/cli/__tests__/memory/wal-retry-1471.test.ts`. This suite
 * covers the half only real subprocesses can prove — that N processes racing
 * the same fresh file all come out with a usable WAL handle.
 *
 * Cross-platform: spawns via `process.execPath`, paths via node:path, temp
 * roots under `os.tmpdir()`, cleanup tolerant of Windows handle-release
 * latency. The barrier below is a wall-clock rendezvous rather than a signal
 * so it behaves the same on Windows, which has no POSIX signals.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_BACKEND = path.join(REPO_ROOT, 'dist', 'src', 'cli', 'memory', 'daemon-backend.js');
const BIN_BACKEND = path.join(REPO_ROOT, 'bin', 'lib', 'get-backend.mjs');

/** Enough openers that the conversion race is hit reliably, few enough to stay quick. */
const OPENERS = 6;
/** Head start for spawn + module load, so every child reaches the open together. */
const BARRIER_LEAD_MS = 700;

function moduleUrl(filePath: string): string {
  return 'file://' + filePath.replace(/\\/g, '/');
}

interface OpenResult {
  role: string;
  journalMode: string;
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

describe('concurrent first-open converts to WAL without SQLITE_BUSY (#1471)', () => {
  let tmp: string;
  let scriptDir: string;
  let dbPath: string;
  let distMissing = false;

  beforeAll(() => {
    // A source-only checkout has no dist. Skip loudly rather than fail with an
    // unresolvable-import error that reads like a real defect.
    distMissing = !fs.existsSync(DIST_BACKEND);
    if (distMissing) {
      console.warn(
        `[daemon-open-concurrent-wal] skipping suite — ${DIST_BACKEND} not found. Run: npm run build`,
      );
    }
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-1471-sys-'));
    fs.mkdirSync(path.join(tmp, '.moflo'));
    scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-1471-scripts-'));
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

  /**
   * Both factories are hand-maintained twins of the same open sequence, and
   * both ship: the TS one to the daemon and MCP server, the .mjs one to every
   * `bin/*` entry point. A consumer's session start runs them against the same
   * file at the same moment, so both must survive the race.
   */
  function openerSource(role: string, startAt: number, importSpec: string, open: string): string {
    return `
      import { ${open.split('(')[0]} } from ${JSON.stringify(importSpec)};
      // Wall-clock rendezvous: spawn order and module-load time vary by
      // hundreds of ms, which is enough for the openers to miss each other
      // entirely and let the pre-fix code pass by accident.
      const startAt = ${startAt};
      while (Date.now() < startAt) { /* spin — sub-ms precision, no timer skew */ }
      const db = await ${open};
      let journalMode = '';
      try {
        // The sql.js-shaped \`exec\` both wrappers expose — their Statement
        // shim is stateful (step/getAsObject), so there is no \`.get()\`.
        const rows = db.exec('PRAGMA journal_mode');
        journalMode = String(rows?.[0]?.values?.[0]?.[0] ?? '').toLowerCase();
      } finally {
        db.close();
      }
      console.log(JSON.stringify({ role: ${JSON.stringify(role)}, journalMode }));
    `;
  }

  it('lets every one of N processes open the same fresh database', async () => {
    if (distMissing) return;

    const startAt = Date.now() + BARRIER_LEAD_MS;
    const results = await Promise.all(
      Array.from({ length: OPENERS }, (_, i) =>
        runScript<OpenResult>(
          path.join(scriptDir, `opener-${i}.mjs`),
          openerSource(
            `opener-${i}`,
            startAt,
            moduleUrl(DIST_BACKEND),
            `openDaemonDatabase(${JSON.stringify(dbPath)})`,
          ),
        ),
      ),
    );

    // Pre-fix, the losers exited non-zero and `runScript` rejected above with
    // "database is locked" — so reaching here at all is most of the assertion.
    expect(results).toHaveLength(OPENERS);
    for (const result of results) {
      expect(result.journalMode, `${result.role} did not end up in WAL`).toBe('wal');
    }
  }, 120_000);

  it('lets the bin/* factory twin survive the same race', async () => {
    // `openBackend(projectRoot)` — the .mjs twin. Guards against the fix landing in
    // one factory and not the other, which would leave every hook and indexer
    // subprocess still dying on a fresh consumer install.
    const startAt = Date.now() + BARRIER_LEAD_MS;
    const results = await Promise.all(
      Array.from({ length: OPENERS }, (_, i) =>
        runScript<OpenResult>(
          path.join(scriptDir, `bin-opener-${i}.mjs`),
          openerSource(
            `bin-opener-${i}`,
            startAt,
            moduleUrl(BIN_BACKEND),
            `openBackend(${JSON.stringify(tmp)})`,
          ),
        ),
      ),
    );

    expect(results).toHaveLength(OPENERS);
    for (const result of results) {
      expect(result.journalMode, `${result.role} did not end up in WAL`).toBe('wal');
    }
  }, 120_000);
});
