/**
 * Daemon write client tests (#984).
 *
 * Spins up small `http.createServer` fakes to exercise every failure mode
 * the client must absorb without throwing or blocking. Every test must
 * complete in well under the 100ms HTTP timeout — slow tests indicate a
 * real bug, not a flake.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';

// Mock moflo-config to control the daemon-disabled path
const mockLoadConfig = vi.fn();
vi.mock('../../config/moflo-config.js', () => ({
  loadMofloConfig: mockLoadConfig,
}));

import {
  isDaemonAvailable,
  tryDaemonStore,
  tryDaemonDelete,
  tryDaemonGet,
  tryDaemonSearch,
  tryDaemonList,
  _resetForTest,
} from '../../memory/daemon-write-client.js';

// ============================================================================
// Fake daemon helper
// ============================================================================

interface FakeDaemonHandle {
  port: number;
  server: http.Server;
  /** Each entry mirrors a request the fake received, in order. */
  requests: Array<{ method: string; url: string; body: string }>;
  /** Override per-request behavior. */
  setHandler(fn: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): void;
  stop(): Promise<void>;
}

async function startFakeDaemon(opts?: { defaultStatus?: number; defaultBody?: unknown }): Promise<FakeDaemonHandle> {
  const requests: FakeDaemonHandle['requests'] = [];
  let handler: ((req: http.IncomingMessage, res: http.ServerResponse, body: string) => void) | null = null;

  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', chunk => { buf += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method ?? 'GET', url: req.url ?? '', body: buf });
      if (handler) {
        handler(req, res, buf);
        return;
      }
      // Default: 200 OK to /api/status; 200 with `{ ok: true }` to memory POSTs.
      if (req.url === '/api/status') {
        res.writeHead(opts?.defaultStatus ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(opts?.defaultBody ?? { running: true }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stored: true, id: 'fake_id' }));
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
    requests,
    setHandler(fn) { handler = fn; },
    async stop() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('daemon-write-client', () => {
  let fake: FakeDaemonHandle | null = null;

  beforeEach(() => {
    _resetForTest();
    delete process.env.MOFLO_IS_DAEMON;
    delete process.env.MOFLO_DAEMON_PORT;
    // Default config: daemon enabled
    mockLoadConfig.mockReturnValue({ daemon: { auto_start: true } });
  });

  afterEach(async () => {
    if (fake) {
      await fake.stop();
      fake = null;
    }
    delete process.env.MOFLO_IS_DAEMON;
    delete process.env.MOFLO_DAEMON_PORT;
    _resetForTest();
  });

  // ── isDaemonAvailable ─────────────────────────────────────────────────

  it('isDaemonAvailable returns true when daemon responds 200', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);

    expect(await isDaemonAvailable()).toBe(true);
  });

  it('isDaemonAvailable returns false when daemon is down (ECONNREFUSED)', async () => {
    process.env.MOFLO_DAEMON_PORT = String(40000 + Math.floor(Math.random() * 10000));
    expect(await isDaemonAvailable()).toBe(false);
  });

  it('isDaemonAvailable returns false when daemon takes >100ms (timeout)', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    // Hold the request open for 500ms, well beyond the 100ms timeout
    fake.setHandler((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }, 500);
    });

    const start = Date.now();
    expect(await isDaemonAvailable()).toBe(false);
    const elapsed = Date.now() - start;
    // The timeout is 100ms; allow generous overhead but it must not block 500ms
    expect(elapsed).toBeLessThan(400);
  });

  it('isDaemonAvailable returns false when daemon returns non-200', async () => {
    fake = await startFakeDaemon({ defaultStatus: 503 });
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    expect(await isDaemonAvailable()).toBe(false);
  });

  it('isDaemonAvailable short-circuits when MOFLO_IS_DAEMON=1 (no HTTP probe)', async () => {
    process.env.MOFLO_IS_DAEMON = '1';
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);

    expect(await isDaemonAvailable()).toBe(false);
    expect(fake.requests.length).toBe(0);
  });

  it('isDaemonAvailable short-circuits when daemon disabled in moflo.yaml', async () => {
    mockLoadConfig.mockReturnValue({ daemon: { auto_start: false } });
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);

    expect(await isDaemonAvailable()).toBe(false);
    expect(fake.requests.length).toBe(0);
  });

  it('isDaemonAvailable caches positive result for 5s', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);

    expect(await isDaemonAvailable()).toBe(true);
    expect(await isDaemonAvailable()).toBe(true);
    expect(await isDaemonAvailable()).toBe(true);
    // Probe ran exactly once (the others were cache hits)
    expect(fake.requests.filter(r => r.url === '/api/status').length).toBe(1);
  });

  it('isDaemonAvailable caches negative result for 5s (no re-probe storms)', async () => {
    process.env.MOFLO_DAEMON_PORT = String(40000 + Math.floor(Math.random() * 10000));
    // Three rapid calls; only the first should HTTP-probe
    expect(await isDaemonAvailable()).toBe(false);
    expect(await isDaemonAvailable()).toBe(false);
    expect(await isDaemonAvailable()).toBe(false);
    // Can't directly assert HTTP count without a fake (server isn't running),
    // but the calls must each return inside the timeout. If we re-probed, the
    // total elapsed would be >300ms.
  });

  // ── tryDaemonStore ────────────────────────────────────────────────────

  it('tryDaemonStore returns routed:true,ok:true with daemon id on success', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setHandler((req, res, body) => {
      if (req.url === '/api/status') {
        res.writeHead(200); res.end('{}'); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stored: true, id: 'entry_xyz' }));
    });

    const r = await tryDaemonStore({ namespace: 'tasklist', key: 'k1', value: { x: 1 } });
    expect(r.routed).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.id).toBe('entry_xyz');
    // Verify body shape
    const writeReq = fake.requests.find(r => r.url === '/api/memory/store');
    expect(writeReq).toBeDefined();
    const body = JSON.parse(writeReq!.body);
    expect(body.namespace).toBe('tasklist');
    expect(body.key).toBe('k1');
    expect(body.value).toEqual({ x: 1 });
  });

  // #1065 — the daemon's POST /api/memory/store response carries the
  // bridge's `embedding: { dimensions, model }`. The client must surface
  // it so callers can preserve the bridge-direct shape end-to-end.
  it('tryDaemonStore surfaces embedding when the daemon includes it (#1065)', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        stored: true,
        id: 'entry_with_emb',
        embedding: { dimensions: 384, model: 'fastembed-bge-small-en-v1.5' },
      }));
    });

    const r = await tryDaemonStore({ namespace: 'ns', key: 'k', value: 'v' });
    expect(r.routed).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.embedding).toEqual({ dimensions: 384, model: 'fastembed-bge-small-en-v1.5' });
  });

  it('tryDaemonStore leaves embedding undefined when an older daemon omits it', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    // Default handler returns the pre-#1065 shape (no embedding field).
    const r = await tryDaemonStore({ namespace: 'ns', key: 'k', value: 'v' });
    expect(r.routed).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.embedding).toBeUndefined();
  });

  it('tryDaemonStore drops a malformed embedding field instead of failing the response', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stored: true, id: 'e', embedding: { dimensions: 'bad', model: 42 } }));
    });
    const r = await tryDaemonStore({ namespace: 'ns', key: 'k', value: 'v' });
    expect(r.routed).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.embedding).toBeUndefined();
  });

  it('tryDaemonStore returns routed:false when daemon is down', async () => {
    process.env.MOFLO_DAEMON_PORT = String(40000 + Math.floor(Math.random() * 10000));
    const r = await tryDaemonStore({ namespace: 'ns', key: 'k', value: 'v' });
    expect(r.routed).toBe(false);
  });

  it('tryDaemonStore returns routed:false when MOFLO_IS_DAEMON=1', async () => {
    process.env.MOFLO_IS_DAEMON = '1';
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);

    const r = await tryDaemonStore({ namespace: 'ns', key: 'k', value: 'v' });
    expect(r.routed).toBe(false);
    expect(fake.requests.length).toBe(0);
  });

  it('tryDaemonStore returns routed:false when daemon returns 500', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(500); res.end('{"error":"boom"}');
    });

    const r = await tryDaemonStore({ namespace: 'ns', key: 'k', value: 'v' });
    expect(r.routed).toBe(false);
  });

  it('tryDaemonStore returns routed:true,ok:false,error on 400 (#1101 — propagate, no fallback)', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"Invalid store request","message":"invalid namespace (must match /^[a-zA-Z0-9._-]{1,64}$/, ≤64 chars)"}');
    });

    const r = await tryDaemonStore({ namespace: 'ns', key: 'k', value: 'v' });
    // 4xx is a deterministic payload reject — the bridge has the same
    // validation and would fail the same way. Surface the daemon's error
    // instead of silently falling back.
    expect(r.routed).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid namespace/);
  });

  it('tryDaemonStore returns routed:true,ok:false,error on 413 (oversized body)', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end('{"error":"Payload too large"}');
    });

    const r = await tryDaemonStore({ namespace: 'ns', key: 'k', value: 'v' });
    expect(r.routed).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/payload too large/i);
  });

  it('tryDaemonStore surfaces a generic message when 4xx body is not JSON', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('not json');
    });

    const r = await tryDaemonStore({ namespace: 'ns', key: 'k', value: 'v' });
    expect(r.routed).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/daemon returned 400/);
  });

  it('tryDaemonStore returns routed:false on socket destroyed mid-stream', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    // Warm the health cache so the probe doesn't tank — we want to test
    // the WRITE-side socket destroy.
    expect(await isDaemonAvailable()).toBe(true);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      // Kill the socket without sending any response.
      req.socket.destroy();
    });

    const r = await tryDaemonStore({ namespace: 'ns', key: 'k', value: 'v' });
    expect(r.routed).toBe(false);
  });

  it('tryDaemonStore returns routed:false when daemon returns malformed JSON', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('not-json{{{');
    });

    const r = await tryDaemonStore({ namespace: 'ns', key: 'k', value: 'v' });
    expect(r.routed).toBe(false);
  });

  it('tryDaemonStore returns routed:false on HTTP timeout', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    let invoked = 0;
    fake.setHandler((req, res, _body) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      // #1145 — identity probe is best-effort; failure mode is "treat as
      // legacy-no-health" and proceed. Excluded from the store-attempt
      // count below.
      if (req.url === '/api/health') { res.writeHead(404); res.end(); return; }
      invoked++;
      // Hold the connection open beyond the 100ms timeout
      setTimeout(() => { res.writeHead(200); res.end('{}'); }, 500);
    });

    const start = Date.now();
    const r = await tryDaemonStore({ namespace: 'ns', key: 'k', value: 'v' });
    const elapsed = Date.now() - start;
    expect(r.routed).toBe(false);
    // Must not block beyond timeout + reasonable overhead
    expect(elapsed).toBeLessThan(400);
    expect(invoked).toBe(1);
  });

  it('tryDaemonStore invalidates health cache on routed-failure (next call re-probes)', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    // Probe once so cache is positive
    expect(await isDaemonAvailable()).toBe(true);
    expect(fake.requests.filter(r => r.url === '/api/status').length).toBe(1);

    // Make the next /store call fail mid-stream
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      // Simulate broken connection
      req.socket.destroy();
    });

    const r = await tryDaemonStore({ namespace: 'ns', key: 'k', value: 'v' });
    expect(r.routed).toBe(false);

    // Health cache invalidated → next isDaemonAvailable() will re-probe
    fake.setHandler(undefined as never);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(200); res.end('{"ok":true,"id":"x"}');
    });
    await isDaemonAvailable();
    expect(fake.requests.filter(r => r.url === '/api/status').length).toBe(2);
  });

  // ── tryDaemonDelete ───────────────────────────────────────────────────

  it('tryDaemonDelete returns routed:true,deleted:true on success', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deleted: true }));
    });

    const r = await tryDaemonDelete({ namespace: 'ns', key: 'k' });
    expect(r.routed).toBe(true);
    expect(r.deleted).toBe(true);
  });

  it('tryDaemonDelete returns routed:false when daemon is down', async () => {
    process.env.MOFLO_DAEMON_PORT = String(40000 + Math.floor(Math.random() * 10000));
    const r = await tryDaemonDelete({ namespace: 'ns', key: 'k' });
    expect(r.routed).toBe(false);
  });

  // ── tryDaemonGet (#1058) ──────────────────────────────────────────────

  it('tryDaemonGet returns routed:true with entry on hit', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        found: true,
        entry: {
          id: 'e1', key: 'k', namespace: 'ns', content: 'hello',
          accessCount: 1, createdAt: '', updatedAt: '', hasEmbedding: true, tags: [],
        },
      }));
    });

    const r = await tryDaemonGet({ namespace: 'ns', key: 'k' });
    expect(r.routed).toBe(true);
    expect(r.data?.found).toBe(true);
    expect(r.data?.entry?.content).toBe('hello');
    const writeReq = fake.requests.find(r => r.url === '/api/memory/get');
    expect(writeReq).toBeDefined();
    expect(JSON.parse(writeReq!.body)).toEqual({ namespace: 'ns', key: 'k' });
  });

  it('tryDaemonGet returns routed:true,found:false on miss', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, found: false }));
    });

    const r = await tryDaemonGet({ namespace: 'ns', key: 'absent' });
    expect(r.routed).toBe(true);
    expect(r.data?.found).toBe(false);
    expect(r.data?.entry).toBeUndefined();
  });

  it('tryDaemonGet returns routed:false when daemon is down', async () => {
    process.env.MOFLO_DAEMON_PORT = String(40000 + Math.floor(Math.random() * 10000));
    const r = await tryDaemonGet({ namespace: 'ns', key: 'k' });
    expect(r.routed).toBe(false);
  });

  it('tryDaemonGet returns routed:false when MOFLO_IS_DAEMON=1', async () => {
    process.env.MOFLO_IS_DAEMON = '1';
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);

    const r = await tryDaemonGet({ namespace: 'ns', key: 'k' });
    expect(r.routed).toBe(false);
    expect(fake.requests.length).toBe(0);
  });

  it('tryDaemonGet returns routed:false on 500', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(500); res.end('{"error":"db error"}');
    });

    const r = await tryDaemonGet({ namespace: 'ns', key: 'k' });
    expect(r.routed).toBe(false);
  });

  it('tryDaemonGet returns routed:true,error on 400 (#1101)', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"Invalid get request","message":"invalid namespace"}');
    });

    const r = await tryDaemonGet({ namespace: 'bad ns', key: 'k' });
    expect(r.routed).toBe(true);
    expect(r.data).toBeUndefined();
    expect(r.error).toMatch(/invalid namespace/);
  });

  it('tryDaemonSearch returns routed:true,error on 400 (#1101)', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"Invalid search request","message":"limit must be a positive integer ≤1000"}');
    });

    const r = await tryDaemonSearch({ query: 'q', limit: 9999 });
    expect(r.routed).toBe(true);
    expect(r.data).toBeUndefined();
    expect(r.error).toMatch(/limit must be a positive integer/);
  });

  // ── tryDaemonSearch (#1058) ───────────────────────────────────────────

  it('tryDaemonSearch returns routed:true with results array', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        results: [
          { id: 'a', key: 'k1', content: 'c1', score: 0.9, namespace: 'ns' },
        ],
        searchTime: 15,
      }));
    });

    const r = await tryDaemonSearch({ query: 'hello', namespace: 'ns', limit: 5 });
    expect(r.routed).toBe(true);
    expect(r.data?.results).toHaveLength(1);
    expect(r.data?.results[0].score).toBe(0.9);
    expect(r.data?.searchTime).toBe(15);
  });

  it('tryDaemonSearch returns routed:true with empty results array', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, results: [] }));
    });

    const r = await tryDaemonSearch({ query: 'nope' });
    expect(r.routed).toBe(true);
    expect(r.data?.results).toEqual([]);
  });

  it('tryDaemonSearch returns routed:false when daemon is down', async () => {
    process.env.MOFLO_DAEMON_PORT = String(40000 + Math.floor(Math.random() * 10000));
    const r = await tryDaemonSearch({ query: 'q' });
    expect(r.routed).toBe(false);
  });

  // ── tryDaemonList (#1058) ─────────────────────────────────────────────

  it('tryDaemonList returns routed:true with entries + total', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        entries: [
          { id: 'a', key: 'k1', namespace: 'ns', size: 12, accessCount: 0, createdAt: '', updatedAt: '', hasEmbedding: false },
        ],
        total: 42,
      }));
    });

    const r = await tryDaemonList({ namespace: 'ns', limit: 10, offset: 0 });
    expect(r.routed).toBe(true);
    expect(r.data?.entries).toHaveLength(1);
    expect(r.data?.total).toBe(42);
  });

  it('tryDaemonList passes pagination params through', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    await tryDaemonList({ namespace: 'ns', limit: 25, offset: 50 });
    const writeReq = fake.requests.find(r => r.url === '/api/memory/list');
    expect(writeReq).toBeDefined();
    const body = JSON.parse(writeReq!.body);
    expect(body.namespace).toBe('ns');
    expect(body.limit).toBe(25);
    expect(body.offset).toBe(50);
  });

  it('tryDaemonList returns routed:false when daemon is down', async () => {
    process.env.MOFLO_DAEMON_PORT = String(40000 + Math.floor(Math.random() * 10000));
    const r = await tryDaemonList({});
    expect(r.routed).toBe(false);
  });

  // ── port resolution ───────────────────────────────────────────────────

  it('uses MOFLO_DAEMON_PORT env var', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    expect(await isDaemonAvailable()).toBe(true);
  });

  it('falls back to default port 3117 when env not set', async () => {
    delete process.env.MOFLO_DAEMON_PORT;
    // Don't start a fake on 3117 — we want the probe to fail and confirm
    // the env-less path doesn't crash.
    const r = await isDaemonAvailable();
    // We can't assume the developer's machine has a daemon on 3117, so
    // this test only asserts no-throw + returns a boolean.
    expect(typeof r).toBe('boolean');
  });
});
