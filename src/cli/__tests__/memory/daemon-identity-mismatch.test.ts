/**
 * Client-side identity check tests for #1145.
 *
 * Spins up a fake daemon HTTP server that reports a `projectRoot` in its
 * `/api/health` response, and verifies that:
 *   - When `projectRoot` matches the client's `findProjectRoot()`, the
 *     client routes through it (returns `routed: true`).
 *   - When it mismatches, the client refuses (`routed: false`), emits a
 *     single stderr line per mismatched port, and downstream callers fall
 *     through to direct-SQL.
 *   - Legacy daemons that 404 on `/api/health` still get routed to (the
 *     port-discovery + lock-file primary defence is sufficient).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  _resetForTest,
  tryDaemonList,
  isDaemonAvailable,
} from '../../memory/daemon-write-client.js';

interface FakeDaemon {
  port: number;
  stop: () => Promise<void>;
}

async function spawnFakeDaemon(opts: {
  projectRoot?: string;
  healthStatus?: number; // 200 (with body) / 404 (legacy)
  port: number;
}): Promise<FakeDaemon> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/api/health') {
      if (opts.healthStatus === 404) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        projectRoot: opts.projectRoot ?? '/some/foreign/project',
        pid: 12345,
        version: '4.10.7',
        uptimeMs: 1000,
      }));
      return;
    }
    if (url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ running: true }));
      return;
    }
    if (req.method === 'POST' && url === '/api/memory/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entries: [], total: 42 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolve());
  });

  return {
    port: opts.port,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const PRIOR_ENV = process.env.MOFLO_DAEMON_PORT;
const PRIOR_PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR;
const PRIOR_IS_DAEMON = process.env.MOFLO_IS_DAEMON;

let cleanup: Array<() => Promise<void>> = [];
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetForTest();
  cleanup = [];
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as any);
  // Make sure we're not "in" the daemon — otherwise isDaemonAvailable returns false.
  delete process.env.MOFLO_IS_DAEMON;
});

afterEach(async () => {
  for (const c of cleanup) await c();
  stderrSpy.mockRestore();
  _resetForTest();
  if (PRIOR_ENV != null) process.env.MOFLO_DAEMON_PORT = PRIOR_ENV;
  else delete process.env.MOFLO_DAEMON_PORT;
  if (PRIOR_PROJECT_DIR != null) process.env.CLAUDE_PROJECT_DIR = PRIOR_PROJECT_DIR;
  else delete process.env.CLAUDE_PROJECT_DIR;
  if (PRIOR_IS_DAEMON != null) process.env.MOFLO_IS_DAEMON = PRIOR_IS_DAEMON;
});

function makeProjectRoot(): string {
  const root = join(tmpdir(), `identity-mismatch-${randomUUID()}`);
  mkdirSync(join(root, '.moflo'), { recursive: true });
  // CLAUDE.md + package.json so findProjectRoot anchors here.
  writeFileSync(join(root, 'CLAUDE.md'), '# test\n');
  writeFileSync(join(root, 'package.json'), '{"name":"test"}');
  return root;
}

function setProjectRoot(root: string): void {
  // findProjectRoot honors CLAUDE_PROJECT_DIR as the high-priority anchor.
  process.env.CLAUDE_PROJECT_DIR = root;
}

describe('isDaemonAvailable with identity check (#1145)', () => {
  it('returns true when daemon reports matching projectRoot', async () => {
    const root = makeProjectRoot();
    setProjectRoot(root);
    const port = 40000 + Math.floor(Math.random() * 1000);
    process.env.MOFLO_DAEMON_PORT = String(port);

    const daemon = await spawnFakeDaemon({ port, projectRoot: root });
    cleanup.push(daemon.stop);

    expect(await isDaemonAvailable()).toBe(true);
  });

  it('returns false on projectRoot mismatch + emits stderr warn for the mismatched port', async () => {
    const root = makeProjectRoot();
    setProjectRoot(root);
    const port = 41000 + Math.floor(Math.random() * 1000);
    process.env.MOFLO_DAEMON_PORT = String(port);

    const daemon = await spawnFakeDaemon({
      port,
      projectRoot: '/some/foreign/project',
    });
    cleanup.push(daemon.stop);

    expect(await isDaemonAvailable()).toBe(false);

    const writes = stderrSpy.mock.calls.flatMap((c) => [c[0] as string]);
    // Filter to warns for OUR port so a parallel test pointing at a
    // different fake daemon can't leak in.
    const portWarns = writes.filter(
      (s) => typeof s === 'string' && new RegExp(`daemon at 127\\.0\\.0\\.1:${port}\\b`).test(s),
    );
    expect(portWarns.length).toBe(1);
    expect(portWarns[0]).toMatch(/claims project '\/some\/foreign\/project'/);

    // Reset health cache and probe again — _resetForTest clears the
    // module-level "warned ports" set as part of the test seam, so the
    // warn fires once more. (Production bound is one-per-port-per-process.)
    _resetForTest();
    stderrSpy.mockClear();
    expect(await isDaemonAvailable()).toBe(false);
    const writes2 = stderrSpy.mock.calls.flatMap((c) => [c[0] as string]);
    const portWarns2 = writes2.filter(
      (s) => typeof s === 'string' && new RegExp(`daemon at 127\\.0\\.0\\.1:${port}\\b`).test(s),
    );
    expect(portWarns2.length).toBe(1);
  });

  it('treats 404 on /api/health as a legacy daemon (routes)', async () => {
    const root = makeProjectRoot();
    setProjectRoot(root);
    const port = 42000 + Math.floor(Math.random() * 1000);
    process.env.MOFLO_DAEMON_PORT = String(port);

    const daemon = await spawnFakeDaemon({
      port,
      healthStatus: 404,
    });
    cleanup.push(daemon.stop);

    // Legacy daemon — port-discovery is the primary defence; identity
    // check abstains and lets the routing through. This avoids breaking
    // every consumer's first request after upgrading the client but
    // before the daemon restarts.
    expect(await isDaemonAvailable()).toBe(true);
  });

  it('tryDaemonList routes through identity-matched daemon', async () => {
    const root = makeProjectRoot();
    setProjectRoot(root);
    const port = 43000 + Math.floor(Math.random() * 1000);
    process.env.MOFLO_DAEMON_PORT = String(port);

    const daemon = await spawnFakeDaemon({ port, projectRoot: root });
    cleanup.push(daemon.stop);

    const result = await tryDaemonList({ limit: 10 });
    expect(result.routed).toBe(true);
    expect(result.data?.total).toBe(42);
  });

  it('tryDaemonList refuses to route through identity-mismatched daemon', async () => {
    const root = makeProjectRoot();
    setProjectRoot(root);
    const port = 44000 + Math.floor(Math.random() * 1000);
    process.env.MOFLO_DAEMON_PORT = String(port);

    const daemon = await spawnFakeDaemon({ port, projectRoot: '/elsewhere' });
    cleanup.push(daemon.stop);

    const result = await tryDaemonList({ limit: 10 });
    expect(result.routed).toBe(false);
  });
});
