/**
 * Tests for `probeDaemonHealthWithRetry` (#1163).
 *
 * Validates that the retry wrapper absorbs transient `unreachable` results
 * (Windows CI daemon-mid-boot race) while letting `identity` and `legacy`
 * pass through as terminal.
 *
 * Uses a real localhost HTTP server bound to an ephemeral port so we exercise
 * the same TCP path the production probe uses — no mocking of `http.get`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  probeDaemonHealth,
  probeDaemonHealthWithRetry,
} from '../../services/daemon-port.js';

let server: Server | null = null;
let port = 0;

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

function startServer(handler: (req: any, res: any) => void): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address() as AddressInfo;
      server = s;
      port = addr.port;
      resolve(addr.port);
    });
  });
}

describe('probeDaemonHealthWithRetry — #1163', () => {
  it('returns identity on first success without retry overhead', async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ projectRoot: '/some/root' }));
    });

    const start = Date.now();
    const probe = await probeDaemonHealthWithRetry(port, 500);
    const elapsed = Date.now() - start;

    expect(probe).toEqual({ kind: 'identity', projectRoot: '/some/root' });
    // First attempt is immediate (no backoff sleep), so elapsed << 50ms.
    expect(elapsed).toBeLessThan(200);
  });

  it('passes through legacy (404) without retrying', async () => {
    await startServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    const start = Date.now();
    const probe = await probeDaemonHealthWithRetry(port, 500);
    const elapsed = Date.now() - start;

    expect(probe).toEqual({ kind: 'legacy' });
    // 404 is terminal — no backoff sleeps fired.
    expect(elapsed).toBeLessThan(200);
  });

  it('retries on unreachable and recovers when the server comes up mid-cycle', async () => {
    // Find an unused port: bind+immediately close a server. Race window is
    // narrow but acceptable for a test — if EADDRINUSE fires the test will
    // legitimately fail.
    const probeOnly = createServer();
    await new Promise<void>((r) => probeOnly.listen(0, '127.0.0.1', () => r()));
    const targetPort = (probeOnly.address() as AddressInfo).port;
    await new Promise<void>((r) => probeOnly.close(() => r()));

    // Start the retry in parallel; server comes up after ~150ms (after the
    // first backoff of 50ms but during the second of 200ms).
    const probePromise = probeDaemonHealthWithRetry(targetPort, 300);
    setTimeout(() => {
      createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ projectRoot: '/late/boot' }));
      }).listen(targetPort, '127.0.0.1', () => {
        // capture for cleanup
        server = null;
      });
    }, 150);

    const probe = await probePromise;
    expect(probe.kind).toBe('identity');
    if (probe.kind === 'identity') {
      expect(probe.projectRoot).toBe('/late/boot');
    }
  });

  it('returns unreachable after exhausting retries (no listener at all)', async () => {
    // Same probe-and-close trick to find a free port we know is empty.
    const probeOnly = createServer();
    await new Promise<void>((r) => probeOnly.listen(0, '127.0.0.1', () => r()));
    const deadPort = (probeOnly.address() as AddressInfo).port;
    await new Promise<void>((r) => probeOnly.close(() => r()));

    const start = Date.now();
    const probe = await probeDaemonHealthWithRetry(deadPort, 100);
    const elapsed = Date.now() - start;

    expect(probe).toEqual({ kind: 'unreachable' });
    // 4 attempts × ~100ms probe + 50+200+800ms backoff ≈ ~1450ms floor.
    // Allow generous slack for CI scheduler jitter; the important assertion
    // is that we ARE waiting for the retries, not bailing on first failure.
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  it('base probeDaemonHealth does NOT retry (regression guard)', async () => {
    const probeOnly = createServer();
    await new Promise<void>((r) => probeOnly.listen(0, '127.0.0.1', () => r()));
    const deadPort = (probeOnly.address() as AddressInfo).port;
    await new Promise<void>((r) => probeOnly.close(() => r()));

    const start = Date.now();
    const probe = await probeDaemonHealth(deadPort, 100);
    const elapsed = Date.now() - start;

    expect(probe).toEqual({ kind: 'unreachable' });
    // One-shot — should return within ~timeout + connect-refuse latency.
    expect(elapsed).toBeLessThan(500);
  });
});
