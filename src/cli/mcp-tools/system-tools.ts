/**
 * System MCP Tools for CLI
 *
 * `system_health` probes moflo's own components and reports what it observed.
 *
 * Before #1354 it probed nothing: every `status` except `neural` was the
 * literal `'healthy'` and every `latency` was a `Math.random()` draw, so a
 * component that was genuinely down still reported healthy and `score` was
 * arithmetic over placeholders. A health check that cannot report ill-health
 * is worse than no health check, so the placeholders are gone and each entry
 * below is now the outcome of a real call.
 *
 * Design rules this file follows, all inherited from #1349:
 *
 * - **Absent beats invented.** `score` is `null` when nothing judgeable was
 *   probed, never `0` — a failed probe rendered as zero reads as a real
 *   verdict of "totally unhealthy".
 * - **Not-running is not unhealthy.** The daemon, the MCP server and the swarm
 *   coordinator are all lazily started; reporting a dormant one as a failure
 *   would make every cold call read `degraded`. They get their own
 *   `not-running` status and are excluded from the score's denominator.
 * - **No parameter is accepted and ignored.** `components` filters the probe
 *   set for real. `deep` and `fix` are gone — `deep` only ever added three
 *   more fabricated checks, and repair belongs to `flo doctor --fix`.
 *
 * Cross-platform (Rule #1): every probe delegates to an existing helper that
 * already handles platform differences — `getDaemonLockHolder` for the
 * POSIX/Windows process-liveness split, `memoryDbPath`/`resolveStateRoot` for
 * path construction. Nothing here builds a path or shells out.
 */

import type { MCPTool } from './types.js';
import { findProjectRoot } from '../services/project-root.js';
import { errorDetail } from '../shared/utils/error-detail.js';

/**
 * `healthy` and `unhealthy` are verdicts and drive the score. `not-running` is
 * an observation about a lazily-started component and drives nothing — see the
 * "Not-running is not unhealthy" rule above.
 */
export type ProbeStatus = 'healthy' | 'unhealthy' | 'not-running';

export interface HealthProbe {
  name: string;
  status: ProbeStatus;
  /** Wall-clock duration of the probe call itself, in milliseconds. */
  latencyMs: number;
  message: string;
}

type ProbeFn = () => Promise<{ status: ProbeStatus; message: string }>;

/**
 * Time a probe and convert a thrown error into an `unhealthy` verdict.
 *
 * A probe that throws IS a finding — the component could not be reached — so
 * it must not be swallowed into a healthy result, and must not take the whole
 * tool down with it either.
 */
async function runProbe(name: string, probe: ProbeFn): Promise<HealthProbe> {
  const startedAt = performance.now();
  try {
    const { status, message } = await probe();
    return { name, status, message, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (err) {
    return {
      name,
      status: 'unhealthy',
      message: `probe failed: ${errorDetail(err)}`,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }
}

/**
 * Every probe is a dynamic import: `mcp-server.js` imports the tool registry
 * that imports this file, so a static import would close a module cycle at
 * evaluation time. Deferring to call time also keeps `system_health` cheap for
 * the importers that only ever read its schema.
 */
const PROBES: Record<string, ProbeFn> = {
  memory: async () => {
    const { checkMemoryInitialization } = await import('../memory/memory-initializer.js');
    const status = await checkMemoryInitialization();
    return status.initialized
      ? { status: 'healthy', message: `memory database initialized (schema ${status.version ?? 'unknown'})` }
      : { status: 'unhealthy', message: 'memory database missing or unreadable — run `flo doctor --fix`' };
  },

  mcp: async () => {
    const { getMCPServerStatus } = await import('../mcp-server.js');
    const status = await getMCPServerStatus();
    return status.running
      ? { status: 'healthy', message: `MCP server running on ${status.transport ?? 'stdio'} (pid ${status.pid ?? process.pid})` }
      : { status: 'not-running', message: 'MCP server is not running' };
  },

  daemon: async () => {
    const { getDaemonLockHolder } = await import('../services/daemon-lock.js');
    // Note: this accessor opportunistically unlinks a lock whose holder is
    // provably dead. That cleanup is the canonical behaviour every other
    // caller relies on, and it only ever removes a stale file.
    const holder = getDaemonLockHolder(findProjectRoot());
    return holder !== null
      ? { status: 'healthy', message: `daemon holding the lock (pid ${holder})` }
      : { status: 'not-running', message: 'no daemon is holding the lock' };
  },

  swarm: async () => {
    const { isSwarmCoordinatorInitialized } = await import('./swarm-coordinator-singleton.js');
    // Deliberately does NOT call getSwarmCoordinator(): booting a coordinator
    // as a side effect of asking whether one is running would make the probe
    // its own answer.
    return isSwarmCoordinatorInitialized()
      ? { status: 'healthy', message: 'swarm coordinator initialized in this process' }
      : { status: 'not-running', message: 'swarm coordinator not initialized (starts lazily on first swarm call)' };
  },
};

export const systemTools: MCPTool[] = [
  {
    name: 'system_health',
    description: 'Probe moflo components (memory, MCP server, daemon, swarm) and report the observed state of each',
    category: 'system',
    inputSchema: {
      type: 'object',
      properties: {
        components: {
          type: 'array',
          items: { type: 'string' },
          description: `Subset of components to probe (default all): ${Object.keys(PROBES).join(', ')}`,
        },
      },
    },
    handler: async (input) => {
      const known = Object.keys(PROBES);
      const requested = Array.isArray(input.components)
        ? (input.components as unknown[]).map(String)
        : known;

      const selected = requested.filter(name => name in PROBES);
      const unknownComponents = requested.filter(name => !(name in PROBES));

      // Probes are independent and mostly I/O-bound, so the slowest one sets
      // the tool's latency rather than the sum of all of them.
      const checks = await Promise.all(selected.map(name => runProbe(name, PROBES[name])));

      const healthy = checks.filter(c => c.status === 'healthy').length;
      const unhealthy = checks.filter(c => c.status === 'unhealthy').length;
      const notRunning = checks.filter(c => c.status === 'not-running').length;
      const judged = healthy + unhealthy;

      // `null`, not `0`, when nothing could be judged — see the header. The
      // same reason `flo status` prints "not measured" rather than "0.00ms".
      const score = judged > 0 ? Math.round((healthy / judged) * 100) : null;

      return {
        overall:
          score === null ? 'unknown'
            : score === 100 ? 'healthy'
              : score >= 50 ? 'degraded'
                : 'unhealthy',
        score,
        checks,
        healthy,
        unhealthy,
        notRunning,
        timestamp: new Date().toISOString(),
        issues: checks
          .filter(c => c.status === 'unhealthy')
          .map(c => ({ component: c.name, message: c.message })),
        // Echoed rather than silently dropped: a caller who typos a component
        // name would otherwise get a confident report about the probes it did
        // not ask for.
        ...(unknownComponents.length > 0 ? { unknownComponents } : {}),
      };
    },
  },
];

export default systemTools;
