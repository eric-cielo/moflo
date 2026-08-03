/**
 * Performance MCP Tools for CLI
 *
 * Performance reporting and benchmarking using real process / OS metrics.
 *
 * Uses REAL process metrics where available:
 * - process.memoryUsage() for heap/memory stats
 * - process.cpuUsage() for CPU time
 * - os module for system load and memory
 * - performance.now() for benchmark timing
 */

import type { MCPTool } from './types.js';
import { applySyntheticNotices } from './synthetic.js';
import * as os from 'node:os';
import { createJsonStore } from './json-store.js';

interface PerfMetrics {
  timestamp: string;
  cpu: { usage: number; cores: number };
  memory: { used: number; total: number; heap: number };
  latency: { avg: number; p50: number; p95: number; p99: number };
  throughput: { requests: number; operations: number };
  errors: { count: number; rate: number };
}

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
    description: 'Report process CPU and memory, with placeholder latency and throughput',
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
      const format = (input.format as string) || 'summary';

      // Get REAL system metrics via Node.js APIs
      const memUsage = process.memoryUsage();
      const loadAvg = os.loadavg();
      const cpus = os.cpus();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();

      // Calculate real CPU usage percentage from load average
      const cpuPercent = (loadAvg[0] / cpus.length) * 100;

      // Generate current metrics with REAL values
      const currentMetrics: PerfMetrics = {
        timestamp: new Date().toISOString(),
        cpu: { usage: Math.min(cpuPercent, 100), cores: cpus.length },
        memory: {
          used: Math.round((totalMem - freeMem) / 1024 / 1024),
          total: Math.round(totalMem / 1024 / 1024),
          heap: Math.round(memUsage.heapUsed / 1024 / 1024),
        },
        // NOT measured (#1325). Nothing in this process is timed to produce
        // these; the seeds below are constants, and every later call averages
        // this tool's own prior outputs — so the numbers converge on the seed
        // no matter how the system actually behaves. Left as-is because
        // changing them is a behaviour change; the tool is labelled instead.
        latency: {
          avg: state.metrics.length > 0 ? state.metrics.slice(-10).reduce((s, m) => s + m.latency.avg, 0) / Math.min(state.metrics.length, 10) : 50,
          p50: state.metrics.length > 0 ? state.metrics.slice(-10).reduce((s, m) => s + m.latency.p50, 0) / Math.min(state.metrics.length, 10) : 40,
          p95: state.metrics.length > 0 ? state.metrics.slice(-10).reduce((s, m) => s + m.latency.p95, 0) / Math.min(state.metrics.length, 10) : 100,
          p99: state.metrics.length > 0 ? state.metrics.slice(-10).reduce((s, m) => s + m.latency.p99, 0) / Math.min(state.metrics.length, 10) : 200,
        },
        throughput: {
          requests: state.metrics.length > 0 ? state.metrics[state.metrics.length - 1].throughput.requests + 1 : 1,
          operations: state.metrics.length > 0 ? state.metrics[state.metrics.length - 1].throughput.operations + 10 : 10,
        },
        errors: { count: 0, rate: 0 },
      };

      state.metrics.push(currentMetrics);
      // Keep last 100 metrics
      if (state.metrics.length > 100) {
        state.metrics = state.metrics.slice(-100);
      }
      store.save(state);

      if (format === 'summary') {
        return {
          status: 'healthy',
          cpu: `${currentMetrics.cpu.usage.toFixed(1)}%`,
          memory: `${currentMetrics.memory.used}MB / ${currentMetrics.memory.total}MB`,
          heap: `${currentMetrics.memory.heap}MB`,
          latency: `${currentMetrics.latency.avg.toFixed(0)}ms avg`,
          throughput: `${currentMetrics.throughput.operations} ops/s`,
          errorRate: `${(currentMetrics.errors.rate * 100).toFixed(2)}%`,
          timestamp: currentMetrics.timestamp,
        };
      }

      // Calculate trends from history
      const history = state.metrics.slice(-10);
      const cpuTrend = history.length >= 2
        ? (history[history.length - 1].cpu.usage > history[0].cpu.usage ? 'increasing' : 'stable')
        : 'stable';
      const memTrend = history.length >= 2
        ? (history[history.length - 1].memory.used > history[0].memory.used ? 'increasing' : 'stable')
        : 'stable';

      return {
        current: currentMetrics,
        history,
        system: {
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          cpuModel: cpus[0]?.model,
          loadAverage: loadAvg,
        },
        trends: {
          cpu: cpuTrend,
          memory: memTrend,
          latency: 'stable',
        },
        recommendations: currentMetrics.memory.used / currentMetrics.memory.total > 0.8
          ? [{ priority: 'high', message: 'Memory usage above 80% - consider cleanup' }]
          : currentMetrics.cpu.usage > 70
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

          const id = `bench-${suiteName}-${Date.now()}`;
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
 * Only `performance_report` is labelled. `performance_benchmark` genuinely
 * measures — it runs real workloads and times them with `performance.now()`,
 * so its `_real: true` is accurate and stays. (The `Math.random()` calls in
 * its benchmark functions generate the workload; they are not the result.)
 *
 * `performance_report`'s `_real: true` was removed rather than kept alongside
 * the notice: a response cannot be both authentic and synthetic, and a wrong
 * authenticity claim is worse than an unlabelled number — a caller can
 * discount an unmarked figure, but not one asserted as measured (#1325).
 */
export const performanceTools: MCPTool[] = applySyntheticNotices(rawPerformanceTools, {
  performance_report:
    'CPU, memory and heap are measured from this process. Latency and throughput are NOT — they seed to constants and each call averages this tool\'s own prior outputs, so they describe no real request.',
});
