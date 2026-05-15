/**
 * Dashboard tests for #1145 — `/api/health` identity endpoint, per-project
 * port allocation, lock-file port stamping, hard-fail on bind exhaustion.
 *
 * Hermetic: uses in-process mocks for the WorkerDaemon and skips real
 * memory init. Each test picks a random port in a high range so we never
 * collide with anything else on the machine.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Mock memory-initializer so startDashboard doesn't drag in real DB code.
vi.mock('../memory/memory-initializer.js', () => ({
  getNamespaceCounts: vi.fn().mockResolvedValue({ namespaces: {}, total: 0 }),
  searchEntries: vi.fn().mockResolvedValue({ success: true, results: [], searchTime: 0 }),
  getEntry: vi.fn().mockResolvedValue({ success: true, found: false }),
  storeEntry: vi.fn().mockResolvedValue({ success: true }),
  listEntries: vi.fn().mockResolvedValue({ success: true, entries: [], total: 0 }),
  initializeMemoryDatabase: vi.fn(),
  checkMemoryInitialization: vi.fn(),
}));

import {
  startDashboard,
  type DashboardHandle,
} from '../services/daemon-dashboard.js';
import {
  acquireDaemonLock,
  releaseDaemonLock,
  getDaemonLockPayload,
} from '../services/daemon-lock.js';

function makeDaemon(): any {
  return {
    getStatus: () => ({
      running: true,
      pid: process.pid,
      startedAt: new Date(Date.now() - 5_000),
      workers: new Map(),
      config: {
        maxConcurrent: 1,
        workerTimeoutMs: 1000,
        resourceThresholds: { maxCpuLoad: 4, minFreeMemoryPercent: 10 },
        workers: [],
      },
    }),
    getScheduler: () => null,
  };
}

async function getJson(port: number, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 2000 }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: buf }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

const PRIOR_TRUST = process.env.MOFLO_TEST_TRUST_DAEMON_PID;
const PRIOR_ENV = process.env.MOFLO_DAEMON_PORT;

const handles: DashboardHandle[] = [];
const tmpRoots: string[] = [];

beforeEach(() => {
  process.env.MOFLO_TEST_TRUST_DAEMON_PID = '1';
  delete process.env.MOFLO_DAEMON_PORT;
});

afterEach(async () => {
  for (const h of handles.splice(0)) {
    try { await h.stop(); } catch { /* ignore */ }
  }
  for (const root of tmpRoots.splice(0)) {
    try { releaseDaemonLock(root, process.pid, true); } catch { /* ignore */ }
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (PRIOR_TRUST != null) process.env.MOFLO_TEST_TRUST_DAEMON_PID = PRIOR_TRUST;
  else delete process.env.MOFLO_TEST_TRUST_DAEMON_PID;
  if (PRIOR_ENV != null) process.env.MOFLO_DAEMON_PORT = PRIOR_ENV;
});

function makeProjectRoot(): string {
  const root = join(tmpdir(), `dashboard-1145-${randomUUID()}`);
  mkdirSync(join(root, '.moflo'), { recursive: true });
  tmpRoots.push(root);
  return root;
}

describe('GET /api/health (#1145)', () => {
  it('returns 200 with projectRoot, pid, version, uptimeMs', async () => {
    const root = makeProjectRoot();
    const port = 45000 + Math.floor(Math.random() * 100);
    const handle = await startDashboard(makeDaemon(), { port, projectRoot: root });
    handles.push(handle);

    const { status, body } = await getJson(handle.port, '/api/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.projectRoot).toBe(root);
    expect(body.pid).toBe(process.pid);
    expect(typeof body.uptimeMs).toBe('number');
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it('reports the requesting cwd when projectRoot opt is omitted', async () => {
    const port = 46000 + Math.floor(Math.random() * 100);
    const handle = await startDashboard(makeDaemon(), { port });
    handles.push(handle);

    const { status, body } = await getJson(handle.port, '/api/health');
    expect(status).toBe(200);
    expect(typeof body.projectRoot).toBe('string');
    expect(body.projectRoot.length).toBeGreaterThan(0);
  });
});

describe('Per-project port allocation (#1145)', () => {
  it('two dashboards rooted at different paths bind successfully', async () => {
    const rootA = makeProjectRoot();
    const rootB = makeProjectRoot();

    // No port pinned — both should auto-resolve to their per-project
    // deterministic port (or fall through to the next candidate if the
    // dev daemon happens to own one).
    const handleA = await startDashboard(makeDaemon(), { projectRoot: rootA });
    handles.push(handleA);
    const handleB = await startDashboard(makeDaemon(), { projectRoot: rootB });
    handles.push(handleB);

    expect(handleA.port).not.toBe(handleB.port);
    expect(handleA.port).toBeGreaterThanOrEqual(33000);
    expect(handleA.port).toBeLessThan(34000);
    expect(handleB.port).toBeGreaterThanOrEqual(33000);
    expect(handleB.port).toBeLessThan(34000);

    // Each daemon's /api/health reports its own root.
    const healthA = await getJson(handleA.port, '/api/health');
    const healthB = await getJson(handleB.port, '/api/health');
    expect(healthA.body.projectRoot).toBe(rootA);
    expect(healthB.body.projectRoot).toBe(rootB);
  });

  it('stamps the bound port into .moflo/daemon.lock', async () => {
    const root = makeProjectRoot();
    // Acquire the lock first so writeLockPort has something to stamp.
    acquireDaemonLock(root);

    const handle = await startDashboard(makeDaemon(), { projectRoot: root });
    handles.push(handle);

    const payload = getDaemonLockPayload(root);
    expect(payload).not.toBeNull();
    expect(payload?.port).toBe(handle.port);
  });
});

describe('Bind exhaustion (#1145 §9.4)', () => {
  it('throws when the explicitly-pinned port is in use', async () => {
    const port = 47000 + Math.floor(Math.random() * 100);
    // First server claims the port.
    const blocker = http.createServer((_, res) => res.end('blocker'));
    await new Promise<void>((resolve, reject) => {
      blocker.on('error', reject);
      blocker.listen(port, '127.0.0.1', () => resolve());
    });

    try {
      await expect(
        startDashboard(makeDaemon(), { port }),
      ).rejects.toThrow(/EADDRINUSE|in use|all dashboard ports/i);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});
