/**
 * Tests for the Memory Access Functional doctor check (issue #844).
 *
 * Validates the structural contract (return shape, detail records, degraded
 * states) and the end-to-end behavior against the real memory subsystem +
 * coordinator. The memory round-trip is exercised through the actual
 * memory_store / memory_search MCP tool handlers — no mocks.
 */

import { describe, expect, it } from 'vitest';
import {
  checkMemoryAccessFunctional,
} from '../commands/doctor-checks-memory-access.js';
import type { FunctionalHealthCheck } from '../commands/doctor-checks-swarm.js';

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
