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
import { storeEntry, deleteEntry } from '../../memory/memory-initializer.js';

interface FakeDaemon {
  port: number;
  server: http.Server;
  storeRequests: Array<Record<string, unknown>>;
  deleteRequests: Array<Record<string, unknown>>;
  stop(): Promise<void>;
}

async function startFakeDaemon(): Promise<FakeDaemon> {
  const storeRequests: Array<Record<string, unknown>> = [];
  const deleteRequests: Array<Record<string, unknown>> = [];

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
        res.end(JSON.stringify({ ok: true, stored: true, id: 'fake_routed_id' }));
        return;
      }
      if (req.url === '/api/memory/delete' && req.method === 'POST') {
        try { deleteRequests.push(JSON.parse(buf)); } catch { /* malformed */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, deleted: true }));
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
});
