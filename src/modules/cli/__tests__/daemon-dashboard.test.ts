/**
 * Daemon Dashboard Tests
 *
 * Tests the dashboard HTTP server, API routes, and HTML serving.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';

// Mock memory-initializer for handleMemoryStats (GROUP BY query)
const mockGetNamespaceCounts = vi.fn();
vi.mock('../src/memory/memory-initializer.js', () => ({
  getNamespaceCounts: mockGetNamespaceCounts,
  searchEntries: vi.fn().mockResolvedValue({ success: true, results: [], searchTime: 0 }),
  getEntry: vi.fn().mockResolvedValue({ success: true, found: false }),
  storeEntry: vi.fn().mockResolvedValue({ success: true }),
  listEntries: vi.fn().mockResolvedValue({ success: true, entries: [], total: 0 }),
  initializeMemoryDatabase: vi.fn(),
  checkMemoryInitialization: vi.fn(),
}));

import { startDashboard, DEFAULT_DASHBOARD_PORT, type DashboardOptions, type DashboardHandle } from '../src/services/daemon-dashboard.js';

// ============================================================================
// Mock helpers
// ============================================================================

function makeMockDaemon(overrides: Record<string, unknown> = {}) {
  const defaultStatus = {
    running: true,
    pid: 12345,
    startedAt: new Date('2026-03-31T10:00:00Z'),
    workers: new Map([
      ['map', {
        isRunning: false,
        lastRun: new Date('2026-03-31T10:05:00Z'),
        nextRun: new Date('2026-03-31T10:20:00Z'),
        runCount: 5,
        successCount: 4,
        failureCount: 1,
        averageDurationMs: 1200,
      }],
      ['audit', {
        isRunning: true,
        lastRun: new Date('2026-03-31T10:08:00Z'),
        nextRun: null,
        runCount: 3,
        successCount: 3,
        failureCount: 0,
        averageDurationMs: 800,
      }],
    ]),
    config: {
      maxConcurrent: 2,
      workerTimeoutMs: 300000,
      resourceThresholds: { maxCpuLoad: 4.0, minFreeMemoryPercent: 10 },
      workers: [
        { type: 'map', intervalMs: 900000, priority: 'normal', description: 'Codebase mapping', enabled: true },
        { type: 'audit', intervalMs: 600000, priority: 'critical', description: 'Security analysis', enabled: true },
        { type: 'predict', intervalMs: 600000, priority: 'low', description: 'Predictive preloading', enabled: false },
      ],
    },
    ...overrides,
  };

  return {
    getStatus: vi.fn().mockReturnValue(defaultStatus),
  } as any;
}

function makeMockMemory(overrides: Record<string, Array<{ key: string; value: unknown; score: number }>> = {}) {
  const defaults: Record<string, Array<{ key: string; value: unknown; score: number }>> = {
    'guidance': [{ key: 'g1', value: 'v1', score: 1 }, { key: 'g2', value: 'v2', score: 1 }],
    'patterns': [{ key: 'p1', value: 'v1', score: 1 }],
    'code-map': [],
    'knowledge': [{ key: 'k1', value: 'v1', score: 1 }, { key: 'k2', value: 'v2', score: 1 }, { key: 'k3', value: 'v3', score: 1 }],
    'scheduled-workflows': [],
    'schedule-executions': [],
    'tasklist': [],
    ...overrides,
  };
  return {
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockImplementation(async (ns: string) => defaults[ns] ?? []),
  } as any;
}

// ============================================================================
// HTTP fetch helper
// ============================================================================

async function fetchDashboard(port: number, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchMethod(port: number, path: string, method: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${path}`, { method }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('DaemonDashboard', () => {
  let dashboard: DashboardHandle | null = null;
  // Use a random port range to avoid collisions in parallel test runs
  let testPort: number;

  beforeEach(() => {
    testPort = 30000 + Math.floor(Math.random() * 10000);
  });

  afterEach(async () => {
    if (dashboard) {
      await dashboard.stop();
      dashboard = null;
    }
  });

  it('serves HTML at GET /', async () => {
    const daemon = makeMockDaemon();
    dashboard = startDashboard(daemon, { port: testPort });

    // Wait for server to be ready
    await new Promise(resolve => dashboard!.server.once('listening', resolve));

    const res = await fetchDashboard(testPort, '/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('MoFlo Dashboard');
    expect(res.body).toContain('<!DOCTYPE html>');
    expect(res.body).toContain('switchTab');
  });

  it('returns daemon status at GET /api/status', async () => {
    const daemon = makeMockDaemon();
    dashboard = startDashboard(daemon, { port: testPort });
    await new Promise(resolve => dashboard!.server.once('listening', resolve));

    const res = await fetchDashboard(testPort, '/api/status');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');

    const data = JSON.parse(res.body);
    expect(data.running).toBe(true);
    expect(data.pid).toBe(12345);
    expect(data.startedAt).toBe('2026-03-31T10:00:00.000Z');
    expect(data.uptime).toBeGreaterThanOrEqual(0);
    expect(data.config.maxConcurrent).toBe(2);
    expect(data.config.enabledWorkerCount).toBe(2);
    expect(data.workers).toHaveLength(2);
    expect(data.workers[0].type).toBe('map');
    expect(data.workers[0].runCount).toBe(5);
    expect(data.workers[0].successCount).toBe(4);
    expect(data.workers[1].type).toBe('audit');
    expect(data.workers[1].isRunning).toBe(true);
  });

  it('returns schedules at GET /api/schedules', async () => {
    const daemon = makeMockDaemon();
    const memory = makeMockMemory({
      'scheduled-workflows': [{
        key: 'sched-1',
        value: JSON.stringify({ workflowName: 'security-audit', cron: '0 */6 * * *', enabled: true }),
        score: 1,
      }],
    });
    dashboard = startDashboard(daemon, { port: testPort, memory });
    await new Promise(resolve => dashboard!.server.once('listening', resolve));

    const res = await fetchDashboard(testPort, '/api/schedules');
    expect(res.status).toBe(200);

    const data = JSON.parse(res.body);
    expect(data.available).toBe(true);
    expect(data.schedules).toHaveLength(1);
    expect(data.schedules[0].workflowName).toBe('security-audit');
    expect(data.schedules[0].cron).toBe('0 */6 * * *');
    expect(data.schedules[0].enabled).toBe(true);
  });

  it('returns unavailable when memory is not provided', async () => {
    const daemon = makeMockDaemon();
    dashboard = startDashboard(daemon, { port: testPort });
    await new Promise(resolve => dashboard!.server.once('listening', resolve));

    const res = await fetchDashboard(testPort, '/api/schedules');
    const data = JSON.parse(res.body);
    expect(data.available).toBe(false);
    expect(data.schedules).toEqual([]);
  });

  it('returns workflow executions at GET /api/workflows', async () => {
    const daemon = makeMockDaemon();
    const memory = makeMockMemory({
      'schedule-executions': [{
        key: 'exec-1',
        value: JSON.stringify({ workflowName: 'security-audit', startedAt: 1711875600000, success: true, duration: 60000 }),
        score: 1,
      }],
    });
    dashboard = startDashboard(daemon, { port: testPort, memory });
    await new Promise(resolve => dashboard!.server.once('listening', resolve));

    const res = await fetchDashboard(testPort, '/api/workflows');
    const data = JSON.parse(res.body);
    expect(data.available).toBe(true);
    expect(data.executions).toHaveLength(1);
    expect(data.executions[0].workflowName).toBe('security-audit');
    expect(data.executions[0].success).toBe(true);
    expect(data.executions[0].duration).toBe(60000);
  });

  it('returns memory stats at GET /api/memory/stats', async () => {
    const daemon = makeMockDaemon();
    mockGetNamespaceCounts.mockResolvedValue({
      namespaces: { guidance: 34, patterns: 29, 'code-map': 100, knowledge: 3, tests: 10 },
      total: 176,
    });
    dashboard = startDashboard(daemon, { port: testPort });
    await new Promise(resolve => dashboard!.server.once('listening', resolve));

    const res = await fetchDashboard(testPort, '/api/memory/stats');
    const data = JSON.parse(res.body);
    expect(data.available).toBe(true);
    expect(data.totalEntries).toBe(176);
    expect(data.namespaces.guidance).toBe(34);
    expect(data.namespaces.patterns).toBe(29);
    expect(data.namespaces.knowledge).toBe(3);
    expect(data.namespaces['code-map']).toBe(100);
    expect(data.namespaces.tests).toBe(10);
  });

  it('returns 404 for unknown routes', async () => {
    const daemon = makeMockDaemon();
    dashboard = startDashboard(daemon, { port: testPort });
    await new Promise(resolve => dashboard!.server.once('listening', resolve));

    const res = await fetchDashboard(testPort, '/api/nonexistent');
    expect(res.status).toBe(404);
    const data = JSON.parse(res.body);
    expect(data.error).toBe('Not found');
  });

  it('returns 405 for non-GET methods', async () => {
    const daemon = makeMockDaemon();
    dashboard = startDashboard(daemon, { port: testPort });
    await new Promise(resolve => dashboard!.server.once('listening', resolve));

    const res = await fetchMethod(testPort, '/api/status', 'POST');
    expect(res.status).toBe(405);
    const data = JSON.parse(res.body);
    expect(data.error).toBe('Method not allowed');
  });

  it('binds to 127.0.0.1 only', async () => {
    const daemon = makeMockDaemon();
    dashboard = startDashboard(daemon, { port: testPort });
    await new Promise(resolve => dashboard!.server.once('listening', resolve));

    const addr = dashboard.server.address();
    expect(addr).not.toBeNull();
    if (typeof addr === 'object' && addr) {
      expect(addr.address).toBe('127.0.0.1');
    }
  });

  it('stop() closes the server', async () => {
    const daemon = makeMockDaemon();
    dashboard = startDashboard(daemon, { port: testPort });
    await new Promise(resolve => dashboard!.server.once('listening', resolve));

    expect(dashboard.server.listening).toBe(true);
    await dashboard.stop();
    expect(dashboard.server.listening).toBe(false);
    dashboard = null; // Prevent double-close in afterEach
  });

  it('reports the correct port', async () => {
    const daemon = makeMockDaemon();
    dashboard = startDashboard(daemon, { port: testPort });
    await new Promise(resolve => dashboard!.server.once('listening', resolve));

    expect(dashboard.port).toBe(testPort);
  });

  it('all API responses include Content-Type header', async () => {
    const daemon = makeMockDaemon();
    dashboard = startDashboard(daemon, { port: testPort });
    await new Promise(resolve => dashboard!.server.once('listening', resolve));

    const endpoints = ['/api/status', '/api/schedules', '/api/workflows', '/api/memory/stats'];
    for (const ep of endpoints) {
      const res = await fetchDashboard(testPort, ep);
      expect(res.headers['content-type']).toContain('application/json');
    }
  });

  it('DEFAULT_DASHBOARD_PORT is 3117', () => {
    expect(DEFAULT_DASHBOARD_PORT).toBe(3117);
  });
});
