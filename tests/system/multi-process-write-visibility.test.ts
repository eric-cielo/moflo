/**
 * System E2E: cross-process write visibility (#981 / #987).
 *
 * Proves the single-writer-architecture fix end-to-end. Spawns two real Node
 * subprocesses, each importing the SHIPPED `dist/src/cli/memory/memory-
 * initializer.js` (what consumer projects load from `node_modules/moflo/`)
 * and calling `storeEntry`. Both subprocesses route their writes through
 * an in-test-process HTTP daemon that captures every store + delete.
 *
 * Reproduces the structural shape of #981's failure:
 *   - Multiple long-lived processes both writing to memory in parallel
 *   - Pre-fix: each process holds its own sql.js snapshot; whichever
 *     flushes last wins, the other's write is silently lost
 *   - Post-fix: every process routes through the daemon's HTTP RPC; the
 *     daemon's single sql.js writer sees both writes
 *
 * The "fix is in" check is: both writes survive when the daemon is up,
 * regardless of subprocess interleaving.
 *
 * Cross-platform: uses `process.execPath` for the node binary, `spawn` with
 * `shell: false`, and the dist build that ships to consumers (so this test
 * exercises the actual code consumers load — not the in-repo TS).
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_INITIALIZER = path.join(
  REPO_ROOT,
  'dist',
  'src',
  'cli',
  'memory',
  'memory-initializer.js',
);

interface ReceivedWrite {
  url: string;
  body: Record<string, unknown>;
}

interface FakeDaemon {
  port: number;
  received: ReceivedWrite[];
  stop(): Promise<void>;
}

async function startFakeDaemon(): Promise<FakeDaemon> {
  const received: ReceivedWrite[] = [];

  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (chunk: Buffer) => { buf += chunk.toString('utf8'); });
    req.on('end', () => {
      const url = req.url ?? '';

      // Health probe — daemon-write-client.isDaemonAvailable() hits this first.
      if (url === '/api/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ running: true }));
        return;
      }

      if (req.method === 'POST' && (url === '/api/memory/store' || url === '/api/memory/delete')) {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(buf); } catch { /* non-JSON body */ }
        received.push({ url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          stored: url === '/api/memory/store',
          deleted: url === '/api/memory/delete',
          id: 'rpc_' + randomUUID(),
        }));
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
    received,
    async stop() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Spawn a real Node subprocess that imports the shipped dist initializer
 * and calls `storeEntry` once. The subprocess inherits MOFLO_DAEMON_PORT
 * pointing at our fake daemon, so its routing preamble forwards the write.
 *
 * Returns the parsed JSON the subprocess writes to stdout, or rejects on
 * non-zero exit.
 */
function spawnWriter(
  port: number,
  payload: { key: string; value: string; namespace: string },
  scriptDir: string,
): Promise<{ success: boolean; id: string }> {
  return new Promise((resolve, reject) => {
    // Inline ESM script — uses dynamic import of the dist initializer.
    // Forward-slashed path is tolerated by `import()` on every platform.
    const scriptPath = path.join(scriptDir, `writer-${randomUUID()}.mjs`);
    const distUrl = 'file://' + DIST_INITIALIZER.replace(/\\/g, '/');
    const script = `
      const { storeEntry } = await import(${JSON.stringify(distUrl)});
      try {
        const result = await storeEntry({
          key: ${JSON.stringify(payload.key)},
          value: ${JSON.stringify(payload.value)},
          namespace: ${JSON.stringify(payload.namespace)},
        });
        process.stdout.write(JSON.stringify(result));
        process.exit(0);
      } catch (err) {
        process.stderr.write(String(err && err.stack || err));
        process.exit(2);
      }
    `;
    fs.writeFileSync(scriptPath, script);

    const child: ChildProcess = spawn(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: {
        ...process.env,
        MOFLO_DAEMON_PORT: String(port),
        // Belt-and-braces: the parent process may be marked as the daemon
        // when running other tests; we want THIS subprocess to route.
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
        reject(new Error(`writer subprocess exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`writer subprocess produced unparsable stdout: ${stdout} (err: ${String(err)})`));
      }
    });
  });
}

describe('System E2E — multi-process write visibility (#981 / #987)', () => {
  // Subprocesses load dist/. If the build is missing (fresh clone, post-clean
  // state) skip the suite with a clear message rather than failing with an
  // unhelpful import error.
  beforeAll(() => {
    if (!fs.existsSync(DIST_INITIALIZER)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[multi-process-write-visibility] skipping suite — ${DIST_INITIALIZER} not found. Run: npm run build`,
      );
    }
  });

  let daemon: FakeDaemon | null = null;
  let scriptDir: string | null = null;

  beforeEach(async () => {
    if (!fs.existsSync(DIST_INITIALIZER)) return;
    daemon = await startFakeDaemon();
    scriptDir = fs.mkdtempSync(path.join(tmpdir(), 'multi-proc-writers-'));
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = null;
    }
    if (scriptDir) {
      try { fs.rmSync(scriptDir, { recursive: true, force: true }); } catch { /* ok */ }
      scriptDir = null;
    }
  });

  it('two parallel subprocess writes both reach the daemon (the #981 reproduction)', async () => {
    if (!fs.existsSync(DIST_INITIALIZER)) {
      // eslint-disable-next-line no-console
      console.warn('  → skipped (no dist build)');
      return;
    }
    if (!daemon || !scriptDir) throw new Error('daemon/scriptDir missing — beforeEach did not run');

    const ns = `e2e-${randomUUID()}`;
    const [r1, r2] = await Promise.all([
      spawnWriter(daemon.port, { key: 'k1', value: 'v1', namespace: ns }, scriptDir),
      spawnWriter(daemon.port, { key: 'k2', value: 'v2', namespace: ns }, scriptDir),
    ]);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);

    const stores = daemon.received.filter(r => r.url === '/api/memory/store');
    expect(stores).toHaveLength(2);

    const keys = stores.map(r => r.body.key as string).sort();
    expect(keys).toEqual(['k1', 'k2']);

    // Both writes carried the test namespace — proves no caller is silently
    // dropped or merged.
    for (const s of stores) {
      expect(s.body.namespace).toBe(ns);
    }
  }, 30_000);

  it('serial subprocess writes are both visible — the daemon does not lose history between requests', async () => {
    if (!fs.existsSync(DIST_INITIALIZER)) {
      // eslint-disable-next-line no-console
      console.warn('  → skipped (no dist build)');
      return;
    }
    if (!daemon || !scriptDir) throw new Error('daemon/scriptDir missing — beforeEach did not run');

    const ns = `e2e-serial-${randomUUID()}`;
    await spawnWriter(daemon.port, { key: 'first', value: '1', namespace: ns }, scriptDir);
    await spawnWriter(daemon.port, { key: 'second', value: '2', namespace: ns }, scriptDir);

    const stores = daemon.received.filter(r => r.url === '/api/memory/store');
    expect(stores).toHaveLength(2);
    expect(stores.map(r => r.body.key).sort()).toEqual(['first', 'second']);
  }, 30_000);
});
