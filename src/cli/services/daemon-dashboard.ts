/**
 * The Luminarium — Lightweight localhost HTTP server
 *
 * Serves the moflo Luminarium (read-only daemon view) for status,
 * scheduled spells, executions, and memory stats. Binds to 127.0.0.1
 * only (no auth needed).
 *
 * Internal/code identifiers retain the term "dashboard" (CLI flags
 * `--dashboard-port` / `--no-dashboard`, internal port constant) for
 * stability with existing consumer scripts; only user-facing surface
 * is rebranded.
 *
 * @module daemon-dashboard
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { WorkerDaemon } from './worker-daemon.js';
import type { MemoryAccessor } from '../spells/types/step-command.types.js';
import type { FloRunContext } from '../spells/types/runner.types.js';
import type { SchedulerErrorCode } from '../spells/scheduler/scheduler.js';
import { errorDetail } from '../shared/utils/error-detail.js';
import {
  handleMemoryStore,
  handleMemoryDelete,
  handleMemoryBatch,
  handleMemoryGet,
  handleMemorySearch,
  handleMemoryList,
  matchMemoryRpcRoute,
} from './daemon-memory-rpc.js';
import { aggregateClaudeStats, emptyClaudeStatsShape } from './claude-stats.js';
import { serverPortCandidates, LEGACY_DEFAULT_PORT } from './daemon-port.js';
import { writeLockPort } from './daemon-lock.js';
import { findProjectRoot } from './project-root.js';
import { readOwnMofloVersion } from './daemon-lock.js';

// ============================================================================
// Types
// ============================================================================

export interface DashboardOptions {
  /**
   * Port to listen on. Treated as the first candidate; the server falls
   * through to the project-deterministic range from `serverPortCandidates`
   * on `EADDRINUSE`. When omitted, the resolver picks the deterministic
   * port directly (#1145).
   */
  port?: number;
  /** Optional MemoryAccessor for namespace stats. */
  memory?: MemoryAccessor;
  /**
   * Whether `scheduler.enabled` is true in moflo.yaml. When false the
   * dashboard surfaces a distinct "disabled in moflo.yaml" state rather
   * than the generic "not connected" placeholder.
   */
  schedulerEnabledInConfig?: boolean;
  /**
   * Absolute project root the daemon is serving. Stamped into
   * `/api/health` so clients can verify they're hitting their own
   * project's daemon (#1145). Defaults to `findProjectRoot()`.
   */
  projectRoot?: string;
}

export interface DashboardHandle {
  /** The underlying HTTP server. */
  server: Server;
  /** The port the server is listening on. */
  port: number;
  /** Stop the dashboard server. */
  stop(): Promise<void>;
}

/**
 * Legacy default port retained as a re-export of {@link LEGACY_DEFAULT_PORT}
 * for backward compat with existing importers (`commands/daemon.ts`,
 * `__tests__/daemon-dashboard.test.ts`). The actual port a daemon binds is
 * now resolved deterministically per project via `serverPortCandidates()` —
 * see `daemon-port.ts` and `docs/internal/1145-daemon-port-collision-analysis.md`.
 */
export const DEFAULT_DASHBOARD_PORT = LEGACY_DEFAULT_PORT;

/**
 * Process-wide promise for the shared MemoryAccessor. Memoized as a *promise*
 * (not the resolved value) so concurrent first-callers share a single init
 * — without this, two near-simultaneous calls would each kick off their own
 * `createDashboardMemoryAccessor()` chain and the loser's accessor would
 * leak. The race fix originated in #1016 inside `mcp-tools/spell-tools.ts`;
 * #1020 lifted it into this shared helper so `epic/runner-adapter.ts` (which
 * had the same latent race) and any future caller benefit from one cold
 * init per process.
 */
let _sharedAccessorPromise: Promise<MemoryAccessor | null> | null = null;

/**
 * Return the process-wide MemoryAccessor, lazy-initialized on first call and
 * cached as a promise thereafter. Returns `null` (with a warn log) if init
 * fails so callers can degrade gracefully — the spell still runs, the user
 * just doesn't see the run in The Luminarium.
 */
export function getSharedMemoryAccessor(): Promise<MemoryAccessor | null> {
  if (_sharedAccessorPromise) return _sharedAccessorPromise;
  _sharedAccessorPromise = (async () => {
    try {
      return await createDashboardMemoryAccessor();
    } catch (err) {
      console.warn(`[memory] dashboard accessor unavailable: ${(err as Error).message ?? err}`);
      console.warn('[memory] runs will NOT appear in The Luminarium');
      return null;
    }
  })();
  return _sharedAccessorPromise;
}

/**
 * Test-only: reset the cached promise so a subsequent call re-runs init.
 * Production code MUST NOT call this — leaks the previous accessor's DB
 * handle if the prior init succeeded.
 */
export function _resetSharedMemoryAccessorForTest(): void {
  _sharedAccessorPromise = null;
}

/**
 * Create a MemoryAccessor backed by the sql.js/HNSW memory database.
 * Lazy-loads memory-initializer to avoid circular deps.
 */
export async function createDashboardMemoryAccessor(): Promise<MemoryAccessor> {
  const { searchEntries, getEntry, storeEntry, listEntries } = await import('../memory/memory-initializer.js');
  console.log('[dashboard] Memory accessor initialized successfully');

  return {
    async read(namespace: string, key: string): Promise<unknown | null> {
      try {
        const result = await getEntry({ key, namespace });
        return result?.entry?.content ?? null;
      } catch (err) {
        console.warn(`[dashboard] memory.read(${namespace}, ${key}) failed: ${(err as Error).message ?? err}`);
        return null;
      }
    },
    async write(namespace: string, key: string, value: unknown): Promise<void> {
      const result = await storeEntry({ key, value: typeof value === 'string' ? value : JSON.stringify(value), namespace, upsert: true });
      if (!result.success) {
        // #982 — surface the failure to callers (runner.storeProgress wraps
        // this in a try/catch + console.warn). Pre-#982 we just warned and
        // returned cleanly, which let the spell engine claim success on a
        // run whose progress writes never reached disk.
        const err = `memory.write(${namespace}, ${key}) failed: ${result.error ?? 'unknown'}`;
        throw new Error(err);
      }
    },
    async search(namespace: string, query: string): Promise<Array<{ key: string; value: unknown; score: number }>> {
      try {
        // HNSW semantic search can't handle wildcard '*' — use listEntries
        // to enumerate all entries in the namespace, then fetch each one.
        const listResult = await listEntries({ namespace, limit: 100 });
        if (!listResult.success || listResult.entries.length === 0) {
          // Fall back to semantic search with a meaningful query
          const result = await searchEntries({ query: query === '*' ? 'spell execution status' : query, namespace, limit: 100 });
          if (!result.success) return [];
          return result.results.map(r => ({ key: r.key, value: r.content, score: r.score }));
        }

        // Fetch full content for each listed entry
        const entries: Array<{ key: string; value: unknown; score: number }> = [];
        for (const entry of listResult.entries) {
          try {
            const full = await getEntry({ key: entry.key, namespace });
            if (full?.entry?.content) {
              const parsed = typeof full.entry.content === 'string' ? tryParseSafe(full.entry.content) : full.entry.content;
              entries.push({ key: entry.key, value: parsed, score: 1.0 });
            }
          } catch {
            // Skip entries that fail to load
          }
        }
        return entries;
      } catch (err) {
        console.warn(`[dashboard] memory.search(${namespace}) failed: ${(err as Error).message ?? err}`);
        return [];
      }
    },
  };
}

function tryParseSafe(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * Build the `/api/health` response (#1145).
 *
 * Identity payload — clients compare `projectRoot` against their own
 * `findProjectRoot()` and refuse to route to this daemon on mismatch.
 * Also surfaces `pid`, `version`, and `uptimeMs` for healer-class
 * diagnostics and orphan-daemon detection.
 *
 * Read-only, no-auth, localhost-only (the dashboard binds 127.0.0.1).
 */
function handleHealth(daemon: WorkerDaemon, opts: DashboardOptions): object {
  const status = daemon.getStatus();
  const startedAt = status.startedAt instanceof Date ? status.startedAt : null;
  return {
    status: 'ok',
    projectRoot: opts.projectRoot ?? findProjectRoot(),
    pid: status.pid ?? process.pid,
    version: readOwnMofloVersion() ?? null,
    uptimeMs: startedAt ? Date.now() - startedAt.getTime() : 0,
  };
}

function handleStatus(daemon: WorkerDaemon): object {
  const status = daemon.getStatus();
  // Index config rows by worker type so the row renderer can show a
  // "disabled" badge instead of "Last run: never" for default-off workers
  // (audit, predict, document — see #968 user feedback).
  const configByType = new Map<string, { enabled: boolean }>();
  for (const w of status.config.workers) configByType.set(w.type, { enabled: w.enabled });

  const workers: Record<string, unknown>[] = [];
  for (const [type, state] of status.workers) {
    workers.push({
      type,
      enabled: configByType.get(type)?.enabled ?? true,
      isRunning: state.isRunning,
      lastRun: state.lastRun?.toISOString() ?? null,
      nextRun: state.nextRun?.toISOString() ?? null,
      runCount: state.runCount,
      successCount: state.successCount,
      failureCount: state.failureCount,
      averageDurationMs: state.averageDurationMs,
    });
  }

  const enabledWorkers = status.config.workers.filter(w => w.enabled);

  return {
    running: status.running,
    pid: status.pid,
    startedAt: status.startedAt?.toISOString() ?? null,
    uptime: status.startedAt
      ? Math.floor((Date.now() - status.startedAt.getTime()) / 1000)
      : 0,
    config: {
      maxConcurrent: status.config.maxConcurrent,
      workerTimeoutMs: status.config.workerTimeoutMs,
      resourceThresholds: status.config.resourceThresholds,
      enabledWorkerCount: enabledWorkers.length,
    },
    workers,
  };
}

/**
 * Build the `/api/schedules` response.
 *
 * Three output states are signalled via (disabledInConfig, schedulerAttached):
 *   - disabled in moflo.yaml → disabledInConfig: true
 *   - config on, daemon has a live scheduler → schedulerAttached: true
 *   - config on, no scheduler → fall back to persisted memory records
 */
async function handleSchedules(daemon: WorkerDaemon, opts: DashboardOptions): Promise<object> {
  if (opts.schedulerEnabledInConfig === false) {
    return { schedules: [], history: [], available: false, disabledInConfig: true, schedulerAttached: false };
  }

  const scheduler = daemon.getScheduler();
  if (scheduler) {
    try {
      const [schedules, history] = await Promise.all([
        scheduler.listSchedules(),
        scheduler.getRecentExecutions(50),
      ]);
      return { schedules, history, available: true, disabledInConfig: false, schedulerAttached: true };
    } catch (err) {
      console.warn(`[dashboard] scheduler query failed: ${(err as Error).message ?? err}`);
    }
  }

  const memory = opts.memory;
  if (!memory) {
    return { schedules: [], history: [], available: false, disabledInConfig: false, schedulerAttached: false };
  }
  try {
    const results = await memory.search('scheduled-spells', '*');
    const schedules = results.map(r => {
      const data = typeof r.value === 'string' ? tryParse(r.value) : (r.value as Record<string, unknown> ?? {});
      return { id: r.key, ...(data as Record<string, unknown>) };
    });
    return { schedules, history: [], available: true, disabledInConfig: false, schedulerAttached: false };
  } catch {
    return { schedules: [], history: [], available: true, disabledInConfig: false, schedulerAttached: false };
  }
}

async function handleSpells(memory?: MemoryAccessor): Promise<object> {
  if (!memory) {
    return { executions: [], available: false };
  }
  try {
    // Collect execution records from schedule-executions and tasklist namespaces
    const [schedExecs, taskExecs] = await Promise.all([
      memory.search('schedule-executions', '*').catch(() => []),
      memory.search('tasklist', '*').catch(() => []),
    ]);
    const allExecs: Record<string, unknown>[] = [...schedExecs, ...taskExecs].map(r => {
      const data = typeof r.value === 'string' ? tryParse(r.value) : (r.value as Record<string, unknown> ?? {});
      return { id: r.key, ...(data as Record<string, unknown>) };
    });
    // Sort by most recent first (try startedAt, updatedAt, or key)
    allExecs.sort((a, b) => {
      const ta = Number(a.startedAt ?? a.updatedAt ?? 0);
      const tb = Number(b.startedAt ?? b.updatedAt ?? 0);
      return tb - ta;
    });
    return { executions: allExecs.slice(0, 50), available: true };
  } catch {
    return { executions: [], available: true };
  }
}

function tryParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return { raw: s }; }
}

async function handleMemoryStats(): Promise<object> {
  // Single GROUP BY query — no hardcoded namespace list, no row fetching.
  // Errors propagate to the request handler's outer try/catch → 500, so
  // MCP clients see a real failure instead of a silent `totalEntries: 0`.
  const { getNamespaceCounts } = await import('../memory/memory-initializer.js');
  const { namespaces, total, withEmbeddings } = await getNamespaceCounts();
  return {
    ok: true,
    namespaces,
    totalEntries: total,
    withEmbeddings,
    available: total > 0 || Object.keys(namespaces).length > 0,
  };
}

/**
 * Build the `/api/claude-stats` response (#1044).
 *
 * Reads `~/.claude/projects/<encoded-cwd>/*.jsonl` for the daemon's CWD
 * and returns the aggregated shape consumed by the Claude Stats tab.
 * Failures degrade to an empty shape rather than 500ing — the dashboard
 * is read-only context, never the user's primary workflow.
 */
async function handleClaudeStats(): Promise<object> {
  try {
    return await aggregateClaudeStats(process.cwd());
  } catch (err) {
    console.warn(`[dashboard] claude-stats failed: ${(err as Error).message ?? err}`);
    return emptyClaudeStatsShape();
  }
}

// ============================================================================
// Flo Run Context — build and store human-readable run metadata
// ============================================================================

/**
 * Build a FloRunContext from /flo invocation arguments.
 */
export function buildFloRunContext(opts: {
  issueNumber?: number;
  issueTitle?: string;
  spellName?: string;
  spellArgs?: string[];
  execMode?: 'normal' | 'swarm' | 'hive';
  epicProgress?: readonly [number, number];
  isEpic?: boolean;
  isResearch?: boolean;
  isNewTicket?: boolean;
  ticketTitle?: string;
}): FloRunContext {
  const execMode = opts.execMode ?? 'normal';

  if (opts.spellName) {
    const argStr = opts.spellArgs?.length ? ` ${opts.spellArgs.join(' ')}` : '';
    return {
      type: 'spell',
      label: `${opts.spellName}${argStr ? ' \u2192 ' + argStr.trim() : ''}`,
      spellName: opts.spellName,
      spellArgs: opts.spellArgs,
      execMode,
    };
  }

  if (opts.isNewTicket && opts.ticketTitle) {
    return {
      type: 'new-ticket',
      label: `New: ${opts.ticketTitle}`,
      execMode,
    };
  }

  if (opts.issueNumber) {
    const title = opts.issueTitle ?? '';
    if (opts.isEpic) {
      const [done, total] = opts.epicProgress ?? [0, 0];
      return {
        type: 'epic',
        label: `Epic #${opts.issueNumber} \u2014 ${title} (${done}/${total} stories)`,
        issueNumber: opts.issueNumber,
        issueTitle: title,
        execMode,
        epicProgress: opts.epicProgress,
      };
    }
    if (opts.isResearch) {
      return {
        type: 'research',
        label: `#${opts.issueNumber} \u2014 Research`,
        issueNumber: opts.issueNumber,
        issueTitle: title,
        execMode,
      };
    }
    return {
      type: 'ticket',
      label: `#${opts.issueNumber} \u2014 ${title}`,
      issueNumber: opts.issueNumber,
      issueTitle: title,
      execMode,
    };
  }

  return { type: 'ticket', label: 'Flo Run', execMode };
}

/**
 * Store a flo run record to the tasklist namespace for dashboard display.
 * Used by non-spell-engine /flo invocations (ticket, research, epic).
 */
export async function storeFloRunRecord(
  memory: MemoryAccessor,
  runId: string,
  context: FloRunContext,
  status: 'running' | 'completed' | 'failed',
  extra?: { startedAt?: number; duration?: number; error?: string },
): Promise<void> {
  try {
    const record: Record<string, unknown> = {
      status,
      context,
      spellName: context.label,
      updatedAt: new Date().toISOString(),
    };
    if (extra?.startedAt) record.startedAt = extra.startedAt;
    if (extra?.duration != null) record.duration = extra.duration;
    if (status === 'completed') record.success = true;
    if (status === 'failed') {
      record.success = false;
      if (extra?.error) record.error = extra.error;
    }
    await memory.write('tasklist', runId, record);
  } catch (err) {
    console.warn(`[dashboard] storeFloRunRecord(${runId}) failed: ${(err as Error).message ?? err}`);
  }
}

// ============================================================================
// JSON response helpers
// ============================================================================

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-cache',
  });
  res.end(json);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-cache',
  });
  res.end(html);
}

// ============================================================================
// Router
// ============================================================================

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  daemon: WorkerDaemon,
  opts: DashboardOptions,
): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  try {
    // POST: schedule actions (disable / enable / run) and memory write RPC
    // (#981 single-writer architecture — Story #983). Only 127.0.0.1 traffic
    // reaches here (server.listen bind), so no CSRF layer is needed. Any
    // other POST falls through to the read-only 405 below.
    if (method === 'POST') {
      const action = matchScheduleAction(url);
      if (action) {
        await handleScheduleAction(res, daemon, action.id, action.verb);
        return;
      }
      const memoryRoute = matchMemoryRpcRoute(url);
      if (memoryRoute === 'store') { await handleMemoryStore(req, res, opts.memory); return; }
      if (memoryRoute === 'delete') { await handleMemoryDelete(req, res, opts.memory); return; }
      if (memoryRoute === 'batch') { await handleMemoryBatch(req, res, opts.memory); return; }
      if (memoryRoute === 'get') { await handleMemoryGet(req, res, opts.memory); return; }
      if (memoryRoute === 'search') { await handleMemorySearch(req, res, opts.memory); return; }
      if (memoryRoute === 'list') { await handleMemoryList(req, res, opts.memory); return; }
    }

    if (method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    // Memory RPC endpoints are POST-only; return 405 (not 404) on GET so
    // clients distinguish "wrong method" from "no such endpoint".
    if (matchMemoryRpcRoute(url)) {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (url === '/') {
      sendHtml(res, DASHBOARD_HTML);
    } else if (url === '/api/health') {
      // #1145 — identity probe. Clients use this to confirm they're talking
      // to the daemon for their OWN project before routing memory ops here.
      sendJson(res, 200, handleHealth(daemon, opts));
    } else if (url === '/api/status') {
      sendJson(res, 200, handleStatus(daemon));
    } else if (url === '/api/schedules') {
      sendJson(res, 200, await handleSchedules(daemon, opts));
    } else if (url === '/api/schedules/events') {
      handleSchedulesEventStream(req, res, daemon);
    } else if (url === '/api/spells') {
      sendJson(res, 200, await handleSpells(opts.memory));
    } else if (url === '/api/memory/stats') {
      sendJson(res, 200, await handleMemoryStats());
    } else if (url === '/api/claude-stats') {
      sendJson(res, 200, await handleClaudeStats());
    } else {
      sendJson(res, 404, { error: 'Not found' });
    }
  } catch (err) {
    const message = errorDetail(err);
    sendJson(res, 500, { error: 'Internal server error', message });
  }
}

type ScheduleVerb = 'disable' | 'enable' | 'run';

/** Parse `/api/schedules/:id/:verb`. Returns null if the URL doesn't match. */
function matchScheduleAction(url: string): { id: string; verb: ScheduleVerb } | null {
  const path = url.split('?')[0];
  const m = path.match(/^\/api\/schedules\/([^/]+)\/(disable|enable|run)$/);
  if (!m) return null;
  return { id: decodeURIComponent(m[1]), verb: m[2] as ScheduleVerb };
}

async function handleScheduleAction(
  res: ServerResponse,
  daemon: WorkerDaemon,
  scheduleId: string,
  verb: ScheduleVerb,
): Promise<void> {
  const scheduler = daemon.getScheduler();
  if (!scheduler) {
    sendJson(res, 503, { error: 'Scheduler not attached' });
    return;
  }

  try {
    if (verb === 'disable') {
      const ok = await scheduler.cancelSchedule(scheduleId);
      if (!ok) { sendJson(res, 404, { error: 'Schedule not found' }); return; }
      sendJson(res, 200, { ok: true, id: scheduleId, enabled: false });
      return;
    }

    if (verb === 'enable') {
      const updated = await scheduler.enableSchedule(scheduleId);
      if (!updated) { sendJson(res, 404, { error: 'Schedule not found or expired' }); return; }
      sendJson(res, 200, { ok: true, id: scheduleId, enabled: true, nextRunAt: updated.nextRunAt });
      return;
    }

    // verb === 'run' — execute asynchronously so the response returns fast;
    // the UI polls history for completion.
    scheduler.runScheduleNow(scheduleId).catch(err => {
      console.warn(`[dashboard] runScheduleNow(${scheduleId}) failed: ${errorDetail(err)}`);
    });
    sendJson(res, 202, { ok: true, id: scheduleId, accepted: true });
  } catch (err) {
    const code = getSchedulerErrorCode(err);
    const status = code === 'busy' ? 409 : code ? 404 : 500;
    sendJson(res, status, { error: errorDetail(err) });
  }
}

/** Duck-type check: SpellScheduler throws errors with `name: 'SchedulerError'` and a `code` field. */
function getSchedulerErrorCode(err: unknown): SchedulerErrorCode | null {
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'SchedulerError') {
    const code = (err as { code?: string }).code;
    if (code === 'not-found' || code === 'spell-missing' || code === 'busy') return code;
  }
  return null;
}

/** Heartbeat interval for the schedule-event SSE stream (keeps proxies + idle clients alive). */
const SSE_HEARTBEAT_MS = 25_000;

/**
 * Stream `schedule:*` events to the client via Server-Sent Events.
 *
 * Subscribes to `scheduler.on(listener)` and forwards each event as an SSE
 * frame (`event: <type>\ndata: <JSON>\n\n`). Sends an initial `ready` frame
 * so the client can distinguish "connected, waiting" from "scheduler down",
 * plus a comment heartbeat every 25s. Cleans up on client disconnect.
 *
 * Returns 503 when the scheduler is not attached so the client can fall back
 * to polling. Reuses duck-typing via `daemon.getScheduler()` — no new types
 * exported from this module.
 */
function handleSchedulesEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  daemon: WorkerDaemon,
): void {
  const scheduler = daemon.getScheduler();
  if (!scheduler) {
    sendJson(res, 503, { error: 'Scheduler not attached' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Initial frame so the client knows the channel is live even before
  // the first scheduler event arrives (which may be minutes away).
  res.write(`event: ready\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    unsubscribe();
    try { res.end(); } catch { /* already ended */ }
  };

  const unsubscribe = scheduler.on((event) => {
    try {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      // Half-open socket: the request may never emit 'close'. Defer cleanup
      // to the next microtask so we don't splice the listeners array we are
      // currently being iterated from inside.
      queueMicrotask(cleanup);
    }
  });

  const heartbeat = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch { queueMicrotask(cleanup); }
  }, SSE_HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  req.on('close', cleanup);
  req.on('error', cleanup);
}

// ============================================================================
// Server lifecycle
// ============================================================================

/** Maximum number of ports to try before giving up. */
const MAX_PORT_ATTEMPTS = 10;

/**
 * Start the dashboard HTTP server.
 *
 * Port selection (#1145):
 *   1. `opts.port`, if explicitly set (CLI `--dashboard-port` flag).
 *   2. Otherwise `serverPortCandidates(projectRoot)` — deterministic per-
 *      project port + collision-fallback range.
 * Both honor `MOFLO_DAEMON_PORT` (collapses the candidate list to one).
 *
 * On successful bind the bound port is stamped into `.moflo/daemon.lock`
 * via `writeLockPort()` so clients can discover it without guessing.
 *
 * On bind exhaustion (every candidate in use) the server throws — the
 * caller is expected to surface the failure rather than stay half-alive
 * (the silent-trap pattern that produced #1145).
 *
 * @returns handle whose `.port` field reflects the actually bound port
 */
export async function startDashboard(
  daemon: WorkerDaemon,
  opts: DashboardOptions,
): Promise<DashboardHandle> {
  const projectRoot = opts.projectRoot ?? findProjectRoot();
  const candidates = buildBindCandidates(opts.port, projectRoot, MAX_PORT_ATTEMPTS);

  let lastErr: unknown = null;
  for (let i = 0; i < candidates.length; i++) {
    const port = candidates[i];
    try {
      const handle = await tryListenOnPort(daemon, { ...opts, projectRoot }, port);
      // Stamp the bound port into the lock so clients discover us reliably.
      // Best-effort: a missing/locked-by-another-pid lock means stamping
      // is a no-op — the deterministic fallback still works.
      try { writeLockPort(projectRoot, handle.port); } catch { /* ignore */ }
      return handle;
    } catch (err: unknown) {
      lastErr = err;
      const code = err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : '';
      if (code === 'EADDRINUSE' && i < candidates.length - 1) continue;
      throw err;
    }
  }

  // Bind exhaustion — surface so the daemon can hard-fail (#1145 §9.4).
  throw lastErr ?? new Error(
    `All dashboard ports (${candidates[0]}…${candidates[candidates.length - 1]}) are in use`,
  );
}

/**
 * Build the ordered list of ports to try.
 *
 * When the caller pinned a port (CLI flag), respect it without any
 * fallback — the consumer pinned it on purpose. When they didn't, use
 * the deterministic per-project candidates so two projects never collide
 * silently on a fixed default.
 */
function buildBindCandidates(
  explicitPort: number | undefined,
  projectRoot: string,
  maxAttempts: number,
): number[] {
  if (typeof explicitPort === 'number' && explicitPort > 0 && explicitPort < 65536) {
    return [explicitPort];
  }
  return serverPortCandidates(projectRoot, maxAttempts);
}

/**
 * Attempt to bind the dashboard server to a specific port.
 * Returns a Promise that resolves on successful listen or rejects on error.
 */
function tryListenOnPort(
  daemon: WorkerDaemon,
  opts: DashboardOptions,
  port: number,
): Promise<DashboardHandle> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handleRequest(req, res, daemon, opts).catch(() => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'Internal server error' });
        }
      });
    });

    server.on('error', (err) => {
      reject(err);
    });

    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        port,
        stop(): Promise<void> {
          return new Promise((res, rej) => {
            server.closeAllConnections?.();
            server.close((err) => {
              if (err) rej(err);
              else res();
            });
          });
        },
      });
    });
  });
}

// ============================================================================
// Inlined VanJS Dashboard HTML
// ============================================================================

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>The Luminarium</title>
  <meta name="description" content="The Luminarium — moflo daemon, scheduled spells, and live event stream">
  <meta property="og:title" content="The Luminarium">
  <meta property="og:description" content="The Luminarium — moflo daemon, scheduled spells, and live event stream">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel+Decorative:wght@700;900&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
    /* Wizardy chain — Cinzel Decorative is the Google Font; the rest are
       the most likely system serifs across macOS / Windows / Linux so the
       title still reads "arcane" if the user is offline or behind a font-CDN
       block (Georgia ships everywhere; serif is the universal fallback). */
    h1 { font-family: 'Cinzel Decorative', 'Cinzel', 'Trajan Pro', 'Palatino Linotype', 'Book Antiqua', Georgia, serif; font-weight: 900; letter-spacing: 0.04em; margin-bottom: 4px; font-size: 1.85rem; }
    /* Luminous gradient flowing across the whole title (amber → pale gold → pale
       cyan). background-clip: text paints the gradient through the glyphs;
       color: transparent reveals it. text-shadow doesn't paint on transparent
       text, so the glow uses filter: drop-shadow which respects rendered
       glyph shape. Mid-gradient hue chosen for the glow tint. */
    h1 .luminarium-title {
      background: linear-gradient(90deg, #f59e0b 0%, #fde68a 50%, #67e8f4 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      filter: drop-shadow(0 0 14px rgba(253, 230, 138, 0.22));
    }
    h2 { color: #8b949e; font-size: 1.1rem; margin: 16px 0 12px; border-bottom: 1px solid #21262d; padding-bottom: 6px; }
    .header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 16px; }
    .subtitle { color: #8b949e; font-size: 0.85rem; }
    .status-bar { display: flex; gap: 24px; padding: 12px 16px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; margin-bottom: 16px; flex-wrap: wrap; }
    .status-bar .item { display: flex; flex-direction: column; }
    .status-bar .label { color: #8b949e; font-size: 0.75rem; text-transform: uppercase; }
    .status-bar .value { font-size: 1rem; font-weight: 600; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
    .dot-green { background: #3fb950; }
    .dot-red { background: #f85149; }
    .dot-yellow { background: #d29922; }
    .nav { display: flex; gap: 0; border-bottom: 1px solid #30363d; margin-bottom: 16px; }
    .nav-tab { padding: 8px 16px; font-size: 0.9rem; color: #8b949e; cursor: pointer; border-bottom: 2px solid transparent; transition: color 0.15s, border-color 0.15s; user-select: none; }
    .nav-tab:hover { color: #c9d1d9; }
    .nav-tab.active { color: #58a6ff; border-bottom-color: #58a6ff; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 6px; overflow: hidden; margin-bottom: 16px; }
    th { text-align: left; padding: 8px 12px; background: #21262d; color: #8b949e; font-size: 0.75rem; text-transform: uppercase; font-weight: 600; }
    td { padding: 8px 12px; border-top: 1px solid #21262d; font-size: 0.85rem; }
    tr:hover td { background: #1c2128; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
    .badge-green { background: #238636; color: #fff; }
    .badge-red { background: #da3633; color: #fff; }
    .badge-gray { background: #30363d; color: #8b949e; }
    .badge-yellow { background: #9e6a03; color: #fff; }
    .empty { color: #484f58; font-style: italic; padding: 16px; text-align: center; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; }
    .stat-card .label { color: #8b949e; font-size: 0.75rem; }
    .stat-card .value { font-size: 1.25rem; font-weight: 700; color: #58a6ff; }
    .poll-indicator { position: fixed; top: 8px; right: 12px; font-size: 0.7rem; color: #484f58; }
    .api-links { margin-top: 12px; padding: 12px 16px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; }
    .api-links a { color: #58a6ff; text-decoration: none; font-size: 0.85rem; margin-right: 16px; }
    .api-links a:hover { text-decoration: underline; }
    .wf-group.collapsed .wf-group-body { display: none; }
    .wf-group.collapsed .wf-chevron { transform: rotate(-90deg); }
    .wf-chevron { transition: transform 0.15s; display: inline-block; }
    .btn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 4px; padding: 3px 10px; font-size: 0.75rem; cursor: pointer; font-family: inherit; margin-right: 4px; }
    .btn:hover { background: #30363d; border-color: #484f58; }
    .btn:active { background: #161b22; }
    .btn-sm { padding: 2px 8px; font-size: 0.72rem; }
    .btn-primary { background: #238636; border-color: #2ea043; color: #fff; }
    .btn-primary:hover { background: #2ea043; border-color: #3fb950; }
    .dim { color: #484f58; font-size: 0.75rem; font-style: italic; }
    /* Loading state for tabs whose data is slow on first paint (currently
       Claude Stats, which walks the user's transcript dir — can take 10–15s
       on a long history). Pure-CSS spinner; no image, no framework. */
    .loading-block { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 48px 16px; color: #8b949e; }
    .loading-block .spinner { width: 28px; height: 28px; border: 3px solid #30363d; border-top-color: #58a6ff; border-radius: 50%; animation: lum-spin 0.85s linear infinite; }
    .loading-block .msg { font-size: 0.9rem; color: #c9d1d9; }
    .loading-block .hint { font-size: 0.8rem; color: #8b949e; font-style: italic; max-width: 480px; text-align: center; line-height: 1.5; }
    @keyframes lum-spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="header">
    <h1><span class="luminarium-title">The Luminarium</span></h1>
    <span class="subtitle">moflo daemon &bull; localhost</span>
  </div>
  <div id="status-bar" class="status-bar"><div class="empty">Loading...</div></div>
  <div class="nav" id="nav"></div>
  <div id="panel-workers" class="panel"></div>
  <div id="panel-schedules" class="panel" style="display:none"><div id="schedules-active"></div><div id="schedules-events"></div></div>
  <div id="panel-executions" class="panel" style="display:none"></div>
  <div id="panel-memory" class="panel" style="display:none"></div>
  <div id="panel-claude-stats" class="panel" style="display:none"><div class="loading-block"><div class="spinner"></div><div class="msg">Reading Claude Code transcripts…</div><div class="hint">First load can take 10–15 seconds — moflo walks every session file in this project's transcript directory. Subsequent loads in this tab are much faster.</div></div></div>
  <div id="poll-indicator" class="poll-indicator"></div>
  <script>
    // Tab navigation — plain DOM, no framework
    const tabIds = ['workers', 'schedules', 'executions', 'memory', 'claude-stats'];
    const tabLabels = ['Workers', 'Schedules', 'Flo Runs', 'Memory', 'Claude Stats'];
    let activeTab = 'workers';

    function switchTab(id) {
      const prev = activeTab;
      activeTab = id;
      tabIds.forEach(t => {
        document.getElementById('panel-' + t).style.display = t === id ? '' : 'none';
      });
      document.querySelectorAll('.nav-tab').forEach(el => {
        el.classList.toggle('active', el.dataset.tab === id);
      });
      // Tabs whose data is fetched lazily (currently only Claude Stats)
      // need an immediate poll on entry — otherwise the user waits up to
      // the 5s polling interval for first paint.
      if (id === 'claude-stats' && prev !== id && typeof poll === 'function') {
        poll();
      }
    }

    // Build nav tabs
    const navEl = document.getElementById('nav');
    tabLabels.forEach((label, i) => {
      const tab = document.createElement('div');
      tab.className = 'nav-tab' + (i === 0 ? ' active' : '');
      tab.textContent = label;
      tab.dataset.tab = tabIds[i];
      tab.onclick = () => switchTab(tabIds[i]);
      navEl.appendChild(tab);
    });

    // Helpers
    const fmtDuration = (ms) => {
      if (ms == null) return '-';
      if (ms < 1000) return ms + 'ms';
      if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
      return (ms / 60000).toFixed(1) + 'm';
    };
    const fmtTime = (iso) => {
      if (!iso) return '-';
      return new Date(typeof iso === 'number' ? iso : iso).toLocaleTimeString();
    };
    const fmtTimeAgo = (iso) => {
      if (!iso) return 'never';
      const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      return Math.floor(s / 86400) + 'd ago';
    };
    const fmtUptime = (secs) => {
      if (!secs) return '-';
      const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
      if (h > 0) return h + 'h ' + m + 'm';
      if (m > 0) return m + 'm ' + s + 's';
      return s + 's';
    };
    const pct = (s, f) => { const t = s + f; return t === 0 ? '-' : Math.round((s / t) * 100) + '%'; };
    const badge = (text, cls) => '<span class="badge badge-' + cls + '">' + text + '</span>';
    const esc = (s) => s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');

    // Render functions — write innerHTML for each panel
    function renderStatus(s) {
      if (!s) return;
      const dot = s.running ? 'dot-green' : 'dot-red';
      const label = s.running ? 'Running' : 'Stopped';
      document.getElementById('status-bar').innerHTML =
        '<div class="item"><span class="label">Status</span><span class="value"><span class="dot ' + dot + '"></span>' + label + '</span></div>' +
        '<div class="item"><span class="label">PID</span><span class="value">' + s.pid + '</span></div>' +
        '<div class="item"><span class="label">Uptime</span><span class="value">' + fmtUptime(s.uptime) + '</span></div>' +
        '<div class="item"><span class="label">Workers</span><span class="value">' + s.config.enabledWorkerCount + ' enabled</span></div>' +
        '<div class="item"><span class="label">Max Concurrent</span><span class="value">' + s.config.maxConcurrent + '</span></div>';
    }

    function renderWorkers(s) {
      if (!s) return;
      // Disabled workers show a clear "disabled" badge and dim "—" cells
      // instead of "idle"/"never" — those terms imply the worker is healthy
      // but quiet, which misled users into thinking audit/predict/document
      // were broken (#968).
      const rows = s.workers.map(w => {
        const statusBadge = w.enabled === false
          ? badge('disabled', 'gray')
          : (w.isRunning ? badge('running', 'yellow') : badge('idle', 'gray'));
        const dim = '<span class="dim">—</span>';
        const lastRun = w.enabled === false && !w.lastRun ? dim : fmtTimeAgo(w.lastRun);
        const nextRun = w.enabled === false ? dim : (w.nextRun ? fmtTime(w.nextRun) : '-');
        return '<tr><td>' + esc(w.type) + '</td>' +
          '<td>' + statusBadge + '</td>' +
          '<td>' + w.runCount + '</td>' +
          '<td>' + pct(w.successCount, w.failureCount) + '</td>' +
          '<td>' + fmtDuration(w.averageDurationMs) + '</td>' +
          '<td>' + lastRun + '</td>' +
          '<td>' + nextRun + '</td></tr>';
      }).join('');
      document.getElementById('panel-workers').innerHTML =
        '<h2>Worker Status</h2>' +
        '<table><thead><tr><th>Worker</th><th>Status</th><th>Runs</th><th>Success</th><th>Avg</th><th>Last Run</th><th>Next Run</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
    }

    async function scheduleAction(id, verb) {
      try {
        const r = await fetch('/api/schedules/' + encodeURIComponent(id) + '/' + verb, { method: 'POST' });
        if (!r.ok && r.status !== 202) {
          const body = await r.json().catch(() => ({}));
          console.warn('Schedule ' + verb + ' failed (' + r.status + '):', body.error);
        }
      } catch (e) {
        console.error('Schedule ' + verb + ' request failed:', e);
      }
      poll();
    }
    window.__schedAction = scheduleAction;

    function renderSchedules(sc) {
      const el = document.getElementById('schedules-active');
      if (!sc) { el.innerHTML = '<div class="empty">Loading...</div>'; return; }

      if (sc.disabledInConfig) {
        el.innerHTML = '<h2>Scheduled Spells</h2>' +
          '<div class="empty">Scheduler disabled in moflo.yaml (scheduler.enabled: false)</div>';
        return;
      }
      if (!sc.schedulerAttached && !sc.available) {
        el.innerHTML = '<h2>Scheduled Spells</h2>' +
          '<div class="empty">Scheduler not attached — start the daemon to activate</div>';
        return;
      }
      if (!sc.schedules || sc.schedules.length === 0) {
        el.innerHTML = '<h2>Scheduled Spells</h2>' +
          '<div class="empty">No active schedules &middot; create one with <code>moflo spell schedule create</code></div>';
        if (sc.history && sc.history.length) renderSchedulesHistory(el, sc.history, /*append*/ true);
        return;
      }
      const canControl = !!sc.schedulerAttached;
      const rows = sc.schedules.map(s => {
        const toggle = s.enabled
          ? '<button class="btn btn-sm" onclick="__schedAction(\\'' + esc(s.id) + '\\', \\'disable\\')">Disable</button>'
          : '<button class="btn btn-sm" onclick="__schedAction(\\'' + esc(s.id) + '\\', \\'enable\\')">Enable</button>';
        const run = '<button class="btn btn-sm btn-primary" onclick="__schedAction(\\'' + esc(s.id) + '\\', \\'run\\')">Run now</button>';
        const controls = canControl ? (toggle + ' ' + run) : '<span class="dim">offline</span>';
        return '<tr><td>' + esc(s.spellName) + '</td>' +
          '<td>' + esc(s.cron || s.interval || s.at || '-') + '</td>' +
          '<td>' + (s.enabled ? badge('on','green') : badge('off','gray')) + '</td>' +
          '<td>' + (s.lastRunAt ? fmtTime(s.lastRunAt) : '-') + '</td>' +
          '<td>' + fmtTime(s.nextRunAt) + '</td>' +
          '<td>' + badge(s.source,'gray') + '</td>' +
          '<td>' + controls + '</td></tr>';
      }).join('');
      el.innerHTML = '<h2>Scheduled Spells</h2>' +
        '<table><thead><tr><th>Spell</th><th>Schedule</th><th>Enabled</th><th>Last Run</th><th>Next Run</th><th>Source</th><th>Actions</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';

      if (sc.history && sc.history.length) renderSchedulesHistory(el, sc.history, /*append*/ true);
    }

    // Live events tail (Server-Sent Events from /api/schedules/events).
    // The events div lives outside renderSchedules' write target so polled
    // re-renders of the schedules panel don't touch it; pushSchedEvent is
    // the only writer. Single source of truth for known event types + their
    // badge color — adding a new schedule:* type means one entry here.
    const SCHED_EVENT_BADGES = {
      'schedule:due': 'gray',
      'schedule:started': 'gray',
      'schedule:completed': 'green',
      'schedule:failed': 'red',
      'schedule:skipped': 'yellow',
      'schedule:disabled': 'yellow',
      'schedule:catchup': 'yellow',
    };
    const SCHED_EVENT_TYPES = Object.keys(SCHED_EVENT_BADGES);
    const SCHED_EVENTS_MAX = 50;
    const schedEvents = [];

    function renderEventsTail() {
      const el = document.getElementById('schedules-events');
      if (!el) return;
      if (schedEvents.length === 0) {
        el.innerHTML = '<h2>Live Events</h2><div class="empty">Waiting for scheduler activity…</div>';
        return;
      }
      const rows = schedEvents.map(e => {
        const t = e.type || '?';
        const short = String(t).replace('schedule:', '');
        return '<tr><td>' + new Date(e.timestamp || Date.now()).toLocaleTimeString() + '</td>' +
          '<td>' + badge(short, SCHED_EVENT_BADGES[t] || 'gray') + '</td>' +
          '<td>' + esc(e.spellName || '-') + '</td>' +
          '<td>' + esc(e.message || '') + '</td></tr>';
      }).join('');
      el.innerHTML = '<h2>Live Events</h2>' +
        '<table><thead><tr><th>Time</th><th>Event</th><th>Spell</th><th>Detail</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
    }
    function pushSchedEvent(ev) {
      schedEvents.unshift(ev);
      if (schedEvents.length > SCHED_EVENTS_MAX) schedEvents.length = SCHED_EVENTS_MAX;
      renderEventsTail();
    }
    renderEventsTail(); // Initial empty-state paint.

    // Subscribe via EventSource. Browser handles auto-reconnect with backoff.
    let evtSource = null;
    function connectEventStream() {
      try { if (evtSource) evtSource.close(); } catch (e) { /* ignore */ }
      try {
        evtSource = new EventSource('/api/schedules/events');
        SCHED_EVENT_TYPES.forEach(t => {
          evtSource.addEventListener(t, ev => {
            try { pushSchedEvent(JSON.parse(ev.data)); } catch (e) { /* malformed frame */ }
          });
        });
      } catch (e) {
        console.warn('Event stream unavailable:', e);
      }
    }
    connectEventStream();

    function renderSchedulesHistory(el, history, append) {
      const rows = history.map(h => {
        const statusBadge = h.success === true ? badge('pass','green')
          : h.success === false ? badge('fail','red')
          : badge('running','yellow');
        const manual = h.manualRun ? ' ' + badge('manual','yellow') : '';
        return '<tr><td>' + esc(h.spellName) + manual + '</td>' +
          '<td>' + statusBadge + '</td>' +
          '<td>' + fmtDuration(h.duration) + '</td>' +
          '<td>' + fmtTime(h.startedAt) + '</td>' +
          '<td>' + (h.error ? '<span style="color:#f85149">' + esc(String(h.error).substring(0,120)) + '</span>' : '-') + '</td></tr>';
      }).join('');
      const html = '<h2>Recent Executions</h2>' +
        '<table><thead><tr><th>Spell</th><th>Status</th><th>Duration</th><th>Started</th><th>Error</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
      if (append) el.innerHTML += html; else el.innerHTML = html;
    }

    const modeIcons = { swarm: '\\ud83d\\udc1d', hive: '\\ud83e\\udeb7', normal: '' };
    function fmtContext(ctx) {
      if (!ctx) return null;
      const icon = modeIcons[ctx.execMode] || '';
      const prefix = icon ? icon + ' ' + ctx.execMode.charAt(0).toUpperCase() + ctx.execMode.slice(1) + ' \\u2014 ' : '';
      return prefix + (ctx.label || '');
    }

    function renderExecutions(w) {
      const el = document.getElementById('panel-executions');
      if (!w || !w.available) { el.innerHTML = '<div class="empty">Flo run history unavailable</div>'; return; }
      if (w.executions.length === 0) { el.innerHTML = '<div class="empty">No recent flo runs</div>'; return; }

      let html = '<h2>Recent Flo Runs</h2>';
      w.executions.forEach(e => {
        const ctx = e.context;
        const contextLabel = fmtContext(ctx);
        const name = contextLabel || e.spellName || e.spellName || 'Unknown Spell';
        const runId = e.id || '-';
        const statusBadge = e.success === true ? badge('pass','green') : e.success === false ? badge('fail','red') : badge('running','yellow');
        const progress = e.totalSteps ? (e.completedSteps || 0) + '/' + e.totalSteps + ' steps' : '';
        const steps = Array.isArray(e.steps) ? e.steps : [];
        const typeBadge = ctx ? badge(ctx.type, ctx.type === 'epic' ? 'yellow' : ctx.type === 'spell' ? 'gray' : 'green') : '';

        html += '<div class="wf-group" style="margin-bottom:16px">';
        // Header: context label, type badge, status, timing
        html += '<div class="wf-group-header" style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#161b22;border:1px solid #30363d;border-radius:6px 6px 0 0;cursor:pointer" onclick="this.parentElement.classList.toggle(\\'collapsed\\')">';
        html += typeBadge + ' ';
        html += '<span style="color:#58a6ff;font-weight:600">' + esc(name) + '</span> ';
        html += statusBadge + ' ';
        html += '<span style="color:#8b949e;font-size:0.8rem">' + progress + ' &middot; ' + fmtDuration(e.duration) + ' &middot; ' + fmtTimeAgo(e.startedAt) + '</span>';
        if (e.error) html += '<span style="color:#f85149;font-size:0.75rem;margin-left:8px" title="' + esc(e.error) + '">' + esc(e.error.substring(0, 200)) + '</span>';
        html += '<span style="margin-left:auto;color:#484f58;font-size:0.75rem">' + esc(runId) + '</span>';
        html += '<span style="color:#484f58;font-size:0.75rem;margin-left:8px" class="wf-chevron">&#9660;</span>';
        html += '</div>';

        // Body: step-level detail table
        html += '<div class="wf-group-body">';
        if (steps.length > 0) {
          const stepRows = steps.map((s, idx) => {
            const sBadge = s.status === 'succeeded' ? badge('pass','green')
              : s.status === 'failed' ? badge('fail','red')
              : s.status === 'skipped' ? badge('skip','gray')
              : s.status === 'cancelled' ? badge('cancel','gray')
              : badge(s.status || '?','yellow');
            return '<tr><td style="color:#8b949e">' + (idx + 1) + '</td>' +
              '<td>' + esc(s.stepId) + '</td>' +
              '<td>' + badge(s.stepType || '-','gray') + '</td>' +
              '<td>' + sBadge + '</td>' +
              '<td>' + fmtDuration(s.duration) + '</td>' +
              '<td>' + (s.error ? '<span style="color:#f85149;font-size:0.8rem" title="' + esc(s.error) + '">' + esc(s.error.substring(0, 200)) + '</span>' : '-') + '</td></tr>';
          }).join('');
          html += '<table style="border-radius:0 0 6px 6px;border-top:none"><thead><tr><th>#</th><th>Step</th><th>Type</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead>';
          html += '<tbody>' + stepRows + '</tbody></table>';
        } else {
          html += '<div class="empty" style="border:1px solid #21262d;border-top:none;border-radius:0 0 6px 6px">No step details available for this run</div>';
        }
        html += '</div></div>';
      });

      el.innerHTML = html;
    }

    function renderMemory(m) {
      const el = document.getElementById('panel-memory');
      if (!m || !m.available) { el.innerHTML = '<div class="empty">Memory not connected</div>'; return; }
      const entries = Object.entries(m.namespaces);
      if (entries.length === 0) { el.innerHTML = '<div class="empty">No namespaces</div>'; return; }
      const rows = entries.map(([ns, count]) => '<tr><td>' + esc(ns) + '</td><td>' + count + '</td></tr>').join('');
      el.innerHTML = '<h2>Memory Stats</h2>' +
        '<div class="grid">' +
        '<div class="stat-card"><div class="label">Total Entries</div><div class="value">' + m.totalEntries + '</div></div>' +
        '<div class="stat-card"><div class="label">Namespaces</div><div class="value">' + entries.length + '</div></div>' +
        '</div>' +
        '<table><thead><tr><th>Namespace</th><th>Entries</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    // Format: 1234567 → "1.23M", 5432 → "5.43K"
    const fmtCount = (n) => {
      if (n == null) return '-';
      if (n < 1000) return String(n);
      if (n < 1_000_000) return (n / 1000).toFixed(2) + 'K';
      if (n < 1_000_000_000) return (n / 1_000_000).toFixed(2) + 'M';
      return (n / 1_000_000_000).toFixed(2) + 'B';
    };
    function renderClaudeStats(cs) {
      const el = document.getElementById('panel-claude-stats');
      // cs is null on first paint AND on fetch error (Promise chain uses
      // .catch(() => null)). Render the spinner block on both so the user
      // sees motion during the 10–15s transcript walk and during a transient
      // network blip — better than a static "Loading..." that looks frozen.
      if (!cs) {
        el.innerHTML =
          '<div class="loading-block">' +
            '<div class="spinner"></div>' +
            '<div class="msg">Reading Claude Code transcripts…</div>' +
            '<div class="hint">First load can take 10–15 seconds — moflo walks every session file in this project\\'s transcript directory. Subsequent loads in this tab are much faster.</div>' +
          '</div>';
        return;
      }

      // Always-visible disclaimer banner — keeps the scope and limits in
      // view so the numbers aren't read as account-wide truth.
      const disclaimer =
        '<div style="background:#161b22;border:1px solid #30363d;border-left:3px solid #d29922;border-radius:6px;padding:10px 14px;margin-bottom:16px;color:#c9d1d9;font-size:0.85rem;line-height:1.5">' +
        '<strong>Local primary-session stats only.</strong> Counts what Claude Code wrote to disk for THIS project on THIS machine. ' +
        '<strong>Excludes sub-sessions spawned by Task-tool agents</strong> ' +
        '(e.g. <code>/simplify</code>, <code>/ultrareview</code>, Explore) — their Sonnet/Haiku usage is stored in per-session ' +
        '<code>subagents/</code> transcripts the dashboard doesn\\'t yet read, so totals here skew toward the primary model. ' +
        'Also excludes claude.ai web sessions, other projects, other devices, and your account-level plan quota.' +
        '</div>';

      if (!cs.available) {
        el.innerHTML = disclaimer +
          '<div class="empty">No Claude Code sessions found in this project' +
          (cs.projectDir ? ' (looked in <code style="color:#8b949e">' + esc(cs.projectDir) + '</code>)' : '') +
          '</div>';
        return;
      }

      const w = cs.windows;

      // Summary windows (today / 7d / 30d / lifetime).
      const winRow = (label, win) => {
        return '<tr><td style="font-weight:600">' + label + '</td>' +
          '<td>' + fmtCount(win.sessions) + '</td>' +
          '<td>' + fmtCount(win.tokens.total) + '</td>' +
          '<td>' + fmtCount(win.tokens.input) + '</td>' +
          '<td>' + fmtCount(win.tokens.output) + '</td>' +
          '<td>' + fmtCount(win.tokens.cacheCreate) + '</td>' +
          '<td>' + fmtCount(win.tokens.cacheRead) + '</td></tr>';
      };
      const winTable =
        '<h2>Sessions and Tokens</h2>' +
        '<table><thead><tr>' +
          '<th>Window</th><th>Sessions</th><th>Total Tokens</th>' +
          '<th>Input</th><th>Output</th><th>Cache Create</th><th>Cache Read</th>' +
        '</tr></thead><tbody>' +
        winRow('Today', w.today) +
        winRow('Last 7 days', w.last7d) +
        winRow('Last 30 days', w.last30d) +
        winRow('Lifetime', w.lifetime) +
        '</tbody></table>';

      // Model distribution.
      const modelRows = (cs.models && cs.models.length)
        ? cs.models.map(m => '<tr><td>' + esc(m.model) + '</td>' +
            '<td>' + fmtCount(m.messages) + '</td>' +
            '<td>' + fmtCount(m.tokens) + '</td></tr>').join('')
        : '<tr><td colspan="3" class="empty">No model data</td></tr>';
      const modelsTable =
        '<h2>Models Used (primary sessions)</h2>' +
        '<table><thead><tr><th>Model</th><th>Messages</th><th>Total Tokens</th></tr></thead>' +
        '<tbody>' + modelRows + '</tbody></table>';

      // Top-10 tools.
      const toolRows = (cs.tools && cs.tools.length)
        ? cs.tools.map(t => '<tr><td>' + esc(t.name) + '</td><td>' + fmtCount(t.count) + '</td></tr>').join('')
        : '<tr><td colspan="2" class="empty">No tool calls recorded</td></tr>';
      const toolsTable =
        '<h2>Top Tools</h2>' +
        '<table><thead><tr><th>Tool</th><th>Calls</th></tr></thead>' +
        '<tbody>' + toolRows + '</tbody></table>';

      // Headline cards.
      const cards =
        '<div class="grid">' +
        '<div class="stat-card"><div class="label">Total Sessions</div><div class="value">' + fmtCount(cs.totalSessions) + '</div></div>' +
        '<div class="stat-card"><div class="label">Sessions w/ Errors</div><div class="value">' + fmtCount(cs.errorSessions) + '</div></div>' +
        '<div class="stat-card"><div class="label">Median Duration</div><div class="value">' + fmtDuration(cs.sessionDurationMs.median) + '</div></div>' +
        '<div class="stat-card"><div class="label">p95 Duration</div><div class="value">' + fmtDuration(cs.sessionDurationMs.p95) + '</div></div>' +
        '</div>';

      const footer =
        '<div class="dim" style="margin-top:12px">' +
        'Aggregation took ' + fmtDuration(cs.elapsedMs) +
        (cs.parseErrors ? ' &middot; ' + cs.parseErrors + ' lines skipped (parse error)' : '') +
        '</div>';

      el.innerHTML = disclaimer + cards + winTable + modelsTable + toolsTable + footer;
    }

    // Polling
    const poll = async () => {
      try {
        // Claude Stats aggregation walks the user's transcript dir — only
        // pull it when the tab is visible so steady-state polling stays
        // four lightweight endpoints. Switching to the tab triggers an
        // immediate poll so the user doesn't wait up to 5s for first paint.
        const wantClaudeStats = activeTab === 'claude-stats';
        const fetches = [
          fetch('/api/status').then(r => r.json()),
          fetch('/api/schedules').then(r => r.json()),
          fetch('/api/spells').then(r => r.json()),
          fetch('/api/memory/stats').then(r => r.json()),
          wantClaudeStats
            ? fetch('/api/claude-stats').then(r => r.json()).catch(() => null)
            : Promise.resolve(null),
        ];
        const [s, sc, w, m, cs] = await Promise.all(fetches);
        renderStatus(s);
        renderWorkers(s);
        renderSchedules(sc);
        renderExecutions(w);
        renderMemory(m);
        if (wantClaudeStats) renderClaudeStats(cs);
        document.getElementById('poll-indicator').textContent = 'Last poll: ' + new Date().toLocaleTimeString();
      } catch (e) {
        console.error('Poll failed:', e);
      }
    };
    setInterval(poll, 5000);
    poll();
  </script>
</body>
</html>`;
