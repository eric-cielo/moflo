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

import { startDashboard, DEFAULT_DASHBOARD_PORT, buildFloRunContext, storeFloRunRecord, type DashboardOptions, type DashboardHandle } from '../src/services/daemon-dashboard.js';

// ============================================================================
// Mock helpers
// ============================================================================

/** Build a mock SpellScheduler that mimics the subset of the API the dashboard touches. */
function makeMockScheduler(opts: {
  schedules?: Array<Record<string, unknown>>;
  history?: Record<string, Array<Record<string, unknown>>>;
} = {}) {
  const schedules = new Map<string, Record<string, unknown>>();
  for (const s of opts.schedules ?? []) schedules.set(s.id as string, { ...s });
  const history = { ...(opts.history ?? {}) };

  const scheduler = {
    listSchedules: vi.fn().mockImplementation(async () => [...schedules.values()]),
    getExecutionHistory: vi.fn().mockImplementation(async (id: string) => history[id] ?? []),
    getRecentExecutions: vi.fn().mockImplementation(async (limit = 50) => {
      const all = Object.values(history).flat() as Array<Record<string, unknown>>;
      return all.sort((a, b) => (b.startedAt as number) - (a.startedAt as number)).slice(0, limit);
    }),
    cancelSchedule: vi.fn().mockImplementation(async (id: string) => {
      const s = schedules.get(id);
      if (!s) return false;
      s.enabled = false;
      return true;
    }),
    enableSchedule: vi.fn().mockImplementation(async (id: string) => {
      const s = schedules.get(id);
      if (!s) return null;
      s.enabled = true;
      s.nextRunAt = Date.now() + 3_600_000;
      return s;
    }),
    runScheduleNow: vi.fn().mockImplementation(async (id: string) => {
      const s = schedules.get(id);
      if (!s) throw new Error(`Schedule not found: ${id}`);
      const exec = {
        id: `exec-manual-${id}-${Date.now()}`,
        scheduleId: id,
        spellName: s.spellName,
        startedAt: Date.now(),
        manualRun: true,
        success: true,
        duration: 42,
      };
      history[id] = [...(history[id] ?? []), exec];
      return exec;
    }),
  };
  return { scheduler, schedules, history };
}

function makeMockDaemon(overrides: Record<string, unknown> = {}, scheduler: any = null) {
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
    getScheduler: vi.fn().mockReturnValue(scheduler),
  } as any;
}

function makeMockMemory(overrides: Record<string, Array<{ key: string; value: unknown; score: number }>> = {}) {
  const defaults: Record<string, Array<{ key: string; value: unknown; score: number }>> = {
    'guidance': [{ key: 'g1', value: 'v1', score: 1 }, { key: 'g2', value: 'v2', score: 1 }],
    'patterns': [{ key: 'p1', value: 'v1', score: 1 }],
    'code-map': [],
    'knowledge': [{ key: 'k1', value: 'v1', score: 1 }, { key: 'k2', value: 'v2', score: 1 }, { key: 'k3', value: 'v3', score: 1 }],
    'scheduled-spells': [],
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
    dashboard = await startDashboard(daemon, { port: testPort });

    const res = await fetchDashboard(testPort, '/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('MoFlo Dashboard');
    expect(res.body).toContain('<!DOCTYPE html>');
    expect(res.body).toContain('switchTab');
  });

  it('returns daemon status at GET /api/status', async () => {
    const daemon = makeMockDaemon();
    dashboard = await startDashboard(daemon, { port: testPort });

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
      'scheduled-spells': [{
        key: 'sched-1',
        value: JSON.stringify({ spellName: 'security-audit', cron: '0 */6 * * *', enabled: true }),
        score: 1,
      }],
    });
    dashboard = await startDashboard(daemon, { port: testPort, memory });

    const res = await fetchDashboard(testPort, '/api/schedules');
    expect(res.status).toBe(200);

    const data = JSON.parse(res.body);
    expect(data.available).toBe(true);
    expect(data.schedules).toHaveLength(1);
    expect(data.schedules[0].spellName).toBe('security-audit');
    expect(data.schedules[0].cron).toBe('0 */6 * * *');
    expect(data.schedules[0].enabled).toBe(true);
  });

  it('returns unavailable when memory is not provided', async () => {
    const daemon = makeMockDaemon();
    dashboard = await startDashboard(daemon, { port: testPort });

    const res = await fetchDashboard(testPort, '/api/schedules');
    const data = JSON.parse(res.body);
    expect(data.available).toBe(false);
    expect(data.schedules).toEqual([]);
  });

  it('returns spell executions at GET /api/spells', async () => {
    const daemon = makeMockDaemon();
    const memory = makeMockMemory({
      'schedule-executions': [{
        key: 'exec-1',
        value: JSON.stringify({ spellName: 'security-audit', startedAt: 1711875600000, success: true, duration: 60000 }),
        score: 1,
      }],
    });
    dashboard = await startDashboard(daemon, { port: testPort, memory });

    const res = await fetchDashboard(testPort, '/api/spells');
    const data = JSON.parse(res.body);
    expect(data.available).toBe(true);
    expect(data.executions).toHaveLength(1);
    expect(data.executions[0].spellName).toBe('security-audit');
    expect(data.executions[0].success).toBe(true);
    expect(data.executions[0].duration).toBe(60000);
  });

  it('returns memory stats at GET /api/memory/stats', async () => {
    const daemon = makeMockDaemon();
    mockGetNamespaceCounts.mockResolvedValue({
      namespaces: { guidance: 34, patterns: 29, 'code-map': 100, knowledge: 3, tests: 10 },
      total: 176,
    });
    dashboard = await startDashboard(daemon, { port: testPort });

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
    dashboard = await startDashboard(daemon, { port: testPort });

    const res = await fetchDashboard(testPort, '/api/nonexistent');
    expect(res.status).toBe(404);
    const data = JSON.parse(res.body);
    expect(data.error).toBe('Not found');
  });

  it('returns 405 for non-GET methods', async () => {
    const daemon = makeMockDaemon();
    dashboard = await startDashboard(daemon, { port: testPort });

    const res = await fetchMethod(testPort, '/api/status', 'POST');
    expect(res.status).toBe(405);
    const data = JSON.parse(res.body);
    expect(data.error).toBe('Method not allowed');
  });

  it('binds to 127.0.0.1 only', async () => {
    const daemon = makeMockDaemon();
    dashboard = await startDashboard(daemon, { port: testPort });

    const addr = dashboard.server.address();
    expect(addr).not.toBeNull();
    if (typeof addr === 'object' && addr) {
      expect(addr.address).toBe('127.0.0.1');
    }
  });

  it('stop() closes the server', async () => {
    const daemon = makeMockDaemon();
    dashboard = await startDashboard(daemon, { port: testPort });

    expect(dashboard.server.listening).toBe(true);
    await dashboard.stop();
    expect(dashboard.server.listening).toBe(false);
    dashboard = null; // Prevent double-close in afterEach
  });

  it('reports the correct port', async () => {
    const daemon = makeMockDaemon();
    dashboard = await startDashboard(daemon, { port: testPort });

    expect(dashboard.port).toBe(testPort);
  });

  it('all API responses include Content-Type header', async () => {
    const daemon = makeMockDaemon();
    dashboard = await startDashboard(daemon, { port: testPort });

    const endpoints = ['/api/status', '/api/schedules', '/api/spells', '/api/memory/stats'];
    for (const ep of endpoints) {
      const res = await fetchDashboard(testPort, ep);
      expect(res.headers['content-type']).toContain('application/json');
    }
  });

  it('DEFAULT_DASHBOARD_PORT is 3117', () => {
    expect(DEFAULT_DASHBOARD_PORT).toBe(3117);
  });

  // ── Story #447: live scheduler panel ─────────────────────────────────

  it('returns disabledInConfig state when schedulerEnabledInConfig: false', async () => {
    const daemon = makeMockDaemon();
    dashboard = await startDashboard(daemon, { port: testPort, schedulerEnabledInConfig: false });
    const res = await fetchDashboard(testPort, '/api/schedules');
    const data = JSON.parse(res.body);
    expect(data.disabledInConfig).toBe(true);
    expect(data.available).toBe(false);
    expect(data.schedulerAttached).toBe(false);
    expect(data.schedules).toEqual([]);
  });

  it('returns live scheduler data when scheduler is attached', async () => {
    const now = Date.now();
    const { scheduler } = makeMockScheduler({
      schedules: [{
        id: 'sched-1', spellName: 'security-audit', cron: '0 */6 * * *',
        nextRunAt: now + 3_600_000, enabled: true, source: 'definition', createdAt: now,
      }],
      history: {
        'sched-1': [{
          id: 'exec-1', scheduleId: 'sched-1', spellName: 'security-audit',
          startedAt: now - 1000, success: true, duration: 500, manualRun: false,
        }],
      },
    });
    const daemon = makeMockDaemon({}, scheduler);
    dashboard = await startDashboard(daemon, { port: testPort, schedulerEnabledInConfig: true });

    const res = await fetchDashboard(testPort, '/api/schedules');
    const data = JSON.parse(res.body);
    expect(data.schedulerAttached).toBe(true);
    expect(data.available).toBe(true);
    expect(data.disabledInConfig).toBe(false);
    expect(data.schedules).toHaveLength(1);
    expect(data.schedules[0].spellName).toBe('security-audit');
    expect(data.history).toHaveLength(1);
    expect(data.history[0].success).toBe(true);
  });

  it('POST /api/schedules/:id/disable flips enabled=false', async () => {
    const { scheduler, schedules } = makeMockScheduler({
      schedules: [{ id: 'sched-1', spellName: 'w', enabled: true, nextRunAt: Date.now() + 1000, source: 'adhoc', createdAt: Date.now() }],
    });
    const daemon = makeMockDaemon({}, scheduler);
    dashboard = await startDashboard(daemon, { port: testPort, schedulerEnabledInConfig: true });

    const res = await fetchMethod(testPort, '/api/schedules/sched-1/disable', 'POST');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.enabled).toBe(false);
    expect(schedules.get('sched-1')!.enabled).toBe(false);
    expect(scheduler.cancelSchedule).toHaveBeenCalledWith('sched-1');
  });

  it('POST /api/schedules/:id/enable flips enabled=true and returns nextRunAt', async () => {
    const { scheduler } = makeMockScheduler({
      schedules: [{ id: 'sched-2', spellName: 'w', enabled: false, nextRunAt: 0, source: 'adhoc', createdAt: Date.now() }],
    });
    const daemon = makeMockDaemon({}, scheduler);
    dashboard = await startDashboard(daemon, { port: testPort, schedulerEnabledInConfig: true });

    const res = await fetchMethod(testPort, '/api/schedules/sched-2/enable', 'POST');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.enabled).toBe(true);
    expect(data.nextRunAt).toBeGreaterThan(Date.now());
  });

  it('POST /api/schedules/:id/run accepts 202 and triggers runScheduleNow', async () => {
    const { scheduler } = makeMockScheduler({
      schedules: [{ id: 'sched-3', spellName: 'w', enabled: true, nextRunAt: Date.now() + 3_600_000, source: 'adhoc', createdAt: Date.now() }],
    });
    const daemon = makeMockDaemon({}, scheduler);
    dashboard = await startDashboard(daemon, { port: testPort, schedulerEnabledInConfig: true });

    const res = await fetchMethod(testPort, '/api/schedules/sched-3/run', 'POST');
    expect(res.status).toBe(202);
    const data = JSON.parse(res.body);
    expect(data.accepted).toBe(true);
    // Wait for the fire-and-forget promise to resolve
    await new Promise(r => setTimeout(r, 20));
    expect(scheduler.runScheduleNow).toHaveBeenCalledWith('sched-3');
  });

  it('POST schedule action returns 503 when scheduler is not attached', async () => {
    const daemon = makeMockDaemon({}, /*scheduler*/ null);
    dashboard = await startDashboard(daemon, { port: testPort, schedulerEnabledInConfig: true });

    const res = await fetchMethod(testPort, '/api/schedules/sched-x/disable', 'POST');
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error).toMatch(/not attached/i);
  });

  it('POST schedule action returns 404 when schedule is unknown', async () => {
    const { scheduler } = makeMockScheduler({ schedules: [] });
    const daemon = makeMockDaemon({}, scheduler);
    dashboard = await startDashboard(daemon, { port: testPort, schedulerEnabledInConfig: true });

    const res = await fetchMethod(testPort, '/api/schedules/missing/disable', 'POST');
    expect(res.status).toBe(404);
  });

  it('POST to unknown schedule action URL returns 405', async () => {
    const { scheduler } = makeMockScheduler({ schedules: [] });
    const daemon = makeMockDaemon({}, scheduler);
    dashboard = await startDashboard(daemon, { port: testPort, schedulerEnabledInConfig: true });

    const res = await fetchMethod(testPort, '/api/schedules/x/unknown', 'POST');
    expect(res.status).toBe(405);
  });

  it('HTML no longer contains the "Scheduler not connected" placeholder literal', async () => {
    const daemon = makeMockDaemon();
    dashboard = await startDashboard(daemon, { port: testPort });
    const res = await fetchDashboard(testPort, '/');
    expect(res.body).not.toContain('Scheduler not connected');
    expect(res.body).toContain('Scheduler disabled in moflo.yaml');
  });

  it('returns context metadata in spell executions', async () => {
    const daemon = makeMockDaemon();
    const context = { type: 'ticket', label: '#350 \u2014 Replace zod with valibot', issueNumber: 350, issueTitle: 'Replace zod with valibot', execMode: 'normal' };
    const memory = makeMockMemory({
      'tasklist': [{
        key: 'flo-run-1',
        value: JSON.stringify({ spellName: '#350 \u2014 Replace zod with valibot', startedAt: 1711875600000, success: true, duration: 120000, context }),
        score: 1,
      }],
    });
    dashboard = await startDashboard(daemon, { port: testPort, memory });

    const res = await fetchDashboard(testPort, '/api/spells');
    const data = JSON.parse(res.body);
    expect(data.executions).toHaveLength(1);
    expect(data.executions[0].context).toEqual(context);
    expect(data.executions[0].context.type).toBe('ticket');
    expect(data.executions[0].context.label).toContain('#350');
  });
});

// ============================================================================
// buildFloRunContext
// ============================================================================

describe('buildFloRunContext', () => {
  it('builds ticket context from issue number and title', () => {
    const ctx = buildFloRunContext({ issueNumber: 350, issueTitle: 'Replace zod with valibot' });
    expect(ctx.type).toBe('ticket');
    expect(ctx.label).toBe('#350 \u2014 Replace zod with valibot');
    expect(ctx.issueNumber).toBe(350);
    expect(ctx.execMode).toBe('normal');
  });

  it('builds epic context with progress', () => {
    const ctx = buildFloRunContext({
      issueNumber: 287, issueTitle: 'Consolidated PR', isEpic: true, epicProgress: [3, 5],
    });
    expect(ctx.type).toBe('epic');
    expect(ctx.label).toContain('Epic #287');
    expect(ctx.label).toContain('3/5 stories');
    expect(ctx.epicProgress).toEqual([3, 5]);
  });

  it('builds spell context with name and args', () => {
    const ctx = buildFloRunContext({ spellName: 'security-audit', spellArgs: ['./src'] });
    expect(ctx.type).toBe('spell');
    expect(ctx.label).toContain('security-audit');
    expect(ctx.label).toContain('./src');
  });

  it('builds research context', () => {
    const ctx = buildFloRunContext({ issueNumber: 350, issueTitle: 'Some issue', isResearch: true });
    expect(ctx.type).toBe('research');
    expect(ctx.label).toBe('#350 \u2014 Research');
  });

  it('builds new-ticket context', () => {
    const ctx = buildFloRunContext({ isNewTicket: true, ticketTitle: 'Add OAuth2 support' });
    expect(ctx.type).toBe('new-ticket');
    expect(ctx.label).toBe('New: Add OAuth2 support');
  });

  it('includes swarm exec mode', () => {
    const ctx = buildFloRunContext({ issueNumber: 123, issueTitle: 'Fix bug', execMode: 'swarm' });
    expect(ctx.execMode).toBe('swarm');
  });

  it('returns fallback when no identifiers given', () => {
    const ctx = buildFloRunContext({});
    expect(ctx.type).toBe('ticket');
    expect(ctx.label).toBe('Flo Run');
  });
});

// ============================================================================
// storeFloRunRecord
// ============================================================================

describe('storeFloRunRecord', () => {
  it('stores a running record with context', async () => {
    const memory = makeMockMemory();
    const ctx = buildFloRunContext({ issueNumber: 350, issueTitle: 'Test issue' });
    await storeFloRunRecord(memory, 'flo-123', ctx, 'running', { startedAt: 1000 });
    expect(memory.write).toHaveBeenCalledWith('tasklist', 'flo-123', expect.objectContaining({
      status: 'running',
      context: ctx,
      startedAt: 1000,
    }));
  });

  it('stores completed record with success=true', async () => {
    const memory = makeMockMemory();
    const ctx = buildFloRunContext({ issueNumber: 1, issueTitle: 'Done' });
    await storeFloRunRecord(memory, 'flo-456', ctx, 'completed', { startedAt: 1000, duration: 5000 });
    expect(memory.write).toHaveBeenCalledWith('tasklist', 'flo-456', expect.objectContaining({
      status: 'completed',
      success: true,
      duration: 5000,
    }));
  });

  it('stores failed record with error message', async () => {
    const memory = makeMockMemory();
    const ctx = buildFloRunContext({ issueNumber: 1, issueTitle: 'Broken' });
    await storeFloRunRecord(memory, 'flo-789', ctx, 'failed', { error: 'Tests failed' });
    expect(memory.write).toHaveBeenCalledWith('tasklist', 'flo-789', expect.objectContaining({
      status: 'failed',
      success: false,
      error: 'Tests failed',
    }));
  });

  it('does not throw when memory.write fails', async () => {
    const memory = makeMockMemory();
    memory.write.mockRejectedValue(new Error('DB down'));
    const ctx = buildFloRunContext({ issueNumber: 1, issueTitle: 'Test' });
    await expect(storeFloRunRecord(memory, 'flo-err', ctx, 'running')).resolves.toBeUndefined();
  });
});
