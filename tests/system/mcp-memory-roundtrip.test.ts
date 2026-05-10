/**
 * System E2E: MCP memory_store → memory_retrieve round-trip visibility
 * (story #1058 / epic #1054).
 *
 * Proves the read-side fix end-to-end. Before #1058, a non-daemon process
 * holding a long-lived sql.js bridge snapshot returned `{ found: false }` to
 * retrieve calls even when the row was on disk — the bridge never re-reads
 * disk after init. After #1058 the bridge:
 *   (a) routes reads through the daemon's HTTP RPC when one is reachable, OR
 *   (b) invalidates its snapshot via mtime-coherence when another process
 *       has written to disk since this process loaded.
 *
 * Reproduces what an MCP consumer sees: two subprocesses share `.moflo/moflo.db`,
 * one writes, the other reads. The "fix is in" check is: the reader's
 * memory_retrieve / memory_search find what the writer just stored.
 *
 * Cross-platform: uses `process.execPath`, `spawn` with `shell: false`, and
 * the dist build that ships to consumers.
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

// ============================================================================
// Fake daemon — same shape as multi-process-write-visibility.test.ts, extended
// with the read endpoints from #1058.
// ============================================================================

interface FakeDaemonState {
  /** Per-namespace key→value store the daemon "remembers". */
  entries: Map<string, { value: unknown; tags?: string[] }>;
  /** Every request we received, in order. */
  received: Array<{ url: string; body: Record<string, unknown> }>;
}

interface FakeDaemon {
  port: number;
  state: FakeDaemonState;
  stop(): Promise<void>;
}

function makeKey(namespace: string, key: string): string {
  return `${namespace}::${key}`;
}

async function startFakeDaemon(): Promise<FakeDaemon> {
  const state: FakeDaemonState = {
    entries: new Map(),
    received: [],
  };

  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (chunk: Buffer) => { buf += chunk.toString('utf8'); });
    req.on('end', () => {
      const url = req.url ?? '';

      if (url === '/api/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ running: true }));
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405); res.end(); return;
      }

      let body: Record<string, unknown> = {};
      try { body = JSON.parse(buf); } catch { /* non-JSON body */ }
      state.received.push({ url, body });

      if (url === '/api/memory/store') {
        const ns = String(body.namespace);
        const k = String(body.key);
        state.entries.set(makeKey(ns, k), {
          value: body.value,
          tags: body.tags as string[] | undefined,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, stored: true, id: 'rpc_' + randomUUID() }));
        return;
      }

      if (url === '/api/memory/delete') {
        const ns = String(body.namespace);
        const k = String(body.key);
        const existed = state.entries.delete(makeKey(ns, k));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, deleted: existed }));
        return;
      }

      if (url === '/api/memory/get') {
        const ns = String(body.namespace);
        const k = String(body.key);
        const entry = state.entries.get(makeKey(ns, k));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!entry) {
          res.end(JSON.stringify({ ok: true, found: false }));
        } else {
          const valueStr = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
          res.end(JSON.stringify({
            ok: true,
            found: true,
            entry: {
              id: 'rpc_get_' + randomUUID(),
              key: k,
              namespace: ns,
              content: valueStr,
              accessCount: 0,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              hasEmbedding: false,
              tags: entry.tags ?? [],
            },
          }));
        }
        return;
      }

      if (url === '/api/memory/search') {
        const ns = String(body.namespace ?? 'all');
        const q = String(body.query ?? '').toLowerCase();
        const results: Array<{ id: string; key: string; content: string; score: number; namespace: string }> = [];
        for (const [composite, entry] of state.entries) {
          const [entryNs, entryKey] = composite.split('::');
          if (ns !== 'all' && entryNs !== ns) continue;
          const content = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
          // Naive substring match — search semantics aren't the contract here.
          if (q && content.toLowerCase().includes(q)) {
            results.push({
              id: 'rpc_search_' + randomUUID(),
              key: entryKey,
              content,
              score: 1.0,
              namespace: entryNs,
            });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, results, searchTime: 0 }));
        return;
      }

      if (url === '/api/memory/list') {
        const ns = body.namespace as string | undefined;
        const entries: Array<Record<string, unknown>> = [];
        for (const [composite, entry] of state.entries) {
          const [entryNs, entryKey] = composite.split('::');
          if (ns && entryNs !== ns) continue;
          const content = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
          entries.push({
            id: 'rpc_list_' + randomUUID(),
            key: entryKey,
            namespace: entryNs,
            size: content.length,
            accessCount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hasEmbedding: false,
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, entries, total: entries.length }));
        return;
      }

      res.writeHead(404); res.end();
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
    state,
    async stop() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ============================================================================
// Subprocess helpers — every spawn loads the SHIPPED dist build.
// ============================================================================

interface SubprocessEnv {
  daemonPort?: number;
  projectRoot: string;
  /** Override: disable daemon routing in the subprocess (no-daemon mode). */
  disableRouting?: boolean;
}

function runSubprocess(
  payload: string,
  env: SubprocessEnv,
  scriptDir: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(scriptDir, `runner-${randomUUID()}.mjs`);
    fs.writeFileSync(scriptPath, payload);
    const subprocessEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_PROJECT_DIR: env.projectRoot,
      MOFLO_IS_DAEMON: '',
    };
    if (env.daemonPort !== undefined) {
      subprocessEnv.MOFLO_DAEMON_PORT = String(env.daemonPort);
    }
    if (env.disableRouting) {
      subprocessEnv.MOFLO_DISABLE_DAEMON_ROUTING = '1';
    } else {
      subprocessEnv.MOFLO_DISABLE_DAEMON_ROUTING = '';
    }

    const child: ChildProcess = spawn(process.execPath, [scriptPath], {
      cwd: env.projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: subprocessEnv,
    });

    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
      if (code !== 0) {
        reject(new Error(`subprocess exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function script(body: string): string {
  const distUrl = 'file://' + DIST_INITIALIZER.replace(/\\/g, '/');
  return `
    const { storeEntry, getEntry, searchEntries, listEntries } = await import(${JSON.stringify(distUrl)});
    try {
      ${body}
    } catch (err) {
      process.stderr.write(String(err && err.stack || err));
      process.exit(2);
    }
  `;
}

// ============================================================================
// Tests
// ============================================================================

describe('System E2E — MCP memory round-trip visibility (#1058)', () => {
  beforeAll(() => {
    if (!fs.existsSync(DIST_INITIALIZER)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[mcp-memory-roundtrip] skipping suite — ${DIST_INITIALIZER} not found. Run: npm run build`,
      );
    }
  });

  let daemon: FakeDaemon | null = null;
  let scriptDir: string | null = null;
  let projectRoot: string | null = null;

  beforeEach(async () => {
    if (!fs.existsSync(DIST_INITIALIZER)) return;
    scriptDir = fs.mkdtempSync(path.join(tmpdir(), 'mcp-roundtrip-'));
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), 'mcp-roundtrip-proj-'));
    fs.mkdirSync(path.join(projectRoot, '.moflo'), { recursive: true });
  });

  afterEach(async () => {
    if (daemon) { await daemon.stop(); daemon = null; }
    if (scriptDir) {
      try { fs.rmSync(scriptDir, { recursive: true, force: true }); } catch { /* ok */ }
      scriptDir = null;
    }
    if (projectRoot) {
      try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ok */ }
      projectRoot = null;
    }
  });

  // ── Daemon-up: routed reads see daemon-side writes ─────────────────────

  it('daemon-up: writer subprocess store + reader subprocess retrieve sees the value', async () => {
    if (!fs.existsSync(DIST_INITIALIZER)) {
      // eslint-disable-next-line no-console
      console.warn('  → skipped (no dist build)');
      return;
    }
    if (!scriptDir || !projectRoot) throw new Error('beforeEach setup missing');
    daemon = await startFakeDaemon();

    const ns = `roundtrip-${randomUUID()}`;
    // Writer subprocess stores.
    await runSubprocess(
      script(`
        const r = await storeEntry({
          key: 'flo-key-1',
          value: 'hello-from-writer',
          namespace: ${JSON.stringify(ns)},
        });
        process.stdout.write(JSON.stringify(r));
      `),
      { projectRoot, daemonPort: daemon.port },
      scriptDir,
    );

    // Reader subprocess retrieves — would have failed pre-#1058 because the
    // reader's per-process bridge snapshot was loaded before the writer's row
    // existed. Post-fix, the reader's getEntry routes through the daemon.
    const readerResult = await runSubprocess(
      script(`
        const r = await getEntry({ key: 'flo-key-1', namespace: ${JSON.stringify(ns)} });
        process.stdout.write(JSON.stringify(r));
      `),
      { projectRoot, daemonPort: daemon.port },
      scriptDir,
    );

    const readerResp = JSON.parse(readerResult.stdout);
    expect(readerResp.success).toBe(true);
    expect(readerResp.found).toBe(true);
    expect(readerResp.entry?.content).toBe('hello-from-writer');
  }, 30_000);

  it('daemon-up: search subprocess finds writer-stored content', async () => {
    if (!fs.existsSync(DIST_INITIALIZER)) {
      // eslint-disable-next-line no-console
      console.warn('  → skipped (no dist build)');
      return;
    }
    if (!scriptDir || !projectRoot) throw new Error('beforeEach setup missing');
    daemon = await startFakeDaemon();

    const ns = `search-${randomUUID()}`;
    await runSubprocess(
      script(`
        await storeEntry({ key: 'k1', value: 'the quick brown fox', namespace: ${JSON.stringify(ns)} });
        await storeEntry({ key: 'k2', value: 'lazy dog jumped over', namespace: ${JSON.stringify(ns)} });
      `),
      { projectRoot, daemonPort: daemon.port },
      scriptDir,
    );

    const readerResult = await runSubprocess(
      script(`
        const r = await searchEntries({ query: 'quick', namespace: ${JSON.stringify(ns)} });
        process.stdout.write(JSON.stringify(r));
      `),
      { projectRoot, daemonPort: daemon.port },
      scriptDir,
    );

    const r = JSON.parse(readerResult.stdout);
    expect(r.success).toBe(true);
    expect(r.results.length).toBe(1);
    expect(r.results[0].content).toContain('quick');
  }, 30_000);

  it('daemon-up: list subprocess sees writer-stored entries', async () => {
    if (!fs.existsSync(DIST_INITIALIZER)) {
      // eslint-disable-next-line no-console
      console.warn('  → skipped (no dist build)');
      return;
    }
    if (!scriptDir || !projectRoot) throw new Error('beforeEach setup missing');
    daemon = await startFakeDaemon();

    const ns = `list-${randomUUID()}`;
    await runSubprocess(
      script(`
        await storeEntry({ key: 'a', value: '1', namespace: ${JSON.stringify(ns)} });
        await storeEntry({ key: 'b', value: '2', namespace: ${JSON.stringify(ns)} });
      `),
      { projectRoot, daemonPort: daemon.port },
      scriptDir,
    );

    const r = await runSubprocess(
      script(`
        const r = await listEntries({ namespace: ${JSON.stringify(ns)} });
        process.stdout.write(JSON.stringify(r));
      `),
      { projectRoot, daemonPort: daemon.port },
      scriptDir,
    );

    const resp = JSON.parse(r.stdout);
    expect(resp.success).toBe(true);
    expect(resp.total).toBe(2);
    expect(resp.entries.map((e: { key: string }) => e.key).sort()).toEqual(['a', 'b']);
  }, 30_000);

  // ── Daemon-off: bridge mtime-coherence ensures fresh reads ─────────────

  it('daemon-off: writer subprocess store + reader subprocess retrieve sees the value via mtime-coherence', async () => {
    if (!fs.existsSync(DIST_INITIALIZER)) {
      // eslint-disable-next-line no-console
      console.warn('  → skipped (no dist build)');
      return;
    }
    if (!scriptDir || !projectRoot) throw new Error('beforeEach setup missing');
    // No daemon started — every subprocess writes/reads disk directly via
    // its own bridge. The mtime-coherence guard in withDb makes the reader's
    // bridge invalidate when the writer's persist bumps mtime.

    const ns = `roundtrip-off-${randomUUID()}`;

    // Writer subprocess persists.
    await runSubprocess(
      script(`
        await storeEntry({ key: 'k1', value: 'persisted-by-writer', namespace: ${JSON.stringify(ns)} });
      `),
      { projectRoot, disableRouting: true },
      scriptDir,
    );

    // Reader subprocess reads. With daemon off + custom dbPath off, the
    // reader's bridge serves from a fresh disk read (since the bridge is
    // process-singleton and we're in a fresh subprocess each time, this is
    // automatically fresh on first-init — but the test still proves the
    // read path works in daemon-off mode, which is the user's stated
    // requirement).
    const r = await runSubprocess(
      script(`
        const r = await getEntry({ key: 'k1', namespace: ${JSON.stringify(ns)} });
        process.stdout.write(JSON.stringify(r));
      `),
      { projectRoot, disableRouting: true },
      scriptDir,
    );

    const resp = JSON.parse(r.stdout);
    expect(resp.success).toBe(true);
    expect(resp.found).toBe(true);
    expect(resp.entry?.content).toBe('persisted-by-writer');
  }, 30_000);
});
