/**
 * Daemon Dashboard — Lightweight localhost HTTP server
 *
 * Serves a read-only VanJS dashboard for daemon status, spell logs,
 * and memory stats. Binds to 127.0.0.1 only (no auth needed).
 *
 * @module daemon-dashboard
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { WorkerDaemon } from './worker-daemon.js';
import type { MemoryAccessor } from '../../../spells/src/types/step-command.types.js';
import type { FloRunContext } from '../../../spells/src/types/runner.types.js';
import type { SchedulerErrorCode } from '../../../spells/src/scheduler/scheduler.js';

// ============================================================================
// Types
// ============================================================================

export interface DashboardOptions {
  /** Port to listen on (default: 3117). */
  port: number;
  /** Optional MemoryAccessor for namespace stats. */
  memory?: MemoryAccessor;
  /**
   * Whether `scheduler.enabled` is true in moflo.yaml. When false the
   * dashboard surfaces a distinct "disabled in moflo.yaml" state rather
   * than the generic "not connected" placeholder.
   */
  schedulerEnabledInConfig?: boolean;
}

export interface DashboardHandle {
  /** The underlying HTTP server. */
  server: Server;
  /** The port the server is listening on. */
  port: number;
  /** Stop the dashboard server. */
  stop(): Promise<void>;
}

export const DEFAULT_DASHBOARD_PORT = 3117;

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
        console.warn(`[dashboard] memory.write(${namespace}, ${key}) failed: ${result.error ?? 'unknown'}`);
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

function handleStatus(daemon: WorkerDaemon): object {
  const status = daemon.getStatus();
  const workers: Record<string, unknown>[] = [];
  for (const [type, state] of status.workers) {
    workers.push({
      type,
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
  // Single GROUP BY query — no hardcoded namespace list, no row fetching
  try {
    const { getNamespaceCounts } = await import('../memory/memory-initializer.js');
    const { namespaces, total } = await getNamespaceCounts();
    return { namespaces, totalEntries: total, available: total > 0 || Object.keys(namespaces).length > 0 };
  } catch {
    return { namespaces: {}, totalEntries: 0, available: false };
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
    // POST: schedule actions (disable / enable / run). Only 127.0.0.1 traffic
    // reaches here (server.listen bind), so no CSRF layer is needed. Any
    // other POST falls through to the read-only 405 below.
    if (method === 'POST') {
      const action = matchScheduleAction(url);
      if (action) {
        await handleScheduleAction(res, daemon, action.id, action.verb);
        return;
      }
    }

    if (method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (url === '/') {
      sendHtml(res, DASHBOARD_HTML);
    } else if (url === '/api/status') {
      sendJson(res, 200, handleStatus(daemon));
    } else if (url === '/api/schedules') {
      sendJson(res, 200, await handleSchedules(daemon, opts));
    } else if (url === '/api/spells') {
      sendJson(res, 200, await handleSpells(opts.memory));
    } else if (url === '/api/memory/stats') {
      sendJson(res, 200, await handleMemoryStats());
    } else {
      sendJson(res, 404, { error: 'Not found' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
      console.warn(`[dashboard] runScheduleNow(${scheduleId}) failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    sendJson(res, 202, { ok: true, id: scheduleId, accepted: true });
  } catch (err) {
    const code = getSchedulerErrorCode(err);
    const status = code === 'busy' ? 409 : code ? 404 : 500;
    sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
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

// ============================================================================
// Server lifecycle
// ============================================================================

/** Maximum number of ports to try before giving up. */
const MAX_PORT_ATTEMPTS = 10;

/**
 * Start the dashboard HTTP server.
 *
 * Tries the requested port first, then falls back to port+1, port+2, ...
 * up to MAX_PORT_ATTEMPTS to avoid crashing the daemon when another
 * project's daemon already holds the default port.
 *
 * @param daemon - WorkerDaemon instance for status data
 * @param opts - Dashboard configuration
 * @returns A handle to stop the server (port reflects the actual bound port)
 */
export async function startDashboard(
  daemon: WorkerDaemon,
  opts: DashboardOptions,
): Promise<DashboardHandle> {
  const basePort = opts.port;

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const port = basePort + attempt;
    try {
      const handle = await tryListenOnPort(daemon, opts, port);
      return handle;
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : '';
      if (code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS - 1) {
        // Port taken — try the next one
        continue;
      }
      throw err;
    }
  }

  // Should be unreachable, but satisfies the type checker
  throw new Error(`All dashboard ports ${basePort}–${basePort + MAX_PORT_ATTEMPTS - 1} are in use`);
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
  <title>MoFlo Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
    h1 { color: #58a6ff; margin-bottom: 4px; font-size: 1.5rem; }
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
  </style>
</head>
<body>
  <div class="header">
    <h1>MoFlo Dashboard</h1>
    <span class="subtitle">read-only &bull; localhost</span>
  </div>
  <div id="status-bar" class="status-bar"><div class="empty">Loading...</div></div>
  <div class="nav" id="nav"></div>
  <div id="panel-workers" class="panel"></div>
  <div id="panel-schedules" class="panel" style="display:none"></div>
  <div id="panel-executions" class="panel" style="display:none"></div>
  <div id="panel-memory" class="panel" style="display:none"></div>
  <div id="poll-indicator" class="poll-indicator"></div>
  <script>
    // Tab navigation — plain DOM, no framework
    const tabIds = ['workers', 'schedules', 'executions', 'memory'];
    const tabLabels = ['Workers', 'Schedules', 'Flo Runs', 'Memory'];
    let activeTab = 'workers';

    function switchTab(id) {
      activeTab = id;
      tabIds.forEach(t => {
        document.getElementById('panel-' + t).style.display = t === id ? '' : 'none';
      });
      document.querySelectorAll('.nav-tab').forEach(el => {
        el.classList.toggle('active', el.dataset.tab === id);
      });
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
      const rows = s.workers.map(w =>
        '<tr><td>' + esc(w.type) + '</td>' +
        '<td>' + (w.isRunning ? badge('running','yellow') : badge('idle','gray')) + '</td>' +
        '<td>' + w.runCount + '</td>' +
        '<td>' + pct(w.successCount, w.failureCount) + '</td>' +
        '<td>' + fmtDuration(w.averageDurationMs) + '</td>' +
        '<td>' + fmtTimeAgo(w.lastRun) + '</td>' +
        '<td>' + (w.nextRun ? fmtTime(w.nextRun) : '-') + '</td></tr>'
      ).join('');
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
      const el = document.getElementById('panel-schedules');
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

    // Polling
    const poll = async () => {
      try {
        const [s, sc, w, m] = await Promise.all([
          fetch('/api/status').then(r => r.json()),
          fetch('/api/schedules').then(r => r.json()),
          fetch('/api/spells').then(r => r.json()),
          fetch('/api/memory/stats').then(r => r.json()),
        ]);
        renderStatus(s);
        renderWorkers(s);
        renderSchedules(sc);
        renderExecutions(w);
        renderMemory(m);
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
