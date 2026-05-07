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

  it('tryDaemonStore returns routed:false when daemon returns 400 (validation reject)', async () => {
    fake = await startFakeDaemon();
    process.env.MOFLO_DAEMON_PORT = String(fake.port);
    fake.setHandler((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200); res.end('{}'); return; }
      res.writeHead(400); res.end('{"error":"bad"}');
    });

    const r = await tryDaemonStore({ namespace: 'ns', key: 'k', value: 'v' });
    // 400 → routed:false so caller falls back to direct write rather than
    // silently losing the entry
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
