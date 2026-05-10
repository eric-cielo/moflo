/**
 * Integration test: GET /api/claude-stats end-to-end (#1044).
 *
 * Boots a real `startDashboard` against a stub `WorkerDaemon`, writes a
 * tiny on-disk JSONL fixture, then issues a real HTTP GET. Validates the
 * shape — wires the consumer (poll loop) would consume.
 *
 * Why not unit-test `handleClaudeStats` directly? The route registration in
 * `handleRequest` is exactly the kind of thing that breaks silently if a
 * future refactor moves the endpoint string or the `if/else` chain.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import {
  startDashboard,
  type DashboardHandle,
} from '../../services/daemon-dashboard.js';
import { _resetClaudeStatsCache } from '../../services/claude-stats.js';
import { encodeCwdForClaudeProjects } from '../../shared/utils/claude-projects-path.js';

let tmpRoot: string;
let savedHome: string | undefined;
let savedHomedrive: string | undefined;
let savedHomepath: string | undefined;
let savedUserprofile: string | undefined;
let savedCwd: string;
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

beforeEach(() => {
  _resetClaudeStatsCache();
  tmpRoot = mkdtempSync(join(tmpdir(), 'moflo-cs-route-'));
  savedHome = process.env.HOME;
  savedHomedrive = process.env.HOMEDRIVE;
  savedHomepath = process.env.HOMEPATH;
  savedUserprofile = process.env.USERPROFILE;
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  savedCwd = process.cwd();
});

afterEach(async () => {
  if (handle) {
    await handle.stop();
    handle = null;
  }
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedHomedrive === undefined) delete process.env.HOMEDRIVE; else process.env.HOMEDRIVE = savedHomedrive;
  if (savedHomepath === undefined) delete process.env.HOMEPATH; else process.env.HOMEPATH = savedHomepath;
  if (savedUserprofile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserprofile;
  rmSync(tmpRoot, { recursive: true, force: true });
});

// Avoid the well-known dashboard port range so a daemon already running
// on the dev machine doesn't clash with the test. startDashboard tries
// port+1..port+9 on EADDRINUSE so a random base above 30000 is plenty.
function pickPort(): number {
  return 30_000 + Math.floor(Math.random() * 30_000);
}

function getJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /api/claude-stats', () => {
  it('returns the empty-shape body when no transcripts exist for this CWD', async () => {
    // homedir() is now tmpRoot but no .claude/projects/<cwd>/ dir exists.
    handle = await startDashboard(stubDaemon, { port: pickPort() });
    const { status, body } = await getJson(handle.port, '/api/claude-stats');
    expect(status).toBe(200);
    const shape = body as { available: boolean; totalSessions: number };
    expect(shape.available).toBe(false);
    expect(shape.totalSessions).toBe(0);
  });

  it('returns aggregated stats when transcripts exist for the CWD', async () => {
    const cwd = process.cwd();
    const encoded = encodeCwdForClaudeProjects(cwd);
    const projDir = join(tmpRoot, '.claude', 'projects', encoded);
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'session.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        sessionId: 'route-test',
        message: { role: 'assistant', model: 'claude-opus-4-7', content: [], usage: { input_tokens: 10, output_tokens: 5 } },
      }),
    );

    handle = await startDashboard(stubDaemon, { port: pickPort() });
    const { status, body } = await getJson(handle.port, '/api/claude-stats');
    expect(status).toBe(200);
    const shape = body as {
      available: boolean;
      totalSessions: number;
      windows: { lifetime: { tokens: { input: number; output: number } } };
    };
    expect(shape.available).toBe(true);
    expect(shape.totalSessions).toBe(1);
    expect(shape.windows.lifetime.tokens.input).toBe(10);
    expect(shape.windows.lifetime.tokens.output).toBe(5);
  });
});
