/**
 * Integration test: `storeEntry` / `deleteEntry` route through the daemon
 * when one is reachable (#985).
 *
 * Spins up a fake daemon HTTP server and confirms the routing preamble
 * inside memory-initializer.ts forwards the call to it. Falling-back to
 * direct sql.js when the daemon is down is covered by the existing
 * memory-initializer tests, which run with no daemon on 3117.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// We're testing the live storeEntry/deleteEntry from memory-initializer, NOT
// a mock — so we DON'T `vi.mock` memory-initializer here.

// Mock moflo-config so daemon is enabled regardless of repo state
const mockLoadConfig = vi.fn();
vi.mock('../../config/moflo-config.js', () => ({
  loadMofloConfig: mockLoadConfig,
}));

// We do NOT want the local DB write path to actually run when routing
// succeeds (the test's purpose is to assert the routing edge). Mock
// `getBridge` to null so the bridge path is skipped and the raw sql.js
// path can short-circuit harmlessly if reached. Routing should return
// before either runs.
//
// We DO let the routing preamble import and execute the live
// daemon-write-client.

import { _resetForTest } from '../../memory/daemon-write-client.js';
import {
  storeEntry,
  deleteEntry,
  getEntry,
  searchEntries,
  listEntries,
} from '../../memory/memory-initializer.js';

interface FakeDaemon {
  port: number;
  server: http.Server;
  storeRequests: Array<Record<string, unknown>>;
  deleteRequests: Array<Record<string, unknown>>;
  getRequests: Array<Record<string, unknown>>;
  searchRequests: Array<Record<string, unknown>>;
  listRequests: Array<Record<string, unknown>>;
  /** Override get response per-test (default: ok+found:false). */
  setGetResponse(body: Record<string, unknown>): void;
  setSearchResponse(body: Record<string, unknown>): void;
  setListResponse(body: Record<string, unknown>): void;
  /** Override the store response so #1065 tests don't need to monkey-patch the request listener. */
  setStoreResponse(body: Record<string, unknown>): void;
  stop(): Promise<void>;
}

async function startFakeDaemon(): Promise<FakeDaemon> {
  const storeRequests: Array<Record<string, unknown>> = [];
  const deleteRequests: Array<Record<string, unknown>> = [];
  const getRequests: Array<Record<string, unknown>> = [];
  const searchRequests: Array<Record<string, unknown>> = [];
  const listRequests: Array<Record<string, unknown>> = [];
  let getResponse: Record<string, unknown> = { ok: true, found: false };
  let searchResponse: Record<string, unknown> = { ok: true, results: [], searchTime: 0 };
  let listResponse: Record<string, unknown> = { ok: true, entries: [], total: 0 };
  let storeResponse: Record<string, unknown> = { ok: true, stored: true, id: 'fake_routed_id' };

  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', chunk => { buf += chunk; });
    req.on('end', () => {
      if (req.url === '/api/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ running: true }));
        return;
      }
      if (req.url === '/api/memory/store' && req.method === 'POST') {
        try { storeRequests.push(JSON.parse(buf)); } catch { /* malformed */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(storeResponse));
        return;
      }
      if (req.url === '/api/memory/delete' && req.method === 'POST') {
        try { deleteRequests.push(JSON.parse(buf)); } catch { /* malformed */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, deleted: true }));
        return;
      }
      if (req.url === '/api/memory/get' && req.method === 'POST') {
        try { getRequests.push(JSON.parse(buf)); } catch { /* malformed */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getResponse));
        return;
      }
      if (req.url === '/api/memory/search' && req.method === 'POST') {
        try { searchRequests.push(JSON.parse(buf)); } catch { /* malformed */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(searchResponse));
        return;
      }
      if (req.url === '/api/memory/list' && req.method === 'POST') {
        try { listRequests.push(JSON.parse(buf)); } catch { /* malformed */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(listResponse));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  const port = 30000 + Math.floor(Math.random() * 10000);
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    port,
    server,
    storeRequests,
    deleteRequests,
    getRequests,
    searchRequests,
    listRequests,
    setGetResponse(body) { getResponse = body; },
    setSearchResponse(body) { searchResponse = body; },
    setListResponse(body) { listResponse = body; },
    setStoreResponse(body) { storeResponse = body; },
    async stop() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('memory-initializer routing preamble (#985)', () => {
  let fake: FakeDaemon | null = null;
  let tempDir: string | null = null;
  /** Build a per-case dbPath under a tracked temp dir so we can clean up. */
  function tempDbPath(): string {
    if (!tempDir) {
      tempDir = path.join(tmpdir(), `moflo-981-c-${randomUUID()}`);
      fs.mkdirSync(tempDir, { recursive: true });
    }
    return path.join(tempDir, `${randomUUID()}.db`);
  }

  beforeEach(() => {
    _resetForTest();
    delete process.env.MOFLO_IS_DAEMON;
    delete process.env.MOFLO_DISABLE_DAEMON_ROUTING;
    delete process.env.MOFLO_DAEMON_PORT;
    mockLoadConfig.mockReturnValue({ daemon: { auto_start: true } });
  });

  afterEach(async () => {
    if (fake) {
      await fake.stop();
      fake = null;
    }
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      tempDir = null;
    }
    delete process.env.MOFLO_DAEMON_PORT;
    delete process.env.MOFLO_IS_DAEMON;
    delete process.env.MOFLO_DISABLE_DAEMON_ROUTING;
    _resetForTest();
  });

  it('storeEntry routes through daemon when daemon is reachable', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);

    const result = await storeEntry({
      key: 'flo-run-981',
      value: JSON.stringify({ status: 'completed' }),
      namespace: 'tasklist',
    });

    expect(result.success).toBe(true);
    expect(result.id).toBe('fake_routed_id');
    expect(fake.storeRequests.length).toBe(1);
    const req = fake.storeRequests[0];
    expect(req.namespace).toBe('tasklist');
    expect(req.key).toBe('flo-run-981');
  });

  // #1065 — the daemon now echoes `embedding: { dimensions, model }` so the
  // routed return shape matches bridge-direct. Without this, MCP memory_store
  // reports hasEmbedding:false on daemon-routed writes and the doctor Memory
  // Access check fails.
  it('storeEntry surfaces embedding metadata from the daemon-routed response (#1065)', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setStoreResponse({
      ok: true,
      stored: true,
      id: 'routed_with_emb',
      embedding: { dimensions: 384, model: 'fastembed-bge-small-en-v1.5' },
    });

    const result = await storeEntry({ key: 'k', value: 'v', namespace: 'ns' });
    expect(result.success).toBe(true);
    expect(result.id).toBe('routed_with_emb');
    expect(result.embedding).toEqual({ dimensions: 384, model: 'fastembed-bge-small-en-v1.5' });
  });

  // #1065 — daemon-route and bridge-direct paths must produce the same
  // user-visible shape for storeEntry. Without this, MCP `memory_store`
  // reports hasEmbedding inconsistently depending on which path served the
  // call — invisible to integration tests that exercise only one path.
  it('storeEntry shape parity: daemon-route and bridge-direct both yield {success,id,embedding}', async () => {
    // (a) Daemon-routed path with the new echo-embedding shape.
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setStoreResponse({
      ok: true, stored: true, id: 'routed_id',
      embedding: { dimensions: 384, model: 'fastembed-bge-small-en-v1.5' },
    });
    const routed = await storeEntry({ key: 'k-routed', value: 'v', namespace: 'ns' });

    // (b) Bridge-direct path with precomputed embedding so fastembed never runs.
    process.env.MOFLO_DISABLE_DAEMON_ROUTING = '1';
    const direct = await storeEntry({
      key: 'k-direct',
      value: 'v',
      namespace: 'ns',
      precomputedEmbedding: new Float32Array(384).fill(0.1),
      dbPath: tempDbPath(),
    });

    // Both paths advertise the same caller-visible keys.
    expect(routed.success).toBe(true);
    expect(direct.success).toBe(true);
    expect(typeof routed.id).toBe('string');
    expect(typeof direct.id).toBe('string');
    // Both paths surface embedding with dimensions + model. The model string
    // may differ (mock vs real bridge embedder) but the shape must match.
    expect(routed.embedding).toBeDefined();
    expect(direct.embedding).toBeDefined();
    expect(typeof routed.embedding!.dimensions).toBe('number');
    expect(typeof direct.embedding!.dimensions).toBe('number');
    expect(typeof routed.embedding!.model).toBe('string');
    expect(typeof direct.embedding!.model).toBe('string');
  });

  it('storeEntry skips routing when MOFLO_IS_DAEMON=1', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    process.env.MOFLO_IS_DAEMON = '1';

    // Daemon is reachable but env disables routing → no daemon call expected.
    // dbPath points into a temp dir that gets cleaned up so the local
    // write path can run safely without polluting the workspace.
    await storeEntry({
      key: 'k',
      value: 'v',
      namespace: 'ns',
      dbPath: tempDbPath(),
    });

    expect(fake.storeRequests.length).toBe(0);
  });

  it('storeEntry skips routing when MOFLO_DISABLE_DAEMON_ROUTING=1', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    process.env.MOFLO_DISABLE_DAEMON_ROUTING = '1';

    await storeEntry({
      key: 'k',
      value: 'v',
      namespace: 'ns',
      dbPath: tempDbPath(),
    });

    expect(fake.storeRequests.length).toBe(0);
  });

  it('storeEntry skips routing when a custom dbPath is supplied', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);

    // Custom dbPath = explicit "write to this DB", not a candidate for routing.
    await storeEntry({
      key: 'k',
      value: 'v',
      namespace: 'ns',
      dbPath: tempDbPath(),
    });

    expect(fake.storeRequests.length).toBe(0);
  });

  it('storeEntry falls back to direct write when daemon is unreachable', async () => {
    // No fake started — port pointed at nothing
    process.env.MOFLO_DAEMON_PORT = String(40000 + Math.floor(Math.random() * 10000));

    // Existing direct-write path runs. We aren't validating its output here
    // (covered by other tests); only that the call returns without
    // crashing on the routing failure.
    const result = await storeEntry({
      key: 'k',
      value: 'v',
      namespace: 'ns',
      dbPath: tempDbPath(),
    });

    // Whether the direct write succeeded or not, the routing layer
    // didn't propagate a fault. result is well-formed.
    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
  });

  // ==========================================================================
  // Idempotency guard for the daemon→bridge→fallback cascade
  // ==========================================================================
  //
  // Repro: a `memory store` for a key whose row is already on disk (e.g.
  // because the daemon route just persisted it but the client missed the
  // ack, or the bridge wrote then threw post-persist) used to cascade
  // through bridge UNIQUE → withDb null → raw-sql.js UNIQUE → exit 1.
  // The fix in `storeEntry`'s fallback short-circuits to success when the
  // existing row's content matches the caller's value (and `upsert` is
  // false — upsert callers want REPLACE semantics either way).

  it('storeEntry returns success when the row is already present with matching content', async () => {
    // No daemon running — keep routing out of this test entirely.
    process.env.MOFLO_DISABLE_DAEMON_ROUTING = '1';
    const dbPath = tempDbPath();

    const first = await storeEntry({
      key: 'idem-key',
      value: 'same-value',
      namespace: 'idem-ns',
      dbPath,
    });
    expect(first.success).toBe(true);

    const second = await storeEntry({
      key: 'idem-key',
      value: 'same-value',
      namespace: 'idem-ns',
      dbPath,
    });
    expect(second.success).toBe(true);
    // The fix's intent is to return the *existing* row's id rather than
    // insert a fresh one. Without this assertion, a regression that wrote
    // a new row alongside the old (possible only if probes silently no-op'd)
    // would still pass the success check.
    expect(second.id).toBe(first.id);
  });

  it('deleteEntry routes through daemon when daemon is reachable', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);

    const result = await deleteEntry({ key: 'k1', namespace: 'tasklist' });
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(true);
    expect(fake.deleteRequests.length).toBe(1);
    expect(fake.deleteRequests[0].namespace).toBe('tasklist');
    expect(fake.deleteRequests[0].key).toBe('k1');
  });

  it('deleteEntry skips routing when MOFLO_IS_DAEMON=1', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    process.env.MOFLO_IS_DAEMON = '1';

    await deleteEntry({ key: 'k', namespace: 'ns', dbPath: tempDbPath() });
    expect(fake.deleteRequests.length).toBe(0);
  });

  // ==========================================================================
  // Read-side routing preamble (#1058 / epic #1054)
  // ==========================================================================
  //
  // Read-symmetry with the write fix from #985. Without it, a non-daemon
  // process (MCP server, CLI subprocess) reads from its own per-process
  // bridge snapshot loaded at start time — sql.js never re-reads disk, so
  // anything the daemon has written since is invisible. The preamble routes
  // reads through the daemon's HTTP RPC so callers see the authoritative
  // state.

  it('getEntry routes through daemon when daemon is reachable', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setGetResponse({
      ok: true,
      found: true,
      entry: {
        id: 'e1', key: 'k', namespace: 'ns', content: 'daemon-served',
        accessCount: 7, createdAt: '2026-01-01', updatedAt: '2026-01-02',
        hasEmbedding: true, tags: [],
      },
    });

    const result = await getEntry({ key: 'k', namespace: 'ns' });
    expect(result.success).toBe(true);
    expect(result.found).toBe(true);
    expect(result.entry?.content).toBe('daemon-served');
    expect(fake.getRequests.length).toBe(1);
    expect(fake.getRequests[0].key).toBe('k');
    expect(fake.getRequests[0].namespace).toBe('ns');
  });

  it('getEntry skips routing when MOFLO_IS_DAEMON=1', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    process.env.MOFLO_IS_DAEMON = '1';

    await getEntry({ key: 'k', namespace: 'ns', dbPath: tempDbPath() });
    expect(fake.getRequests.length).toBe(0);
  });

  it('getEntry skips routing when MOFLO_DISABLE_DAEMON_ROUTING=1', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    process.env.MOFLO_DISABLE_DAEMON_ROUTING = '1';

    await getEntry({ key: 'k', namespace: 'ns', dbPath: tempDbPath() });
    expect(fake.getRequests.length).toBe(0);
  });

  it('getEntry skips routing when a custom dbPath is supplied', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);

    await getEntry({ key: 'k', namespace: 'ns', dbPath: tempDbPath() });
    expect(fake.getRequests.length).toBe(0);
  });

  it('searchEntries routes through daemon when daemon is reachable', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setSearchResponse({
      ok: true,
      results: [
        { id: 'r1', key: 'k1', content: 'c1', score: 0.92, namespace: 'ns' },
      ],
      searchTime: 7,
    });

    const result = await searchEntries({ query: 'hello', namespace: 'ns', limit: 5 });
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].score).toBe(0.92);
    expect(result.searchTime).toBe(7);
    expect(fake.searchRequests.length).toBe(1);
    expect(fake.searchRequests[0].query).toBe('hello');
  });

  it('searchEntries skips routing when MOFLO_IS_DAEMON=1', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    process.env.MOFLO_IS_DAEMON = '1';

    await searchEntries({ query: 'q', dbPath: tempDbPath() });
    expect(fake.searchRequests.length).toBe(0);
  });

  it('listEntries routes through daemon when daemon is reachable', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setListResponse({
      ok: true,
      entries: [
        { id: 'a', key: 'k1', namespace: 'ns', size: 10, accessCount: 0, createdAt: '', updatedAt: '', hasEmbedding: false },
      ],
      total: 99,
    });

    const result = await listEntries({ namespace: 'ns', limit: 50 });
    expect(result.success).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.total).toBe(99);
    expect(fake.listRequests.length).toBe(1);
    expect(fake.listRequests[0].namespace).toBe('ns');
  });

  it('listEntries skips routing when MOFLO_IS_DAEMON=1', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    process.env.MOFLO_IS_DAEMON = '1';

    await listEntries({ namespace: 'ns', dbPath: tempDbPath() });
    expect(fake.listRequests.length).toBe(0);
  });

  it('read functions fall back to direct path when daemon is unreachable', async () => {
    // No fake started.
    process.env.MOFLO_DAEMON_PORT = String(40000 + Math.floor(Math.random() * 10000));
    const dbPath = tempDbPath();
    // Seed a row directly so the local-bridge / raw-sql.js fallback has data
    // to find. dbPath bypasses routing for the seed AND for the read.
    await storeEntry({ key: 'k', value: 'v', namespace: 'ns', dbPath });
    const read = await getEntry({ key: 'k', namespace: 'ns', dbPath });
    // The fallback path must produce a well-formed response (the routing
    // failure must not poison the call). dbPath bypasses routing anyway, so
    // this test mostly proves "no throw on daemon-down".
    expect(read).toBeDefined();
    expect(typeof read.success).toBe('boolean');
  });
});
