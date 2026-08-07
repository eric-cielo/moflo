/**
 * Performance MCP Tools for CLI
 *
 * Performance reporting and benchmarking from real process / OS metrics:
 *
 * - `process.memoryUsage()` for heap stats
 * - `os.totalmem()` / `os.freemem()` for system memory
 * - `os.loadavg()` for CPU load — Unix only, see `readCpuUsagePercent`
 * - `performance.now()` for benchmark timing
 *
 * Every number either comes from one of those calls or is `null`. #1354
 * removed the fields that came from neither: seeded latency percentiles, a
 * throughput counter that counted calls to this tool, and a hardcoded
 * `status: 'healthy'`.
 */

import type { MCPTool } from './types.js';
import * as os from 'node:os';
import { createJsonStore } from './json-store.js';
import { readCpuUsagePercent, readLoadAverage, NOT_MEASURED } from '../shared/utils/load-average.js';
import { generateId } from '../shared/utils/id.js';

/**
 * #1354: `latency`, `throughput` and `errors` are gone from this shape.
 *
 * Nothing in this process was ever timed to produce them — the latency seeds
 * were constants that each call re-averaged from the tool's own prior output,
 * throughput was an incrementing counter of calls to this tool, and the error
 * counts were the literals 0/0. Persisted history written before this change
 * still carries those keys on disk; nothing reads them, so they age out of the
 * rolling 100-entry window on their own.
 */
interface PerfMetrics {
  timestamp: string;
  /**
   * `usage` is null where the platform cannot supply a load average — see
   * `readCpuUsagePercent`. Null, never 0: a percentage this tool could not
   * measure must not render as an idle CPU.
   */
  cpu: { usage: number | null; cores: number };
  memory: { used: number; total: number; heap: number };
}

/**
 * Cross-platform CPU usage, or null where it cannot be measured (Rule #1).
 *
 * Added here by #1354; moved to `shared/utils/load-average.ts` by #1358 once
 * three more consumers of `os.loadavg()` needed the same decision. Re-exported
 * so this module's contract is unchanged.
 */
export { readCpuUsagePercent };

interface Benchmark {
  id: string;
  name: string;
  type: string;
  results: {
    duration: number;
    iterations: number;
    opsPerSecond: number;
    memory: number;
  };
  createdAt: string;
}

interface PerfStore {
  metrics: PerfMetrics[];
  benchmarks: Record<string, Benchmark>;
  version: string;
}

const store = createJsonStore<PerfStore>({
  subdir: 'performance',
  file: 'metrics.json',
  defaults: () => ({ metrics: [], benchmarks: {}, version: '3.0.0' }),
});

const rawPerformanceTools: MCPTool[] = [
  {
    name: 'performance_report',
    description: 'Report measured CPU, memory and heap usage for this process',
    category: 'performance',
    inputSchema: {
      type: 'object',
      properties: {
        timeRange: { type: 'string', description: 'Time range (1h, 24h, 7d)' },
        format: { type: 'string', enum: ['json', 'summary', 'detailed'], description: 'Report format' },
        components: { type: 'array', items: { type: 'string' }, description: 'Components to include' },
      },
    },
    handler: async (input) => {
      const state = store.load();
      // A consumer upgrading into this build still has pre-#1354 samples on
      // disk carrying `latency` / `throughput` / `errors`. Narrowing the
      // interface does not narrow JSON already written, and `history` returns
      // stored entries verbatim — so the fabricated keys would keep surfacing
      // for the next 100 calls. Project every loaded sample onto the current
      // shape on the way in, and the rewrite persists the clean form.
      state.metrics = state.metrics.map(m => ({
        timestamp: m.timestamp,
        cpu: m.cpu,
        memory: m.memory,
      }));
      const format = (input.format as string) || 'summary';

      // Get REAL system metrics via Node.js APIs
      const memUsage = process.memoryUsage();
      const loadAvg = os.loadavg();
      const cpus = os.cpus();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();

      const cpuPercent = readCpuUsagePercent(loadAvg, cpus.length);

      // Every field below comes from a Node/OS call made on this invocation,
      // or is null because this platform could not answer.
      const currentMetrics: PerfMetrics = {
        timestamp: new Date().toISOString(),
        cpu: { usage: cpuPercent, cores: cpus.length },
        memory: {
          used: Math.round((totalMem - freeMem) / 1024 / 1024),
          total: Math.round(totalMem / 1024 / 1024),
          heap: Math.round(memUsage.heapUsed / 1024 / 1024),
        },
      };

      state.metrics.push(currentMetrics);
      // Keep last 100 metrics
      if (state.metrics.length > 100) {
        state.metrics = state.metrics.slice(-100);
      }
      store.save(state);

      if (format === 'summary') {
        // No `status` field: the literal 'healthy' it used to carry was not a
        // verdict — nothing here can observe ill-health. `mcp__moflo__system_health`
        // probes components; this tool reports resource usage (#1354).
        return {
          cpu: currentMetrics.cpu.usage === null
            ? NOT_MEASURED
            : `${currentMetrics.cpu.usage.toFixed(1)}%`,
          memory: `${currentMetrics.memory.used}MB / ${currentMetrics.memory.total}MB`,
          heap: `${currentMetrics.memory.heap}MB`,
          timestamp: currentMetrics.timestamp,
        };
      }

      // Calculate trends from history. A trend needs two comparable readings,
      // so a platform with no CPU figure gets `null` rather than the 'stable'
      // that two nulls would otherwise compare their way into.
      const history = state.metrics.slice(-10);
      const oldest = history[0];
      const newest = history[history.length - 1];
      const cpuTrend = history.length >= 2 && typeof newest.cpu.usage === 'number' && typeof oldest.cpu.usage === 'number'
        ? (newest.cpu.usage > oldest.cpu.usage ? 'increasing' : 'stable')
        : history.length >= 2 ? null : 'stable';
      const memTrend = history.length >= 2
        ? (newest.memory.used > oldest.memory.used ? 'increasing' : 'stable')
        : 'stable';

      return {
        current: currentMetrics,
        history,
        system: {
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          cpuModel: cpus[0]?.model ?? null,
          // Same reason as `cpu.usage`: Node returns [0, 0, 0] here on
          // Windows, and three zeros read as a genuinely idle machine. Gated on
          // the reading itself rather than on `cpuPercent`, which is also null
          // when `os.cpus()` comes back empty — that suppresses a per-core
          // percentage, not the load average, which is still real (#1358).
          loadAverage: readLoadAverage(loadAvg),
        },
        // No `latency` trend — there is no latency series to trend. Both
        // entries below compare the oldest and newest samples in `history`,
        // which are real readings (#1354).
        trends: {
          cpu: cpuTrend,
          memory: memTrend,
        },
        recommendations: currentMetrics.memory.used / currentMetrics.memory.total > 0.8
          ? [{ priority: 'high', message: 'Memory usage above 80% - consider cleanup' }]
          : currentMetrics.cpu.usage !== null && currentMetrics.cpu.usage > 70
            ? [{ priority: 'medium', message: 'CPU load elevated - check for resource-intensive processes' }]
            : [{ priority: 'low', message: 'System running normally' }],
      };
    },
  },
  {
    name: 'performance_benchmark',
    description: 'Run performance benchmarks',
    category: 'performance',
    inputSchema: {
      type: 'object',
      properties: {
        suite: { type: 'string', enum: ['all', 'memory', 'neural', 'swarm', 'io'], description: 'Benchmark suite' },
        iterations: { type: 'number', description: 'Number of iterations' },
        warmup: { type: 'boolean', description: 'Include warmup phase' },
      },
    },
    handler: async (input) => {
      const state = store.load();
      const suite = (input.suite as string) || 'all';
      const iterations = (input.iterations as number) || 100;
      const warmup = input.warmup !== false;

      // REAL benchmark functions
      const benchmarkFunctions: Record<string, () => void> = {
        memory: () => {
          // Real memory allocation benchmark
          const arr = new Array(1000).fill(0).map(() => Math.random());
          arr.sort();
        },
        neural: () => {
          // Real computation benchmark (matrix-like operations)
          const size = 64;
          const a = Array.from({ length: size }, () => Array.from({ length: size }, () => Math.random()));
          const b = Array.from({ length: size }, () => Array.from({ length: size }, () => Math.random()));
          // Simple matrix multiplication
          for (let i = 0; i < size; i++) {
            for (let j = 0; j < size; j++) {
              let sum = 0;
              for (let k = 0; k < size; k++) sum += a[i][k] * b[k][j];
            }
          }
        },
        swarm: () => {
          // Real object creation and manipulation
          const agents = Array.from({ length: 10 }, (_, i) => ({ id: i, status: 'active', tasks: [] as number[] }));
          agents.forEach(a => { for (let i = 0; i < 100; i++) a.tasks.push(i); });
          agents.sort((a, b) => a.tasks.length - b.tasks.length);
        },
        io: () => {
          // Real JSON serialization benchmark
          const data = { agents: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `agent-${i}` })) };
          const json = JSON.stringify(data);
          JSON.parse(json);
        },
      };

      const results: Array<{ name: string; opsPerSec: number; avgLatency: string; memoryUsage: string; _real: boolean }> = [];
      const suitesToRun = suite === 'all' ? Object.keys(benchmarkFunctions) : [suite];

      // Warmup phase
      if (warmup) {
        for (const suiteName of suitesToRun) {
          const fn = benchmarkFunctions[suiteName];
          if (fn) for (let i = 0; i < 10; i++) fn();
        }
      }

      // Real benchmarks with actual timing
      for (const suiteName of suitesToRun) {
        const fn = benchmarkFunctions[suiteName];
        if (fn) {
          const memBefore = process.memoryUsage().heapUsed;
          const startTime = performance.now();

          for (let i = 0; i < iterations; i++) fn();

          const endTime = performance.now();
          const memAfter = process.memoryUsage().heapUsed;

          const durationMs = endTime - startTime;
          const opsPerSec = Math.round((iterations / durationMs) * 1000);
          const avgLatencyMs = durationMs / iterations;
          const memoryDelta = Math.round((memAfter - memBefore) / 1024);

          const id = generateId(`bench-${suiteName}`);
          const result: Benchmark = {
            id,
            name: suiteName,
            type: 'performance',
            results: {
              duration: durationMs / 1000,
              iterations,
              opsPerSecond: opsPerSec,
              memory: Math.max(0, memoryDelta),
            },
            createdAt: new Date().toISOString(),
          };

          state.benchmarks[id] = result;

          results.push({
            name: suiteName,
            opsPerSec,
            avgLatency: `${avgLatencyMs.toFixed(3)}ms`,
            memoryUsage: `${Math.abs(memoryDelta)}KB`,
            _real: true,
          });
        }
      }

      store.save(state);

      // Calculate comparison vs previous benchmarks
      const allBenchmarks = Object.values(state.benchmarks);
      const previousBenchmarks = allBenchmarks
        .filter(b => suitesToRun.includes(b.name) && b.createdAt < results[0]?.name)
        .slice(-suitesToRun.length);

      const comparison = previousBenchmarks.length > 0
        ? {
            vsPrevious: `${results.reduce((sum, r) => sum + r.opsPerSec, 0) > previousBenchmarks.reduce((sum, b) => sum + b.results.opsPerSecond, 0) ? '+' : ''}${Math.round(((results.reduce((sum, r) => sum + r.opsPerSec, 0) / previousBenchmarks.reduce((sum, b) => sum + b.results.opsPerSecond, 0)) - 1) * 100)}% vs previous`,
            totalBenchmarks: allBenchmarks.length,
          }
        : { note: 'First benchmark run - no comparison available', totalBenchmarks: allBenchmarks.length };

      return {
        _real: true,
        suite,
        iterations,
        warmup,
        results,
        comparison,
        timestamp: new Date().toISOString(),
      };
    },
  },
];

/**
 * Neither tool is labelled any more (#1354).
 *
 * `performance_benchmark` always measured — it runs real workloads and times
 * them with `performance.now()`, so its `_real: true` is accurate and stays.
 * (The `Math.random()` calls in its benchmark functions generate the workload;
 * they are not the result.)
 *
 * `performance_report` earned its way out of the notice by losing the fields
 * the notice was about, rather than by relabelling them. #1325 had already
 * removed its `_real: true` — a response cannot be both authentic and
 * synthetic — and what is left now is authentic, so neither marker applies.
 */
export const performanceTools: MCPTool[] = rawPerformanceTools;
