/**
 * Tests for the Memory Access Functional doctor check (issue #844).
 *
 * Validates the structural contract (return shape, detail records, degraded
 * states) and the end-to-end behavior against the real memory subsystem +
 * coordinator. The memory round-trip is exercised through the actual
 * memory_store / memory_search MCP tool handlers — no mocks.
 *
 * Isolation note (#1022): the probe's bridge writes through `atomicWriteFileSync`
 * targeting `<projectRoot>/.moflo/moflo.db`. Under `npm test` an earlier suite
 * may have triggered the auto-started daemon, which holds the canonical DB
 * open with a non-shareable handle on Windows — and the probe's rename then
 * fails with EPERM. We redirect `CLAUDE_PROJECT_DIR` to a per-suite temp dir
 * so the probe never collides with the live daemon's DB. No production code
 * change — the runtime contract ("daemon owns the canonical DB") is honored;
 * only the test environment moves out of the way.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  _runMemoryRoundTripForTest,
  checkMemoryAccessFunctional,
} from '../commands/doctor-checks-memory-access.js';
import type { FunctionalCheckDetail, FunctionalHealthCheck, ToolHandler } from '../commands/doctor-checks-functional-shared.js';
import { findMofloPackageRoot } from '../services/moflo-require.js';

let tempProjectDir: string | undefined;
let originalProjectDir: string | undefined;
let originalDisableRouting: string | undefined;

/**
 * Reset the dist bridge-core module's cached project root and registry so
 * the env var change takes effect. The probe's MCP tool handlers load from
 * `dist/`, so we must reset the same module instance — not the source
 * import. Best-effort: skipped if dist isn't built (the suite degrades to
 * the "not built" warn path anyway).
 */
async function resetDistBridgeState(): Promise<void> {
  const root = findMofloPackageRoot();
  if (!root) return;
  const bridgeCorePath = join(root, 'dist/src/cli/memory/bridge-core.js');
  if (!existsSync(bridgeCorePath)) return;
  const bc = await import(pathToFileURL(bridgeCorePath).href) as {
    shutdownBridge?: () => Promise<void>;
    _resetProjectRootForTest?: () => void;
  };
  if (bc.shutdownBridge) await bc.shutdownBridge();
  bc._resetProjectRootForTest?.();
}

beforeAll(async () => {
  tempProjectDir = mkdtempSync(join(tmpdir(), 'doctor-memprobe-'));
  // `.moflo/` is created by `persistBridgeDb` on first write; no pre-seed needed.
  // Bridge resolves project root from CLAUDE_PROJECT_DIR directly — no marker
  // file lookup happens when the env var is set.

  originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
  originalDisableRouting = process.env.MOFLO_DISABLE_DAEMON_ROUTING;
  process.env.CLAUDE_PROJECT_DIR = tempProjectDir;
  // Belt: even if the daemon is up, we want every write to go through
  // the bridge into the temp DB — never the live daemon's canonical one.
  process.env.MOFLO_DISABLE_DAEMON_ROUTING = '1';

  // Symmetric with afterAll: a genuine dist load error shouldn't abort the
  // entire suite with an opaque message — let the test bodies surface the
  // real problem (e.g. via the "not built" warn path).
  await resetDistBridgeState().catch(() => { /* best-effort */ });
});

afterAll(async () => {
  // Reset again so subsequent tests in the same vitest worker don't see
  // a cached registry pointing at the deleted temp dir.
  await resetDistBridgeState().catch(() => { /* best-effort */ });

  if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;

  if (originalDisableRouting === undefined) delete process.env.MOFLO_DISABLE_DAEMON_ROUTING;
  else process.env.MOFLO_DISABLE_DAEMON_ROUTING = originalDisableRouting;

  if (tempProjectDir) {
    try { rmSync(tempProjectDir, { recursive: true, force: true }); }
    catch { /* Windows EBUSY at process teardown is benign — see #1018 */ }
  }
});

function expectFunctionalShape(result: FunctionalHealthCheck) {
  expect(result.name).toBe('Memory Access Functional');
  expect(['pass', 'warn', 'fail']).toContain(result.status);
  expect(result.message.length).toBeGreaterThan(0);
}

describe('doctor-checks-memory-access', () => {
  it('returns a HealthCheck with details when modules are built', { timeout: 60_000 }, async () => {
    const result = await checkMemoryAccessFunctional();
    expectFunctionalShape(result);

    // When the dist is built, every subcheck has structured details. Without
    // dist the check degrades to a single 'warn' with no details — same
    // contract as the other functional checks.
    if (result.status === 'pass' || result.status === 'fail') {
      expect(Array.isArray(result.details)).toBe(true);
      expect(result.details!.length).toBeGreaterThan(0);
      for (const d of result.details!) {
        expect(d.id).toBeTruthy();
        expect(d.mcpTool).toBeTruthy();
        expect(['pass', 'warn', 'fail']).toContain(d.status);
        expect(d.expected).toBeTruthy();
      }
    }
  });

  it('passes (or degrades to warn) against the real memory subsystem', { timeout: 60_000 }, async () => {
    const result = await checkMemoryAccessFunctional();

    // Dist not built → not-built warn; fine.
    if (result.status === 'warn' && /not built/i.test(result.message)) {
      return;
    }

    expect(
      result.status,
      `expected pass, got ${result.status}: ${result.message}`,
    ).toBe('pass');

    const details = result.details ?? [];
    const ids = details.map(d => d.id);

    // The subagent probe is unconditional — any healthy install must pass it.
    expect(ids).toContain('subagent.memory_store');
    expect(ids).toContain('subagent.memory_search');
    expect(ids).toContain('subagent.search-finds-key');
    expect(ids).toContain('subagent.retrieve-roundtrip');

    // Subagent probe must never fail when the install is healthy.
    const subagentFails = details.filter(d => d.id.startsWith('subagent.') && d.status === 'fail');
    expect(
      subagentFails,
      `subagent subcheck failures: ${JSON.stringify(subagentFails, null, 2)}`,
    ).toHaveLength(0);
  });

  it('exercises swarm-agent and hive-mind contexts when coordinator is available', { timeout: 60_000 }, async () => {
    const result = await checkMemoryAccessFunctional();
    if (result.status === 'warn' && /not built/i.test(result.message)) return;

    const ids = (result.details ?? []).map(d => d.id);

    // Both swarm-agent and hive-mind-worker probes should appear in the
    // detail set on a healthy install. They may be 'warn' if coordinator
    // setup degrades, but the persona probe must be present.
    const hasSwarm = ids.some(id => id.startsWith('swarm-agent.'));
    const hasHive = ids.some(id => id.startsWith('hive-mind-worker.'));
    expect(hasSwarm, `expected at least one swarm-agent.* detail; got: ${ids.join(', ')}`).toBe(true);
    expect(hasHive, `expected at least one hive-mind-worker.* detail; got: ${ids.join(', ')}`).toBe(true);
  });

  it('asserts hasEmbedding=true and HNSW backend on a passing run', { timeout: 60_000 }, async () => {
    const result = await checkMemoryAccessFunctional();
    if (result.status === 'warn' && /not built/i.test(result.message)) return;

    const storeDetail = (result.details ?? []).find(d => d.id === 'subagent.memory_store');
    expect(storeDetail).toBeDefined();
    if (storeDetail?.status === 'pass') {
      const observed = storeDetail.observed as { hasEmbedding?: boolean; embeddingDimensions?: number; backend?: string };
      expect(observed.hasEmbedding).toBe(true);
      expect(typeof observed.embeddingDimensions).toBe('number');
      expect(observed.embeddingDimensions).toBeGreaterThan(0);
      expect(observed.backend).toMatch(/HNSW/);
    }
  });

  it('search detail records the live HNSW backend (catches plain sql.js fallback)', { timeout: 60_000 }, async () => {
    const result = await checkMemoryAccessFunctional();
    if (result.status === 'warn' && /not built/i.test(result.message)) return;

    const searchDetail = (result.details ?? []).find(d => d.id === 'subagent.memory_search');
    expect(searchDetail).toBeDefined();
    if (searchDetail?.status === 'pass') {
      const observed = searchDetail.observed as { backend?: string; total?: number; topKey?: string };
      expect(observed.backend).toMatch(/HNSW/);
      expect(observed.total).toBeGreaterThanOrEqual(1);
      expect(observed.topKey).toMatch(/^doctor-memprobe-subagent-/);
    }
  });

  it('cleans up after itself — no orphan doctor-memprobe rows in memory_list', { timeout: 60_000 }, async () => {
    // Run the check, then sweep memory_list for any rows left behind.
    // safeDelete inside the check is best-effort but on the happy path
    // every probe should leave zero rows.
    const result = await checkMemoryAccessFunctional();
    if (result.status === 'warn' && /not built/i.test(result.message)) return;

    // Re-run the check to also sweep any stragglers from previous test runs
    // before asserting.
    await checkMemoryAccessFunctional();

    const { findMofloPackageRoot } = await import('../services/moflo-require.js');
    const { pathToFileURL } = await import('url');
    const { existsSync } = await import('fs');
    const { join } = await import('path');
    const root = findMofloPackageRoot();
    if (!root) return;
    const memToolsPath = join(root, 'dist/src/cli/mcp-tools/memory-tools.js');
    if (!existsSync(memToolsPath)) return;
    const { memoryTools } = await import(pathToFileURL(memToolsPath).href);
    const list = memoryTools.find((t: { name: string }) => t.name === 'memory_list');
    if (!list?.handler) return;

    // Search across all probe namespaces.
    for (const ns of ['doctor-memprobe-subagent', 'doctor-memprobe-swarm-agent', 'doctor-memprobe-hive-mind-worker']) {
      const out = await list.handler({ namespace: ns, limit: 100 });
      const remaining = (out as { entries?: Array<{ key: string }>; results?: Array<{ key: string }> }).entries
        ?? (out as { results?: Array<{ key: string }> }).results
        ?? [];
      expect(
        remaining.length,
        `${ns} has ${remaining.length} stragglers after cleanup: ${remaining.map(e => e.key).join(', ')}`,
      ).toBe(0);
    }
  });
});

/**
 * #1111 regression: on a fresh consumer install, pretrain seeds the DB
 * asynchronously and the HNSW index can be empty (`0 vectors indexed`) when
 * `flo doctor` runs. The probe's `memory_store` returns hasEmbedding=true,
 * but `memory_search` returns 0 results — historically that failed the
 * Memory Access Functional check ~2/3 of the time on the smoke harness.
 *
 * Fix (a) from the issue: when search returns 0, do a literal-key fallback
 * via `memory_retrieve`. If the row is reachable, demote the search subcheck
 * to `warn` (memory access works; only the vector index is unpopulated).
 *
 * The behavior is tested with a synthetic memoryTools array so the test
 * doesn't depend on a real fresh-install timing window.
 */
describe('doctor-checks-memory-access — #1111 HNSW-empty fallback', () => {
  function buildEmptyHnswTools(opts: { retrieveFinds: boolean }): ToolHandler[] {
    const stored = new Map<string, { value: unknown }>();
    return [
      {
        name: 'memory_store',
        handler: async (input) => {
          const k = `${(input.namespace as string) ?? 'default'}::${input.key as string}`;
          stored.set(k, { value: input.value });
          return {
            success: true,
            key: input.key,
            namespace: input.namespace,
            hasEmbedding: true,
            embeddingDimensions: 384,
            backend: 'node:sqlite + HNSW',
          };
        },
      },
      {
        name: 'memory_search',
        // The race: store succeeded, but HNSW has 0 vectors so search
        // returns empty. Matches the production failure mode in #1111.
        handler: async () => ({ results: [], total: 0, backend: 'node:sqlite + HNSW' }),
      },
      {
        name: 'memory_retrieve',
        handler: async (input) => {
          if (!opts.retrieveFinds) return { key: input.key, namespace: input.namespace, value: null, found: false };
          const k = `${(input.namespace as string) ?? 'default'}::${input.key as string}`;
          const row = stored.get(k);
          if (!row) return { key: input.key, namespace: input.namespace, value: null, found: false };
          // Echo the same shape the probe expects (sentinel-bearing object).
          return { key: input.key, namespace: input.namespace, value: row.value, found: true };
        },
      },
      {
        name: 'memory_delete',
        handler: async () => ({ success: true }),
      },
    ];
  }

  it('demotes memory_search to warn when search is empty but literal retrieve finds the row', async () => {
    const details: FunctionalCheckDetail[] = [];
    await _runMemoryRoundTripForTest({
      persona: 'unit', idPrefix: 'unit',
      memoryTools: buildEmptyHnswTools({ retrieveFinds: true }),
      details,
    });

    const searchDetail = details.find(d => d.id === 'unit.memory_search');
    expect(searchDetail, 'memory_search subcheck must be recorded').toBeDefined();
    expect(searchDetail!.status, `expected warn, got ${searchDetail!.status}: ${searchDetail!.message}`).toBe('warn');
    expect(searchDetail!.message).toMatch(/HNSW index not yet populated|pretrain/i);

    // search-finds-key must NOT fail when the race has been detected — it
    // would be a redundant fail on the same root cause. Demote to warn.
    const findsKeyDetail = details.find(d => d.id === 'unit.search-finds-key');
    expect(findsKeyDetail, 'search-finds-key subcheck must be recorded').toBeDefined();
    expect(findsKeyDetail!.status).toBe('warn');

    // The literal retrieve subcheck must still pass — that's the proof
    // memory access works even when HNSW is empty.
    const retrieveDetail = details.find(d => d.id === 'unit.retrieve-roundtrip');
    expect(retrieveDetail).toBeDefined();
    expect(retrieveDetail!.status).toBe('pass');

    // No fail rows — the whole point of the fix.
    expect(details.filter(d => d.status === 'fail')).toHaveLength(0);
  });

  it('keeps memory_search as fail when both search AND retrieve come back empty', async () => {
    const details: FunctionalCheckDetail[] = [];
    await _runMemoryRoundTripForTest({
      persona: 'unit', idPrefix: 'unit',
      memoryTools: buildEmptyHnswTools({ retrieveFinds: false }),
      details,
    });

    // Real memory-access regression: row was supposedly stored but neither
    // semantic nor literal access can find it. Must still fail.
    const searchDetail = details.find(d => d.id === 'unit.memory_search');
    expect(searchDetail).toBeDefined();
    expect(searchDetail!.status).toBe('fail');
  });
});

/**
 * #1120 regression: same bug class as #1111, but the search returns a
 * non-empty result set that doesn't include the just-stored key — typical
 * when the doctor probe runs 2+ times in the same session and the namespace
 * still has rows from previous runs (safeDelete is best-effort). The new
 * write hasn't propagated to the HNSW index yet, so search returns a stale
 * neighbor as the top hit. #1111's fallback only fired on `total === 0`, so
 * this case slipped through as `fail` — even though the row IS in the DB
 * and the memory access path is working.
 *
 * Fix: extend the literal-key fallback to the non-zero-results case. If our
 * key isn't in the search results AND literal retrieve finds it, demote
 * `search-finds-key` to warn (matching the spirit of #1111: distinguish
 * stack-broken from stack-working-but-state-not-yet-ready). `memory_search`
 * itself stays pass — total>=1 with HNSW backend is a healthy search.
 */
describe('doctor-checks-memory-access — #1120 stale-neighbor fallback', () => {
  function buildStaleNeighborTools(opts: { retrieveFinds: boolean }): ToolHandler[] {
    const stored = new Map<string, { value: unknown }>();
    const stalePriorKey = 'doctor-memprobe-unit-OLD-stale-row';
    return [
      {
        name: 'memory_store',
        handler: async (input) => {
          const k = `${(input.namespace as string) ?? 'default'}::${input.key as string}`;
          stored.set(k, { value: input.value });
          return {
            success: true,
            key: input.key,
            namespace: input.namespace,
            hasEmbedding: true,
            embeddingDimensions: 384,
            backend: 'node:sqlite + HNSW',
          };
        },
      },
      {
        name: 'memory_search',
        // The race: store succeeded, but HNSW returns a stale neighbor from
        // a prior probe run and not the just-written row. Matches the
        // production failure mode in #1120.
        handler: async (input) => ({
          results: [{
            key: stalePriorKey,
            namespace: (input.namespace as string) ?? 'default',
            value: 'stale prior probe value',
            similarity: 0.3,
          }],
          total: 1,
          backend: 'node:sqlite + HNSW',
        }),
      },
      {
        name: 'memory_retrieve',
        handler: async (input) => {
          if (!opts.retrieveFinds) return { key: input.key, namespace: input.namespace, value: null, found: false };
          const k = `${(input.namespace as string) ?? 'default'}::${input.key as string}`;
          const row = stored.get(k);
          if (!row) return { key: input.key, namespace: input.namespace, value: null, found: false };
          return { key: input.key, namespace: input.namespace, value: row.value, found: true };
        },
      },
      {
        name: 'memory_delete',
        handler: async () => ({ success: true }),
      },
    ];
  }

  it('demotes search-finds-key to warn when search returned wrong rows but literal retrieve finds our key', async () => {
    const details: FunctionalCheckDetail[] = [];
    await _runMemoryRoundTripForTest({
      persona: 'unit', idPrefix: 'unit',
      memoryTools: buildStaleNeighborTools({ retrieveFinds: true }),
      details,
    });

    // memory_search subcheck stays pass — total>=1, HNSW backend, threshold
    // honored. The bug only manifests at the search-finds-key subcheck.
    const searchDetail = details.find(d => d.id === 'unit.memory_search');
    expect(searchDetail, 'memory_search subcheck must be recorded').toBeDefined();
    expect(
      searchDetail!.status,
      `expected pass, got ${searchDetail!.status}: ${searchDetail!.message}`,
    ).toBe('pass');

    // search-finds-key demoted to warn (the new #1120 fallback path).
    const findsKeyDetail = details.find(d => d.id === 'unit.search-finds-key');
    expect(findsKeyDetail, 'search-finds-key subcheck must be recorded').toBeDefined();
    expect(
      findsKeyDetail!.status,
      `expected warn, got ${findsKeyDetail!.status}: ${findsKeyDetail!.message}`,
    ).toBe('warn');
    expect(findsKeyDetail!.message).toMatch(/stale-neighbor|literal retrieve|not yet propagated/i);

    // retrieve-roundtrip still passes — proof memory access works even when
    // the HNSW index is racing the new write.
    const retrieveDetail = details.find(d => d.id === 'unit.retrieve-roundtrip');
    expect(retrieveDetail).toBeDefined();
    expect(retrieveDetail!.status).toBe('pass');

    // No fail rows — the whole point of the fix.
    expect(details.filter(d => d.status === 'fail')).toHaveLength(0);
  });

  it('keeps search-finds-key as fail when neither search nor literal retrieve find our key', async () => {
    const details: FunctionalCheckDetail[] = [];
    await _runMemoryRoundTripForTest({
      persona: 'unit', idPrefix: 'unit',
      memoryTools: buildStaleNeighborTools({ retrieveFinds: false }),
      details,
    });

    // Real memory-access regression: row was supposedly stored but neither
    // semantic nor literal access can find our specific key. Must still fail.
    const findsKeyDetail = details.find(d => d.id === 'unit.search-finds-key');
    expect(findsKeyDetail).toBeDefined();
    expect(findsKeyDetail!.status).toBe('fail');
    expect(findsKeyDetail!.message).toMatch(/not in results/i);
  });
});
