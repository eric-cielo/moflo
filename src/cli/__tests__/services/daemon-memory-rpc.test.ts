/**
 * Daemon memory RPC tests (#981 / #983 — single-writer architecture).
 *
 * Exercises the POST /api/memory/{store,delete,batch} endpoints added to the
 * daemon HTTP server. These tests are pure HTTP — no real sql.js — so we
 * mock memory-initializer's storeEntry / deleteEntry and assert the
 * endpoint validates input, surfaces errors, and routes calls correctly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';

// Mock memory-initializer surface used by the RPC handlers
const mockStoreEntry = vi.fn();
const mockDeleteEntry = vi.fn();
const mockGetEntry = vi.fn();
const mockSearchEntries = vi.fn();
const mockListEntries = vi.fn();
vi.mock('../../memory/memory-initializer.js', () => ({
  storeEntry: mockStoreEntry,
  deleteEntry: mockDeleteEntry,
  getEntry: mockGetEntry,
  searchEntries: mockSearchEntries,
  listEntries: mockListEntries,
  // Other surface used by daemon-dashboard.ts itself (handleMemoryStats)
  getNamespaceCounts: vi.fn().mockResolvedValue({ namespaces: {}, total: 0 }),
  initializeMemoryDatabase: vi.fn(),
  checkMemoryInitialization: vi.fn(),
}));

import { startDashboard, type DashboardHandle } from '../../services/daemon-dashboard.js';

// ============================================================================
// Helpers
// ============================================================================

function makeMockDaemon() {
  return {
    getStatus: vi.fn().mockReturnValue({
      running: true,
      pid: 1,
      startedAt: new Date(),
      workers: new Map(),
      config: { maxConcurrent: 1, workerTimeoutMs: 1, resourceThresholds: {}, workers: [] },
    }),
    getScheduler: vi.fn().mockReturnValue(null),
  } as unknown as Parameters<typeof startDashboard>[0];
}

function makeMockMemory() {
  return {
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
  };
}

interface PostResult { status: number; body: string; }
async function postJson(port: number, path: string, body: unknown): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      `http://127.0.0.1:${port}${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', chunk => buf += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, body: buf }));
      },
    );
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

async function getRequest(port: number, path: string): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => resolve({ status: res.statusCode!, body: buf }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('daemon-memory-rpc', () => {
  let dashboard: DashboardHandle | null = null;
  let testPort: number;

  beforeEach(() => {
    testPort = 30000 + Math.floor(Math.random() * 10000);
    mockStoreEntry.mockReset();
    mockDeleteEntry.mockReset();
    mockGetEntry.mockReset();
    mockSearchEntries.mockReset();
    mockListEntries.mockReset();
    // Default success
    mockStoreEntry.mockResolvedValue({ success: true, id: 'entry_test_id' });
    mockDeleteEntry.mockResolvedValue({ success: true, deleted: true, key: '', namespace: '', remainingEntries: 0 });
    mockGetEntry.mockResolvedValue({ success: true, found: false });
    mockSearchEntries.mockResolvedValue({ success: true, results: [], searchTime: 0 });
    mockListEntries.mockResolvedValue({ success: true, entries: [], total: 0 });
  });

  afterEach(async () => {
    if (dashboard) {
      await dashboard.stop();
      dashboard = null;
    }
  });

  // ── store ─────────────────────────────────────────────────────────────

  it('POST /api/memory/store with valid body persists and returns 200', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/store', {
      namespace: 'tasklist',
      key: 'flo-run-981',
      value: { status: 'completed', label: 'test' },
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.stored).toBe(true);
    expect(data.id).toBe('entry_test_id');
    expect(mockStoreEntry).toHaveBeenCalledTimes(1);
    const args = mockStoreEntry.mock.calls[0][0];
    expect(args.namespace).toBe('tasklist');
    expect(args.key).toBe('flo-run-981');
    expect(args.upsert).toBe(true);
    // value is JSON-stringified for the underlying TEXT column
    expect(typeof args.value).toBe('string');
    expect(JSON.parse(args.value).status).toBe('completed');
  });

  it('POST /api/memory/store passes string value through unchanged', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    await postJson(testPort, '/api/memory/store', {
      namespace: 'learnings',
      key: 'k1',
      value: 'plain-string',
    });
    expect(mockStoreEntry.mock.calls[0][0].value).toBe('plain-string');
  });

  it('POST /api/memory/store passes tags + ttl through', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    await postJson(testPort, '/api/memory/store', {
      namespace: 'tasklist',
      key: 'k1',
      value: 'v',
      tags: ['flo', 'epic-981'],
      ttl: 3600,
    });
    const args = mockStoreEntry.mock.calls[0][0];
    expect(args.tags).toEqual(['flo', 'epic-981']);
    expect(args.ttl).toBe(3600);
  });

  // ── metadata (#1064) ──────────────────────────────────────────────────

  it('POST /api/memory/store forwards a plain-object metadata payload to storeEntry (pre-serialised)', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const meta = {
      type: 'chunk',
      parentDoc: 'doc-1064',
      chunkIndex: 1,
      totalChunks: 3,
      prevChunk: 'k0',
      nextChunk: 'k2',
      siblings: ['k0', 'k1', 'k2'],
    };
    const res = await postJson(testPort, '/api/memory/store', {
      namespace: 'rpc-meta', key: 'k1', value: 'v', metadata: meta,
    });
    expect(res.status).toBe(200);
    // validateMetadata pre-serialises so the INSERT site doesn't re-stringify.
    const got = mockStoreEntry.mock.calls[0][0].metadata;
    expect(typeof got).toBe('string');
    expect(JSON.parse(got)).toEqual(meta);
  });

  it('POST /api/memory/store forwards a stringified metadata blob unchanged', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const raw = JSON.stringify({ type: 'chunk', parentDoc: 'd' });
    const res = await postJson(testPort, '/api/memory/store', {
      namespace: 'rpc-meta', key: 'k1', value: 'v', metadata: raw,
    });
    expect(res.status).toBe(200);
    expect(mockStoreEntry.mock.calls[0][0].metadata).toBe(raw);
  });

  it('POST /api/memory/store leaves metadata undefined when omitted', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    await postJson(testPort, '/api/memory/store', { namespace: 'rpc-meta', key: 'k1', value: 'v' });
    expect(mockStoreEntry.mock.calls[0][0].metadata).toBeUndefined();
  });

  it('POST /api/memory/store rejects non-object metadata with 400', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/store', {
      namespace: 'rpc-meta', key: 'k1', value: 'v', metadata: 42,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/metadata must be/i);
    expect(mockStoreEntry).not.toHaveBeenCalled();
  });

  it('POST /api/memory/store rejects an unparseable metadata string with 400', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/store', {
      namespace: 'rpc-meta', key: 'k1', value: 'v', metadata: '{not json',
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/not valid json/i);
  });

  it('POST /api/memory/store rejects oversized metadata with 400', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    // 64 KB cap — pad a string field past it.
    const fat = { type: 'chunk', pad: 'a'.repeat(70 * 1024) };
    const res = await postJson(testPort, '/api/memory/store', {
      namespace: 'rpc-meta', key: 'k1', value: 'v', metadata: fat,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/exceeds/i);
  });

  it('POST /api/memory/store rejects invalid namespace with 400', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/store', {
      namespace: 'bad ns/with spaces',
      key: 'k',
      value: 'v',
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/invalid store/i);
    expect(mockStoreEntry).not.toHaveBeenCalled();
  });

  it('POST /api/memory/store rejects empty key with 400', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/store', { namespace: 'ns', key: '', value: 'v' });
    expect(res.status).toBe(400);
    expect(mockStoreEntry).not.toHaveBeenCalled();
  });

  it('POST /api/memory/store rejects missing value with 400', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/store', { namespace: 'ns', key: 'k' });
    expect(res.status).toBe(400);
    expect(mockStoreEntry).not.toHaveBeenCalled();
  });

  it('POST /api/memory/store rejects invalid ttl with 400', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/store', { namespace: 'ns', key: 'k', value: 'v', ttl: -1 });
    expect(res.status).toBe(400);
  });

  it('POST /api/memory/store rejects non-string-array tags with 400', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/store', {
      namespace: 'ns', key: 'k', value: 'v', tags: ['ok', 42],
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/memory/store rejects malformed JSON with 400', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/store', '{not valid json');
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/invalid|oversized/i);
  });

  it('POST /api/memory/store returns 503 when memory accessor not attached', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort });
    const res = await postJson(testPort, '/api/memory/store', { namespace: 'ns', key: 'k', value: 'v' });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error).toMatch(/not attached/i);
  });

  // #1065 — embedding metadata must round-trip from storeEntry through the
  // HTTP boundary; without it, the MCP memory_store handler reports
  // hasEmbedding:false on every daemon-routed write that actually succeeded
  // and the doctor Memory Access check fails.
  it('POST /api/memory/store includes embedding in response when storeEntry produced one (#1065)', async () => {
    mockStoreEntry.mockResolvedValueOnce({
      success: true,
      id: 'entry_with_emb',
      embedding: { dimensions: 384, model: 'fastembed-bge-small-en-v1.5' },
    });
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/store', { namespace: 'ns', key: 'k', value: 'v' });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.id).toBe('entry_with_emb');
    expect(data.embedding).toEqual({ dimensions: 384, model: 'fastembed-bge-small-en-v1.5' });
  });

  it('POST /api/memory/store omits embedding when storeEntry did not produce one (opt-out path)', async () => {
    mockStoreEntry.mockResolvedValueOnce({ success: true, id: 'entry_no_emb' });
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/store', { namespace: 'ns', key: 'k', value: 'v' });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.embedding).toBeUndefined();
  });

  it('POST /api/memory/store surfaces storeEntry failure as 500', async () => {
    mockStoreEntry.mockResolvedValueOnce({ success: false, id: '', error: 'disk full' });
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/store', { namespace: 'ns', key: 'k', value: 'v' });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).message).toContain('disk full');
  });

  // ── delete ────────────────────────────────────────────────────────────

  it('POST /api/memory/delete with valid body removes and returns 200', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/delete', { namespace: 'tasklist', key: 'flo-run-981' });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.deleted).toBe(true);
    expect(mockDeleteEntry).toHaveBeenCalledWith({ key: 'flo-run-981', namespace: 'tasklist' });
  });

  it('POST /api/memory/delete returns 200 even when key was absent (deleted: false)', async () => {
    mockDeleteEntry.mockResolvedValueOnce({ success: true, deleted: false, key: '', namespace: '', remainingEntries: 0 });
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/delete', { namespace: 'ns', key: 'absent' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(false);
  });

  it('POST /api/memory/delete rejects invalid input with 400', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/delete', { namespace: '', key: 'k' });
    expect(res.status).toBe(400);
    expect(mockDeleteEntry).not.toHaveBeenCalled();
  });

  it('POST /api/memory/delete returns 503 without memory accessor', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort });
    const res = await postJson(testPort, '/api/memory/delete', { namespace: 'ns', key: 'k' });
    expect(res.status).toBe(503);
  });

  // ── batch ─────────────────────────────────────────────────────────────

  it('POST /api/memory/batch applies all ops sequentially and returns 200', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/batch', {
      ops: [
        { op: 'store', namespace: 'ns', key: 'k1', value: 'v1' },
        { op: 'store', namespace: 'ns', key: 'k2', value: 'v2' },
        { op: 'delete', namespace: 'ns', key: 'k0' },
      ],
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.results).toHaveLength(3);
    expect(data.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(mockStoreEntry).toHaveBeenCalledTimes(2);
    expect(mockDeleteEntry).toHaveBeenCalledTimes(1);
  });

  // #1065 — batch endpoint must propagate embedding per-store the same way
  // the single /store endpoint does, so batch callers can report
  // hasEmbedding correctly per result without a separate read round-trip.
  it('POST /api/memory/batch propagates embedding per store result (#1065)', async () => {
    mockStoreEntry
      .mockResolvedValueOnce({ success: true, id: 'b1', embedding: { dimensions: 384, model: 'fastembed-bge-small-en-v1.5' } })
      .mockResolvedValueOnce({ success: true, id: 'b2' }); // opt-out / ephemeral path
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/batch', {
      ops: [
        { op: 'store', namespace: 'ns', key: 'k1', value: 'v1' },
        { op: 'store', namespace: 'ephemeral', key: 'k2', value: 'v2' },
        { op: 'delete', namespace: 'ns', key: 'k0' },
      ],
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.results[0].embedding).toEqual({ dimensions: 384, model: 'fastembed-bge-small-en-v1.5' });
    expect(data.results[1].embedding).toBeUndefined();
    // Delete results never carry embedding.
    expect(data.results[2].embedding).toBeUndefined();
    expect(data.results[2].deleted).toBe(true);
  });

  it('POST /api/memory/batch fails-all on any invalid op (no partial application)', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/batch', {
      ops: [
        { op: 'store', namespace: 'ns', key: 'k1', value: 'v1' },
        { op: 'store', namespace: 'bad ns!', key: 'k2', value: 'v2' },
      ],
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).index).toBe(1);
    expect(mockStoreEntry).not.toHaveBeenCalled();
    expect(mockDeleteEntry).not.toHaveBeenCalled();
  });

  it('POST /api/memory/batch returns 207 with partial results on mid-stream failure', async () => {
    mockStoreEntry
      .mockResolvedValueOnce({ success: true, id: 'a' })
      .mockResolvedValueOnce({ success: false, id: '', error: 'mid-stream fault' });
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/batch', {
      ops: [
        { op: 'store', namespace: 'ns', key: 'k1', value: 'v1' },
        { op: 'store', namespace: 'ns', key: 'k2', value: 'v2' },
      ],
    });
    expect(res.status).toBe(207);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(false);
    expect(data.results[0].ok).toBe(true);
    expect(data.results[1].ok).toBe(false);
    expect(data.results[1].error).toContain('mid-stream fault');
  });

  it('POST /api/memory/batch rejects empty ops array with 400', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/batch', { ops: [] });
    expect(res.status).toBe(400);
  });

  it('POST /api/memory/batch rejects > 100 ops with 400', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const ops = Array.from({ length: 101 }, (_, i) => ({ op: 'store', namespace: 'ns', key: `k${i}`, value: 'v' }));
    const res = await postJson(testPort, '/api/memory/batch', { ops });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/too large/i);
  });

  it('POST /api/memory/batch rejects unknown op type with 400', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/batch', {
      ops: [{ op: 'wat', namespace: 'ns', key: 'k', value: 'v' }],
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/store.*delete/i);
  });

  // ── method check ──────────────────────────────────────────────────────

  it('GET /api/memory/store returns 405', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await getRequest(testPort, '/api/memory/store');
    expect(res.status).toBe(405);
  });

  it('GET /api/memory/delete returns 405', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await getRequest(testPort, '/api/memory/delete');
    expect(res.status).toBe(405);
  });

  // ── concurrent ────────────────────────────────────────────────────────

  it('handles 10 parallel POST /api/memory/store requests', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const reqs = Array.from({ length: 10 }, (_, i) =>
      postJson(testPort, '/api/memory/store', { namespace: 'ns', key: `k${i}`, value: 'v' }),
    );
    const results = await Promise.all(reqs);
    expect(results.every(r => r.status === 200)).toBe(true);
    expect(mockStoreEntry).toHaveBeenCalledTimes(10);
  });

  // ── get (#1058) ────────────────────────────────────────────────────────

  it('POST /api/memory/get returns the daemon-served entry when found', async () => {
    mockGetEntry.mockResolvedValueOnce({
      success: true,
      found: true,
      entry: {
        id: 'entry_abc',
        key: 'k',
        namespace: 'ns',
        content: 'hello',
        accessCount: 3,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02',
        hasEmbedding: true,
        tags: ['t1'],
      },
    });
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/get', { namespace: 'ns', key: 'k' });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.found).toBe(true);
    expect(data.entry.id).toBe('entry_abc');
    expect(data.entry.content).toBe('hello');
    expect(mockGetEntry).toHaveBeenCalledWith({ key: 'k', namespace: 'ns' });
  });

  it('POST /api/memory/get returns ok:true, found:false on miss', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/get', { namespace: 'ns', key: 'absent' });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.found).toBe(false);
    expect(data.entry).toBeUndefined();
  });

  it('POST /api/memory/get rejects invalid namespace with 400', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/get', { namespace: 'bad ns!', key: 'k' });
    expect(res.status).toBe(400);
    expect(mockGetEntry).not.toHaveBeenCalled();
  });

  it('POST /api/memory/get surfaces getEntry failure as 500', async () => {
    mockGetEntry.mockResolvedValueOnce({ success: false, found: false, error: 'db read failed' });
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/get', { namespace: 'ns', key: 'k' });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).message).toContain('db read failed');
  });

  it('POST /api/memory/get returns 503 without memory accessor', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort });
    const res = await postJson(testPort, '/api/memory/get', { namespace: 'ns', key: 'k' });
    expect(res.status).toBe(503);
  });

  // ── search (#1058) ─────────────────────────────────────────────────────

  it('POST /api/memory/search returns daemon-served results', async () => {
    mockSearchEntries.mockResolvedValueOnce({
      success: true,
      results: [
        { id: 'a', key: 'k1', content: 'c1', score: 0.9, namespace: 'ns' },
        { id: 'b', key: 'k2', content: 'c2', score: 0.7, namespace: 'ns' },
      ],
      searchTime: 12,
    });
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/search', {
      query: 'hello world',
      namespace: 'ns',
      limit: 5,
      threshold: 0.5,
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.results).toHaveLength(2);
    expect(data.results[0].score).toBe(0.9);
    expect(data.searchTime).toBe(12);
    expect(mockSearchEntries).toHaveBeenCalledWith({
      query: 'hello world', namespace: 'ns', limit: 5, threshold: 0.5,
    });
  });

  it('POST /api/memory/search accepts namespace:"all" (cross-namespace)', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/search', { query: 'q', namespace: 'all' });
    expect(res.status).toBe(200);
    expect(mockSearchEntries.mock.calls[0][0].namespace).toBe('all');
  });

  it('POST /api/memory/search rejects empty query with 400', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/search', { query: '' });
    expect(res.status).toBe(400);
    expect(mockSearchEntries).not.toHaveBeenCalled();
  });

  it('POST /api/memory/search rejects out-of-range threshold with 400', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/search', { query: 'q', threshold: 1.5 });
    expect(res.status).toBe(400);
  });

  it('POST /api/memory/search returns 503 without memory accessor', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort });
    const res = await postJson(testPort, '/api/memory/search', { query: 'q' });
    expect(res.status).toBe(503);
  });

  // ── list (#1058) ───────────────────────────────────────────────────────

  it('POST /api/memory/list returns daemon-served entries', async () => {
    mockListEntries.mockResolvedValueOnce({
      success: true,
      entries: [
        { id: 'a', key: 'k1', namespace: 'ns', size: 10, accessCount: 1, createdAt: '', updatedAt: '', hasEmbedding: false },
      ],
      total: 1,
    });
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/list', { namespace: 'ns', limit: 10, offset: 0 });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.entries).toHaveLength(1);
    expect(data.total).toBe(1);
  });

  it('POST /api/memory/list with empty body lists all (no params)', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/list', undefined);
    expect(res.status).toBe(200);
    expect(mockListEntries).toHaveBeenCalled();
  });

  it('POST /api/memory/list rejects negative offset with 400', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/list', { offset: -1 });
    expect(res.status).toBe(400);
  });

  it('POST /api/memory/list rejects oversized limit with 400', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await postJson(testPort, '/api/memory/list', { limit: 50_000 });
    expect(res.status).toBe(400);
  });

  it('POST /api/memory/list returns 503 without memory accessor', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort });
    const res = await postJson(testPort, '/api/memory/list', {});
    expect(res.status).toBe(503);
  });

  // ── method check for new endpoints ─────────────────────────────────────

  it('GET /api/memory/get returns 405', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await getRequest(testPort, '/api/memory/get');
    expect(res.status).toBe(405);
  });

  it('GET /api/memory/search returns 405', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await getRequest(testPort, '/api/memory/search');
    expect(res.status).toBe(405);
  });

  it('GET /api/memory/list returns 405', async () => {
    dashboard = await startDashboard(makeMockDaemon(), { port: testPort, memory: makeMockMemory() });
    const res = await getRequest(testPort, '/api/memory/list');
    expect(res.status).toBe(405);
  });
});
