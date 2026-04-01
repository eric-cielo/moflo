/**
 * Daemon Dashboard — Lightweight localhost HTTP server
 *
 * Serves a read-only VanJS dashboard for daemon status, workflow logs,
 * and memory stats. Binds to 127.0.0.1 only (no auth needed).
 *
 * @module daemon-dashboard
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { WorkerDaemon } from './worker-daemon.js';
import type { WorkflowScheduler } from '../../../workflows/src/scheduler/scheduler.js';
import type { MemoryAccessor } from '../../../workflows/src/types/step-command.types.js';

// ============================================================================
// Types
// ============================================================================

export interface DashboardOptions {
  /** Port to listen on (default: 3117). */
  port: number;
  /** Optional WorkflowScheduler for schedule/execution data. */
  scheduler?: WorkflowScheduler;
  /** Optional MemoryAccessor for namespace stats. */
  memory?: MemoryAccessor;
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

async function handleSchedules(scheduler?: WorkflowScheduler): Promise<object> {
  if (!scheduler) {
    return { schedules: [], available: false };
  }
  const schedules = await scheduler.listSchedules();
  return {
    schedules: schedules.map(s => ({
      id: s.id,
      workflowName: s.workflowName,
      cron: s.cron ?? null,
      interval: s.interval ?? null,
      at: s.at ?? null,
      enabled: s.enabled,
      lastRunAt: s.lastRunAt ?? null,
      nextRunAt: s.nextRunAt,
      source: s.source,
    })),
    available: true,
  };
}

async function handleWorkflows(scheduler?: WorkflowScheduler): Promise<object> {
  if (!scheduler) {
    return { executions: [], available: false };
  }
  const schedules = await scheduler.listSchedules();
  const allExecs: unknown[] = [];
  for (const schedule of schedules) {
    const execs = await scheduler.getExecutionHistory(schedule.id, 20);
    allExecs.push(...execs);
  }
  // Sort by startedAt descending, take top 50
  const sorted = (allExecs as Array<{ startedAt: number }>)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 50);
  return { executions: sorted, available: true };
}

async function handleMemoryStats(memory?: MemoryAccessor): Promise<object> {
  if (!memory) {
    return { namespaces: {}, totalEntries: 0, available: false };
  }
  // Query well-known namespaces for entry counts
  const knownNamespaces = [
    'guidance', 'patterns', 'code-map', 'knowledge',
    'scheduled-workflows', 'schedule-executions',
  ];
  const counts = await Promise.all(
    knownNamespaces.map(async (ns) => {
      try {
        const results = await memory.search(ns, '*');
        return { ns, count: results.length };
      } catch {
        return { ns, count: 0 };
      }
    }),
  );
  const namespaceCounts: Record<string, number> = {};
  let totalEntries = 0;
  for (const { ns, count } of counts) {
    namespaceCounts[ns] = count;
    totalEntries += count;
  }
  return { namespaces: namespaceCounts, totalEntries, available: true };
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

  // Only allow GET requests — dashboard is read-only
  if (method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    if (url === '/') {
      sendHtml(res, DASHBOARD_HTML);
    } else if (url === '/api/status') {
      sendJson(res, 200, handleStatus(daemon));
    } else if (url === '/api/schedules') {
      sendJson(res, 200, await handleSchedules(opts.scheduler));
    } else if (url === '/api/workflows') {
      sendJson(res, 200, await handleWorkflows(opts.scheduler));
    } else if (url === '/api/memory/stats') {
      sendJson(res, 200, await handleMemoryStats(opts.memory));
    } else {
      sendJson(res, 404, { error: 'Not found' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Internal server error', message });
  }
}

// ============================================================================
// Server lifecycle
// ============================================================================

/**
 * Start the dashboard HTTP server.
 *
 * @param daemon - WorkerDaemon instance for status data
 * @param opts - Dashboard configuration
 * @returns A handle to stop the server
 */
export function startDashboard(
  daemon: WorkerDaemon,
  opts: DashboardOptions,
): DashboardHandle {
  const port = opts.port;

  const server = createServer((req, res) => {
    handleRequest(req, res, daemon, opts).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error' });
      }
    });
  });

  // Prevent uncaught EADDRINUSE from crashing the daemon process
  server.on('error', (err) => {
    // Re-throw as a catchable error so callers see it
    throw err;
  });

  server.listen(port, '127.0.0.1');

  return {
    server,
    port,
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
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
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    // VanJS 1.5.2 minified (~0.9KB)
    var van=((e)=>{let t=e.document,s=t.createElement.bind(t),n=e=>e==null,r=(e,t)=>{for(let s in t)e[s]=t[s];return e},l=Object,o=l.getPrototypeOf,a=e=>o(o(e))===null||o(e)===null,i=e=>e instanceof Function,c=e=>e._val!==void 0,u=(e,...t)=>{let n=s(e);for(let e of t.flat(1/0)){let t=c(e)?()=>e.rawVal:e;n.append(i(t)?van.bind(t):t)}return n},d=(e,t,s)=>{let r=t[s];r!==void 0&&(i(r)?van.bind(()=>{e[s]=r();return e[s]}):n(r)||(e[s]=r))},f=(e,t)=>{for(let s in t)d(e,t,s);return e},p=e=>{let t;for(;(t=e._listeners.pop())&&!t._dom?.isConnected;);return t},h=(e,t)=>{let s=e.rawVal;e._val=t;for(let n of e._listeners){n._dom?.isConnected?n(t,s):e._listeners.delete(n)}},g=e=>{let t;return{get val(){return c(e)?e.rawVal:e},get oldVal(){return c(e)?e._oldVal:e},set val(s){if(c(e)){let n=e.rawVal;s!==n&&(e._val=s,h(e,s))}}}},v=class{_val;_oldVal;_listeners=new Set;constructor(e){this._val=e}get val(){return this._val}set val(e){let t=this._val;e!==t&&(this._val=e,this._oldVal=t,h(this,e))}get rawVal(){return this._val}},m=(e,...t)=>{let n=s(e);for(let e of t){if(a(e)){f(n,e);continue}let t=e;n.append(i(t)?van.bind(t):c(t)?van.bind(()=>t.val):t)}return n};return{tags:new Proxy((e,t)=>{let s=m.bind(void 0,e);return t.set(e,s),s},{get:(e,t)=>e[t]??(e[t]=m.bind(void 0,t))}),state:e=>new v(e),val:e=>c(e)?e.rawVal:e,oldVal:e=>c(e)?e._oldVal:e,derive:e=>{let t=van.state();van.bind(()=>{t.val=e()});return t},bind:(...e)=>{let s=e.pop(),r=()=>s(...e.map(e=>i(e)?e():van.val(e))),l=van.state(r()),o=()=>{let e=r();e!==l.rawVal&&(l.val=e);return l.rawVal};for(let t of e)if(c(t))t._listeners.add(o);else if(i(t)){let e=van.state(t());van.bind(()=>{e.val=t()});e._listeners.add(o)}let a=van.derive(()=>l.val);return n(a.val)?t.createTextNode(""):a.val instanceof Node?a.val:t.createTextNode(a.val)},add:(e,...t)=>{for(let s of t.flat(1/0))e.append(i(s)?van.bind(s):c(s)?van.bind(()=>s.val):s);return e},hydrate:(e,t)=>t(e),_:e=>e,}})(window);
  </script>
  <script>
    const {div, h1, h2, a, nav, span, table, thead, tbody, tr, th, td} = van.tags;

    // Reactive state
    const status = van.state(null);
    const schedules = van.state(null);
    const workflows = van.state(null);
    const memoryStats = van.state(null);
    const lastPoll = van.state(null);
    const activeTab = van.state('workers');

    // Polling
    const poll = async () => {
      try {
        const [s, sc, w, m] = await Promise.all([
          fetch('/api/status').then(r => r.json()),
          fetch('/api/schedules').then(r => r.json()),
          fetch('/api/workflows').then(r => r.json()),
          fetch('/api/memory/stats').then(r => r.json()),
        ]);
        status.val = s;
        schedules.val = sc;
        workflows.val = w;
        memoryStats.val = m;
        lastPoll.val = new Date().toLocaleTimeString();
      } catch (e) {
        console.error('Poll failed:', e);
      }
    };
    setInterval(poll, 5000);
    poll();

    // Helpers
    const fmtDuration = (ms) => {
      if (ms == null) return '-';
      if (ms < 1000) return ms + 'ms';
      if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
      return (ms / 60000).toFixed(1) + 'm';
    };

    const fmtTime = (iso) => {
      if (!iso) return '-';
      const d = new Date(typeof iso === 'number' ? iso : iso);
      return d.toLocaleTimeString();
    };

    const fmtTimeAgo = (iso) => {
      if (!iso) return 'never';
      const ms = Date.now() - new Date(iso).getTime();
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      return Math.floor(s / 86400) + 'd ago';
    };

    const fmtUptime = (secs) => {
      if (!secs) return '-';
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      if (h > 0) return h + 'h ' + m + 'm';
      if (m > 0) return m + 'm ' + s + 's';
      return s + 's';
    };

    const successRate = (s, f) => {
      const total = s + f;
      return total === 0 ? '-' : Math.round((s / total) * 100) + '%';
    };

    const badge = (text, type) => span({class: 'badge badge-' + type}, text);

    // Tab navigation
    const tabs = [
      { id: 'workers', label: 'Workers' },
      { id: 'schedules', label: 'Schedules' },
      { id: 'executions', label: 'Executions' },
      { id: 'memory', label: 'Memory' },
      { id: 'api', label: 'API' },
    ];

    const NavBar = () => div({class: 'nav'},
      ...tabs.map(t =>
        van.bind(activeTab, at =>
          div({
            class: 'nav-tab' + (at === t.id ? ' active' : ''),
            onclick: () => { activeTab.val = t.id; },
          }, t.label)
        )
      ),
    );

    // Status bar (always visible)
    const StatusBar = () => van.bind(status, s => {
      if (!s) return div({class: 'empty'}, 'Loading...');
      return div({class: 'status-bar'},
        div({class: 'item'},
          span({class: 'label'}, 'Status'),
          span({class: 'value'}, span({class: 'dot ' + (s.running ? 'dot-green' : 'dot-red')}), s.running ? 'Running' : 'Stopped'),
        ),
        div({class: 'item'}, span({class: 'label'}, 'PID'), span({class: 'value'}, s.pid)),
        div({class: 'item'}, span({class: 'label'}, 'Uptime'), span({class: 'value'}, fmtUptime(s.uptime))),
        div({class: 'item'}, span({class: 'label'}, 'Workers'), span({class: 'value'}, s.config.enabledWorkerCount + ' enabled')),
        div({class: 'item'}, span({class: 'label'}, 'Max Concurrent'), span({class: 'value'}, s.config.maxConcurrent)),
      );
    });

    // Workers panel
    const WorkersPanel = () => van.bind(status, s => {
      if (!s) return div();
      return div(
        h2('Worker Status'),
        table(
          thead(tr(th('Worker'), th('Status'), th('Runs'), th('Success'), th('Avg'), th('Last Run'), th('Next Run'))),
          tbody(...s.workers.map(w =>
            tr(
              td(w.type),
              td(w.isRunning ? badge('running', 'yellow') : badge('idle', 'gray')),
              td(w.runCount),
              td(successRate(w.successCount, w.failureCount)),
              td(fmtDuration(w.averageDurationMs)),
              td(fmtTimeAgo(w.lastRun)),
              td(w.nextRun ? fmtTime(w.nextRun) : '-'),
            )
          )),
        ),
      );
    });

    // Schedules panel
    const SchedulesPanel = () => van.bind(schedules, sc => {
      if (!sc || !sc.available) return div({class: 'empty'}, 'Scheduler not connected');
      if (sc.schedules.length === 0) return div({class: 'empty'}, 'No active schedules');
      return div(
        h2('Scheduled Workflows'),
        table(
          thead(tr(th('Workflow'), th('Schedule'), th('Enabled'), th('Last Run'), th('Next Run'), th('Source'))),
          tbody(...sc.schedules.map(s =>
            tr(
              td(s.workflowName),
              td(s.cron || s.interval || s.at || '-'),
              td(s.enabled ? badge('on', 'green') : badge('off', 'gray')),
              td(s.lastRunAt ? fmtTime(s.lastRunAt) : '-'),
              td(fmtTime(s.nextRunAt)),
              td(badge(s.source, 'gray')),
            )
          )),
        ),
      );
    });

    // Executions panel
    const ExecutionsPanel = () => van.bind(workflows, w => {
      if (!w || !w.available) return div({class: 'empty'}, 'Scheduler not connected');
      if (w.executions.length === 0) return div({class: 'empty'}, 'No recent executions');
      return div(
        h2('Recent Executions'),
        table(
          thead(tr(th('Workflow'), th('Status'), th('Started'), th('Duration'), th('Error'))),
          tbody(...w.executions.map(e =>
            tr(
              td(e.workflowName),
              td(e.success === true ? badge('pass', 'green') : e.success === false ? badge('fail', 'red') : badge('running', 'yellow')),
              td(fmtTime(e.startedAt)),
              td(fmtDuration(e.duration)),
              td(e.error ? span({style: 'color: #f85149; font-size: 0.8rem'}, e.error.substring(0, 80)) : '-'),
            )
          )),
        ),
      );
    });

    // Memory panel
    const MemoryPanel = () => van.bind(memoryStats, m => {
      if (!m || !m.available) return div({class: 'empty'}, 'Memory not connected');
      const entries = Object.entries(m.namespaces);
      if (entries.length === 0) return div({class: 'empty'}, 'No namespaces');
      return div(
        h2('Memory Stats'),
        div({class: 'grid'},
          div({class: 'stat-card'}, div({class: 'label'}, 'Total Entries'), div({class: 'value'}, m.totalEntries)),
          div({class: 'stat-card'}, div({class: 'label'}, 'Namespaces'), div({class: 'value'}, entries.length)),
        ),
        table(
          thead(tr(th('Namespace'), th('Entries'))),
          tbody(...entries.map(([ns, count]) =>
            tr(td(ns), td(count))
          )),
        ),
      );
    });

    // API reference panel
    const ApiPanel = () => div(
      h2('API Endpoints'),
      div({class: 'api-links'},
        a({href: '/api/status', target: '_blank'}, '/api/status'), ' \u2014 Daemon + worker status', div({style: 'height: 8px'}),
        a({href: '/api/schedules', target: '_blank'}, '/api/schedules'), ' \u2014 Active schedules + next run times', div({style: 'height: 8px'}),
        a({href: '/api/workflows', target: '_blank'}, '/api/workflows'), ' \u2014 Recent workflow executions', div({style: 'height: 8px'}),
        a({href: '/api/memory/stats', target: '_blank'}, '/api/memory/stats'), ' \u2014 Namespace counts + total entries',
      ),
    );

    // Tab content router
    const TabContent = () => van.bind(activeTab, tab => {
      switch (tab) {
        case 'workers': return WorkersPanel();
        case 'schedules': return SchedulesPanel();
        case 'executions': return ExecutionsPanel();
        case 'memory': return MemoryPanel();
        case 'api': return ApiPanel();
        default: return WorkersPanel();
      }
    });

    // Render
    van.add(document.getElementById('app'),
      div({class: 'header'},
        h1('MoFlo Dashboard'),
        span({class: 'subtitle'}, 'read-only \u2022 localhost'),
      ),
      StatusBar(),
      NavBar(),
      TabContent(),
      van.bind(lastPoll, t => div({class: 'poll-indicator'}, t ? 'Last poll: ' + t : '')),
    );
  </script>
</body>
</html>`;
