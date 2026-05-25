/**
 * Integration test: GET /api/learnings + the Learnings panel wiring (#1203).
 *
 * Boots a real `startDashboard` against a stub WorkerDaemon and mocks
 * `getLearningsOverview` so we exercise the route registration, JSON shape,
 * the truthful-count passthrough, the 500-on-error contract, and the panel
 * HTML/tab wiring — the bits a future refactor breaks silently.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';

const mockGetLearningsOverview = vi.fn();
vi.mock('../../memory/learnings-overview.js', () => ({
  getLearningsOverview: mockGetLearningsOverview,
  LEGACY_PROVENANCE: 'unknown',
}));

import {
  startDashboard,
  type DashboardHandle,
} from '../../services/daemon-dashboard.js';

let handle: DashboardHandle | null = null;

const stubDaemon = {
  getStatus: () => ({
    running: true,
    pid: process.pid,
    startedAt: new Date(),
    config: { maxConcurrent: 1, workerTimeoutMs: 1000, resourceThresholds: {}, workers: [] },
    workers: new Map(),
  }),
  getScheduler: () => null,
} as unknown as Parameters<typeof startDashboard>[0];

function pickPort(): number {
  return 31_000 + Math.floor(Math.random() * 9_000);
}

function get(port: number, path: string): Promise<{ status: number; body: unknown; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let body: unknown = raw;
        try { body = JSON.parse(raw); } catch { /* HTML route */ }
        resolve({ status: res.statusCode ?? 0, body, raw });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const sampleOverview = {
  total: 3,
  recent: [
    { key: 'a', firstLine: 'Alpha', body: 'Alpha body', truncated: false, source: 'auto-meditate', createdAt: 1000, updatedAt: 2000 },
    { key: 'b', firstLine: 'Bravo', body: 'Bravo body', truncated: false, source: 'meditate-manual', createdAt: 900, updatedAt: 1900 },
    { key: 'c', firstLine: 'Charlie', body: 'Charlie body', truncated: false, source: null, createdAt: 800, updatedAt: 1800 },
  ],
  provenance: { 'auto-meditate': 1, 'meditate-manual': 1, 'unknown': 1 },
  growth: [{ date: '2026-05-01', count: 2 }, { date: '2026-05-02', count: 1 }],
  addedLast7d: 1,
  addedLast30d: 3,
};

beforeEach(() => {
  mockGetLearningsOverview.mockReset();
});

afterEach(async () => {
  if (handle) {
    await handle.stop();
    handle = null;
  }
});

describe('GET /api/learnings', () => {
  it('returns the overview shape with ok + available flags', async () => {
    mockGetLearningsOverview.mockResolvedValue(sampleOverview);
    handle = await startDashboard(stubDaemon, { port: pickPort() });

    const { status, body } = await get(handle.port, '/api/learnings');
    expect(status).toBe(200);
    const b = body as Record<string, any>;
    expect(b.ok).toBe(true);
    expect(b.available).toBe(true);
    expect(b.total).toBe(3);
    expect(b.recent).toHaveLength(3);
    expect(b.recent[0].source).toBe('auto-meditate');
    expect(b.provenance).toEqual({ 'auto-meditate': 1, 'meditate-manual': 1, 'unknown': 1 });
    expect(b.growth).toHaveLength(2);
    expect(b.addedLast30d).toBe(3);
  });

  it('reports total truthfully even when the recent list is capped (#1149)', async () => {
    mockGetLearningsOverview.mockResolvedValue({
      ...sampleOverview,
      total: 25,
      recent: sampleOverview.recent, // capped server-side; total stays authoritative
    });
    handle = await startDashboard(stubDaemon, { port: pickPort() });

    const { body } = await get(handle.port, '/api/learnings');
    const b = body as Record<string, any>;
    expect(b.total).toBe(25);
    expect(b.recent.length).toBe(3);
  });

  it('marks available=false on an empty namespace', async () => {
    mockGetLearningsOverview.mockResolvedValue({
      total: 0, recent: [], provenance: {}, growth: [], addedLast7d: 0, addedLast30d: 0,
    });
    handle = await startDashboard(stubDaemon, { port: pickPort() });

    const { body } = await get(handle.port, '/api/learnings');
    expect((body as Record<string, any>).available).toBe(false);
  });

  it('returns 500 when the overview query throws (no fake-empty panel)', async () => {
    mockGetLearningsOverview.mockRejectedValue(new Error('disk read failed'));
    handle = await startDashboard(stubDaemon, { port: pickPort() });

    const { status, body } = await get(handle.port, '/api/learnings');
    expect(status).toBe(500);
    expect((body as Record<string, any>).message).toContain('disk read failed');
  });

  it('serves the Learnings panel container, tab, and renderer in the HTML', async () => {
    handle = await startDashboard(stubDaemon, { port: pickPort() });
    const { raw } = await get(handle.port, '/');
    expect(raw).toContain('id="panel-learnings"');
    expect(raw).toContain("'Learnings'");
    expect(raw).toContain('function renderLearnings');
    expect(raw).toContain("'/api/learnings'");
  });
});
