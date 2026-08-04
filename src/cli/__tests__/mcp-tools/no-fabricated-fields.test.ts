/**
 * Issues #1353 and #1354 — no registered MCP tool may return a field it did
 * not measure.
 *
 * #1324/#1325 labelled the tools that fabricated data. Labelling bought time;
 * it did not fix anything, and a notice on a *mixed* response is weak — it
 * cannot say which fields are real, so a caller either distrusts the genuine
 * measurement or consumes the fiction. These tests pin the two real exits:
 *
 * - **#1353 (delete)** — five tools whose entire output was invented and which
 *   had no consumer are gone from the registry, and must not come back.
 * - **#1354 (repair)** — three tools kept their measured half and lost the
 *   invented half. Each assertion below names the specific field that used to
 *   be fabricated, so a regression fails with the reason rather than a count.
 *
 * The load-bearing case is `system_health`: it previously could not report
 * ill-health at all (every status but one was the literal `'healthy'`), so the
 * test that matters is that a *failing* component now surfaces as failing.
 * "Returns a healthy result" would have passed against the broken version.
 *
 * Cross-platform (Rule #1): the only filesystem contact is a `mkdtemp` project
 * root assembled with `path.join`. No shell, no separator literal, no
 * platform-specific path. Every probe is mocked, so nothing here depends on a
 * daemon, a PID file, or a real database existing on the runner.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fakeProjectRoot = '';
vi.mock('../../services/project-root.js', () => ({
  findProjectRoot: () => fakeProjectRoot,
}));

// --- system_health probe doubles -------------------------------------------
// Each probe is stubbed so the test controls what "the component said" and can
// therefore assert the tool REPORTS what it observed rather than a literal.
const memoryProbe = vi.fn(async () => ({ initialized: true, version: '3.0.0' }));
const mcpProbe = vi.fn(async () => ({ running: true, transport: 'stdio', pid: 1234 }));
const daemonProbe = vi.fn((): number | null => 4321);
const swarmProbe = vi.fn((): boolean => true);

vi.mock('../../memory/memory-initializer.js', () => ({
  checkMemoryInitialization: (...args: unknown[]) => memoryProbe(...(args as [])),
}));
vi.mock('../../mcp-server.js', () => ({
  getMCPServerStatus: (...args: unknown[]) => mcpProbe(...(args as [])),
}));
vi.mock('../../services/daemon-lock.js', () => ({
  getDaemonLockHolder: (...args: unknown[]) => daemonProbe(...(args as [])),
}));
vi.mock('../../mcp-tools/swarm-coordinator-singleton.js', () => ({
  isSwarmCoordinatorInitialized: (...args: unknown[]) => swarmProbe(...(args as [])),
}));

// A deterministic embedding service, so neural_predict exercises its real
// branch without pulling in the fastembed model load.
vi.mock('../../embeddings/embedding-service.js', () => ({
  createEmbeddingServiceAsync: async () => ({
    provider: 'fake',
    embed: async (text: string) => ({
      embedding: Float32Array.from(
        { length: 384 },
        (_v, i) => ((text.charCodeAt(i % Math.max(text.length, 1)) || 0) % 97) / 97,
      ),
    }),
  }),
}));

import { hasTool } from '../../mcp-client.js';
import { systemTools } from '../../mcp-tools/system-tools.js';
import { neuralTools } from '../../mcp-tools/neural-tools.js';
import { performanceTools, readCpuUsagePercent } from '../../mcp-tools/performance-tools.js';
import type { MCPTool } from '../../mcp-tools/types.js';

const tool = (tools: MCPTool[], name: string): MCPTool => {
  const found = tools.find(t => t.name === name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return found;
};

const systemHealth = () => tool(systemTools, 'system_health');
const neuralPredict = () => tool(neuralTools, 'neural_predict');
const neuralStatus = () => tool(neuralTools, 'neural_status');
const perfReport = () => tool(performanceTools, 'performance_report');

const call = async (t: MCPTool, input: Record<string, unknown> = {}) =>
  (await t.handler(input)) as Record<string, unknown>;

beforeEach(() => {
  fakeProjectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-nofab-')));
  writeFileSync(join(fakeProjectRoot, 'package.json'), '{"name":"fake"}');
  memoryProbe.mockResolvedValue({ initialized: true, version: '3.0.0' });
  mcpProbe.mockResolvedValue({ running: true, transport: 'stdio', pid: 1234 });
  daemonProbe.mockReturnValue(4321);
  swarmProbe.mockReturnValue(true);
});

afterEach(() => {
  try { rmSync(fakeProjectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  fakeProjectRoot = '';
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// #1353 — deleted outright
// ---------------------------------------------------------------------------

describe('#1353 — tools that fabricated their entire output are unregistered', () => {
  const DELETED = [
    'github_repo_analyze',
    'github_pr_manage',
    'github_issue_track',
    'github_metrics',
    'neural_train',
  ];

  // Asserted against the real registry rather than a tool array: the registry
  // is what `tools/list` advertises to a consumer's Claude, so re-adding the
  // module to mcp-client.ts is exactly the regression worth catching.
  it.each(DELETED)('%s is not in the MCP tool registry', name => {
    expect(hasTool(name)).toBe(false);
  });

  it('still registers the neighbours that were kept', () => {
    // Guards against the mirror-image failure: deleting the file rather than
    // the tools, and taking the honest ones with it.
    expect(hasTool('neural_predict')).toBe(true);
    expect(hasTool('neural_patterns')).toBe(true);
    expect(hasTool('neural_status')).toBe(true);
    expect(hasTool('performance_benchmark')).toBe(true);
    expect(hasTool('system_health')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #1354 — system_health
// ---------------------------------------------------------------------------

describe('#1354 — system_health probes instead of asserting', () => {
  it('reports a failing component as unhealthy', async () => {
    // THE regression test. Pre-fix, `memory` was the literal 'healthy' and no
    // input could change it, so a broken memory database reported healthy.
    memoryProbe.mockResolvedValue({ initialized: false } as never);

    const result = await call(systemHealth());
    const checks = result.checks as Array<Record<string, unknown>>;
    const memory = checks.find(c => c.name === 'memory')!;

    expect(memory.status).toBe('unhealthy');
    expect(result.overall).not.toBe('healthy');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ component: 'memory' }),
    );
  });

  it('reports the same component as healthy when the probe succeeds', async () => {
    const checks = (await call(systemHealth())).checks as Array<Record<string, unknown>>;
    expect(checks.find(c => c.name === 'memory')!.status).toBe('healthy');
  });

  it('surfaces a thrown probe as unhealthy rather than swallowing it', async () => {
    memoryProbe.mockRejectedValue(new Error('database is locked'));

    const result = await call(systemHealth());
    const memory = (result.checks as Array<Record<string, unknown>>).find(c => c.name === 'memory')!;

    expect(memory.status).toBe('unhealthy');
    expect(String(memory.message)).toContain('database is locked');
  });

  it('does not count a lazily-started component as a failure', async () => {
    // The daemon and the swarm coordinator start on demand. Scoring a dormant
    // one as unhealthy would make every cold call read degraded, which is the
    // false-alarm mirror of the bug being fixed.
    daemonProbe.mockReturnValue(null);
    swarmProbe.mockReturnValue(false);

    const result = await call(systemHealth());
    const checks = result.checks as Array<Record<string, unknown>>;

    expect(checks.find(c => c.name === 'daemon')!.status).toBe('not-running');
    expect(checks.find(c => c.name === 'swarm')!.status).toBe('not-running');
    expect(result.notRunning).toBe(2);
    expect(result.overall).toBe('healthy');
    expect(result.score).toBe(100);
  });

  it('returns a null score when nothing judgeable was probed, never zero', async () => {
    // #1349's rule: a number that could not be measured is absent, not 0. A
    // zero score here would read as "everything is broken".
    daemonProbe.mockReturnValue(null);
    swarmProbe.mockReturnValue(false);

    const result = await call(systemHealth(), { components: ['daemon', 'swarm'] });

    expect(result.score).toBeNull();
    expect(result.overall).toBe('unknown');
  });

  it('honours the components filter instead of accepting and ignoring it', async () => {
    const result = await call(systemHealth(), { components: ['memory'] });
    const checks = result.checks as Array<Record<string, unknown>>;

    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe('memory');
    expect(mcpProbe).not.toHaveBeenCalled();
    expect(daemonProbe).not.toHaveBeenCalled();
  });

  it('echoes an unrecognised component rather than silently dropping it', async () => {
    const result = await call(systemHealth(), { components: ['memory', 'nonsense'] });
    expect(result.unknownComponents).toEqual(['nonsense']);
  });

  it('no longer advertises the parameters it used to ignore', () => {
    // `fix` was accepted and never honoured; `deep` only added three more
    // fabricated checks. Both are gone from the advertised schema.
    const properties = systemHealth().inputSchema.properties ?? {};
    expect(Object.keys(properties)).toEqual(['components']);
  });

  it('reports a latency per check that is a real elapsed measurement', async () => {
    const checks = (await call(systemHealth())).checks as Array<Record<string, unknown>>;
    for (const check of checks) {
      expect(typeof check.latencyMs).toBe('number');
      expect(check.latencyMs as number).toBeGreaterThanOrEqual(0);
      // Pre-fix these were `5 + Math.random() * 10` — a fractional draw with a
      // hardcoded floor, so a probe could never report 0 no matter how fast it
      // was. A rounded elapsed measurement can and does, which is the tell.
      expect(Number.isInteger(check.latencyMs)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// #1354 — neural_predict
// ---------------------------------------------------------------------------

describe('#1354 — neural_predict returns only the embedding it computes', () => {
  it('no longer returns predictions', async () => {
    const result = await call(neuralPredict(), { input: 'refactor the parser' });
    expect(result.predictions).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it('returns an embedding that actually depends on the input', async () => {
    // The old `predictions` were a fixed label list with random confidences —
    // identical inputs gave different answers and different inputs gave the
    // same ones. Both directions are pinned here.
    const a1 = await call(neuralPredict(), { input: 'alpha' });
    const a2 = await call(neuralPredict(), { input: 'alpha' });
    const b = await call(neuralPredict(), { input: 'a completely different string' });

    expect(a1.embedding).toEqual(a2.embedding);
    expect(a1.embedding).not.toEqual(b.embedding);
    expect(a1.embeddingDims).toBeGreaterThan(0);
  });

  it('refuses empty input rather than returning a random vector', async () => {
    // generateEmbedding treats a falsy string as "no text" and falls through
    // to `Math.random()`. `required: ['input']` does not prevent this — '' is
    // a string and satisfies it — so the guard lives in the handler.
    const result = await call(neuralPredict(), { input: '' });
    expect(result.success).toBe(false);
    expect(result.embedding).toBeUndefined();
    expect(String(result.error)).toContain('non-empty');
  });

  it('names the provider that produced the vector', async () => {
    const result = await call(neuralPredict(), { input: 'x' });
    expect(result.provider).toBe('embedding-service');
  });

  it('does not advertise a model it never had', () => {
    const properties = neuralPredict().inputSchema.properties ?? {};
    expect(properties.modelId).toBeUndefined();
    expect(properties.topK).toBeUndefined();
    expect(neuralPredict().description.toLowerCase()).not.toContain('prediction');
  });
});

describe('#1354 — neural_status drops the accuracy neural_train invented', () => {
  it('omits avgAccuracy', async () => {
    const models = (await call(neuralStatus())).models as Record<string, unknown>;
    expect(models.avgAccuracy).toBeUndefined();
    // The counts are true statements about local state and survive.
    expect(models.total).toBe(0);
  });

  it('strips accuracy from a legacy model record left on disk', async () => {
    // A consumer who ran neural_train before #1353 still has these rows. The
    // record is real; the accuracy in it never was.
    mkdirSync(join(fakeProjectRoot, '.moflo', 'neural'), { recursive: true });
    writeFileSync(
      join(fakeProjectRoot, '.moflo', 'neural', 'models.json'),
      JSON.stringify({
        version: '3.0.0',
        patterns: {},
        models: { 'legacy-1': { id: 'legacy-1', name: 'x', type: 'classifier', status: 'ready', accuracy: 0.93, epochs: 10, config: {} } },
      }),
    );

    const result = await call(neuralStatus(), { modelId: 'legacy-1' });
    const model = result.model as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(model.id).toBe('legacy-1');
    expect(model.accuracy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #1354 — performance_report
// ---------------------------------------------------------------------------

/**
 * Rule #1. `os.loadavg()` is documented as always returning [0, 0, 0] on
 * Windows, so the pre-fix formula produced `0.0%` there — an invented idle
 * reading on the one platform the maintainer's machine cannot observe.
 *
 * These assertions pass `platform` explicitly rather than forking on
 * `process.platform`, so all three platforms' behaviour is proven on whichever
 * runner executes the suite. A `process.platform === 'win32'` branch would be
 * dead code on the Ubuntu leg, which is how this class of bug ships green.
 */
describe('#1354 / Rule #1 — CPU usage is null where the platform cannot measure it', () => {
  it('returns null on Windows instead of a fabricated 0.0%', () => {
    expect(readCpuUsagePercent([0, 0, 0], 8, 'win32')).toBeNull();
  });

  it('returns a real percentage on Linux and macOS', () => {
    expect(readCpuUsagePercent([4, 2, 1], 8, 'linux')).toBeCloseTo(50);
    expect(readCpuUsagePercent([2, 1, 1], 8, 'darwin')).toBeCloseTo(25);
  });

  it('returns null rather than Infinity when os.cpus() reports no cores', () => {
    // os.cpus() is documented as possibly returning an empty array; the
    // pre-fix division by cpus.length would have produced Infinity.
    expect(readCpuUsagePercent([1, 1, 1], 0, 'linux')).toBeNull();
  });

  it('caps a saturated machine at 100 rather than reporting above it', () => {
    expect(readCpuUsagePercent([32, 30, 28], 8, 'linux')).toBe(100);
  });
});

describe('#1354 — performance_report returns only process measurements', () => {
  const FABRICATED = ['latency', 'throughput', 'errors', 'errorRate', 'status'];

  it('summary format carries no fabricated field', async () => {
    const result = await call(perfReport(), { format: 'summary' });
    for (const field of FABRICATED) {
      expect(result, `summary still returns ${field}`).not.toHaveProperty(field);
    }
    // What it genuinely measures survives. `os.totalmem`/`freemem`/
    // `process.memoryUsage` are real on all three platforms, so memory is
    // asserted unconditionally; CPU is platform-dependent — see below.
    expect(result.memory).toMatch(/MB \/ \d+MB$/);
    expect(result.heap).toMatch(/MB$/);
  });

  it('reports CPU as measured on Unix and as not-measured on Windows (Rule #1)', async () => {
    // `os.loadavg()` is Unix-only; Node documents it as always [0, 0, 0] on
    // Windows. The pre-fix `(loadAvg[0] / cores) * 100` therefore rendered a
    // confident "0.0%" on every Windows consumer. Branching here rather than
    // asserting one shape is the point: the correct output DIFFERS by platform,
    // and a test that assumed Unix would have shipped the Windows bug green.
    const result = await call(perfReport(), { format: 'summary' });

    if (process.platform === 'win32') {
      expect(result.cpu).toBe('not measured');
      expect(result.cpu).not.toMatch(/^0\.0%$/);
    } else {
      expect(result.cpu).toMatch(/^\d+(\.\d+)?%$/);
    }
  });

  it('drops the load average rather than reporting three zeros on Windows', async () => {
    const result = await call(perfReport(), { format: 'detailed' });
    const system = result.system as Record<string, unknown>;

    if (process.platform === 'win32') {
      expect(system.loadAverage).toBeNull();
    } else {
      expect(Array.isArray(system.loadAverage)).toBe(true);
    }
  });

  it('detailed format carries no fabricated field, including in trends', async () => {
    const result = await call(perfReport(), { format: 'detailed' });
    const current = result.current as Record<string, unknown>;
    for (const field of FABRICATED) {
      expect(current, `current still returns ${field}`).not.toHaveProperty(field);
    }
    expect(result.trends).not.toHaveProperty('latency');
    expect(current.cpu).toBeDefined();
    expect(current.memory).toBeDefined();
  });

  it('does not replay fabricated fields from history written before this fix', async () => {
    // Narrowing the TypeScript interface does not narrow JSON already on a
    // consumer's disk, and `history` returns stored samples verbatim — so
    // without an explicit projection the old keys keep surfacing after upgrade.
    const metricsPath = join(fakeProjectRoot, '.moflo', 'performance', 'metrics.json');
    mkdirSync(join(fakeProjectRoot, '.moflo', 'performance'), { recursive: true });
    writeFileSync(metricsPath, JSON.stringify({
      version: '3.0.0',
      benchmarks: {},
      metrics: [{
        timestamp: '2026-01-01T00:00:00.000Z',
        cpu: { usage: 10, cores: 4 },
        memory: { used: 100, total: 200, heap: 50 },
        latency: { avg: 50, p50: 40, p95: 100, p99: 200 },
        throughput: { requests: 7, operations: 70 },
        errors: { count: 0, rate: 0 },
      }],
    }));

    const result = await call(perfReport(), { format: 'detailed' });
    const history = result.history as Array<Record<string, unknown>>;

    expect(history.length).toBeGreaterThanOrEqual(2);
    for (const sample of history) {
      expect(sample).not.toHaveProperty('latency');
      expect(sample).not.toHaveProperty('throughput');
      expect(sample).not.toHaveProperty('errors');
    }

    // And the projection is persisted, so the stale keys do not linger on disk.
    const persisted = JSON.parse(readFileSync(metricsPath, 'utf-8')) as {
      metrics: Array<Record<string, unknown>>;
    };
    for (const sample of persisted.metrics) {
      expect(sample).not.toHaveProperty('latency');
    }
  });
});
