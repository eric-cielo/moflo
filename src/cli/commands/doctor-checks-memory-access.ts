/**
 * Functional Doctor Check for Memory Access (issue #844)
 *
 * Validates the `memory_store` + `memory_search` round-trip from each of the
 * three actor contexts whose memory access has historically regressed:
 *
 *   1. Subagent — direct MCP tool path with no swarm/hive setup.
 *   2. Swarm agent — same calls after `swarm_init` + `agent_spawn`,
 *      proving coordinator state doesn't break memory access.
 *   3. Hive-mind worker — same calls after `hive-mind_init` +
 *      `hive-mind_spawn`, proving MessageBus/adapter init doesn't break it.
 *
 * Each probe stores a unique sentinel and asserts that:
 *   - `memory_store` returns success=true with hasEmbedding=true (catches
 *     hash-embedder fallback) and a numeric embeddingDimensions.
 *   - `memory_search(threshold:0)` returns the row at top with backend
 *     including `HNSW` (catches plain sql.js fallback and the #837 regression
 *     where threshold:0 was coerced to 0.3).
 *   - The returned value's sentinel matches what was stored (catches write
 *     clobber + namespace bleed).
 *
 * Cleanup runs even on assertion failure so a fail doesn't leave orphaned
 * agents/hive workers.
 */

import { errorDetail } from '../shared/utils/error-detail.js';
import {
  findModule,
  toImportUrl,
  type HealthCheck,
} from './doctor-checks-deep.js';
import type {
  FunctionalCheckDetail,
  FunctionalHealthCheck,
} from './doctor-checks-swarm.js';

interface ToolHandler {
  name: string;
  handler?: (input: Record<string, unknown>, ctx?: unknown) => Promise<unknown>;
}

const MEMORY_ACCESS_CHECK = 'Memory Access Functional';

async function loadToolArrays(
  rels: Record<string, string>,
): Promise<Record<string, ToolHandler[]> | null> {
  const paths: Record<string, string> = {};
  for (const [k, rel] of Object.entries(rels)) {
    const p = findModule(rel);
    if (!p) return null;
    paths[k] = p;
  }
  const entries = await Promise.all(
    Object.entries(paths).map(async ([k, p]) => [k, await import(toImportUrl(p))] as const),
  );
  const out: Record<string, ToolHandler[]> = {};
  for (const [k, mod] of entries) {
    const arrName = Object.keys(mod).find(
      name =>
        Array.isArray(mod[name]) &&
        mod[name].every((t: unknown) => typeof (t as ToolHandler)?.name === 'string'),
    );
    if (!arrName) return null;
    out[k] = mod[arrName] as ToolHandler[];
  }
  return out;
}

function getTool(tools: ToolHandler[], name: string): ToolHandler | undefined {
  return tools.find(t => t.name === name);
}

async function invokeOrThrow(
  tools: ToolHandler[],
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const tool = getTool(tools, name);
  if (!tool?.handler) throw new Error(`MCP tool "${name}" not registered`);
  return tool.handler(input);
}

interface StoreOut {
  success?: boolean;
  hasEmbedding?: boolean;
  embeddingDimensions?: number | null;
  backend?: string;
  error?: string;
}

interface SearchOut {
  results?: Array<{ key: string; namespace: string; value: unknown; similarity: number }>;
  total?: number;
  backend?: string;
  error?: string;
}

interface RoundTripContext {
  /** Persona label, e.g. "subagent". */
  persona: string;
  /** Sub-check id prefix for FunctionalCheckDetail rows. */
  idPrefix: string;
  /** MCP tools array — must include memory_store, memory_search, memory_delete. */
  memoryTools: ToolHandler[];
  /** Output sink for FunctionalCheckDetail rows. */
  details: FunctionalCheckDetail[];
}

/**
 * Run a memory_store + memory_search round-trip and append three details
 * (store, search, value-match). Returns the unique key/namespace used so the
 * caller can clean up. Never throws — assertion failures land in `details`.
 */
async function runMemoryRoundTrip(ctx: RoundTripContext): Promise<{ key: string; namespace: string }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const key = `doctor-memprobe-${ctx.persona}-${stamp}`;
  const namespace = `doctor-memprobe-${ctx.persona}`;
  const sentinel = `memprobe-${ctx.persona}-${stamp}`;

  // 1. memory_store — must come back with success=true and a real embedding.
  let storeOut: StoreOut | undefined;
  try {
    storeOut = (await invokeOrThrow(ctx.memoryTools, 'memory_store', {
      key,
      value: { sentinel, persona: ctx.persona },
      namespace,
    })) as StoreOut;
    const failReason = (() => {
      if (!storeOut?.success) return `memory_store returned success=false: ${storeOut?.error ?? JSON.stringify(storeOut)}`;
      if (storeOut.hasEmbedding !== true) return 'hasEmbedding=false — embedder is not wired (likely missing fastembed) or fell back to hash embeddings';
      if (typeof storeOut.embeddingDimensions !== 'number' || storeOut.embeddingDimensions <= 0) {
        return `embeddingDimensions invalid (${storeOut.embeddingDimensions}) — embedder not producing real vectors`;
      }
      if (!storeOut.backend?.includes('HNSW')) return `backend "${storeOut.backend}" does not include HNSW — index may have fallen back to plain sql.js`;
      return null;
    })();
    ctx.details.push(
      failReason
        ? { id: `${ctx.idPrefix}.memory_store`, mcpTool: 'memory_store', status: 'fail', observed: storeOut, expected: 'success=true, hasEmbedding=true, backend includes HNSW', message: failReason }
        : { id: `${ctx.idPrefix}.memory_store`, mcpTool: 'memory_store', status: 'pass', observed: storeOut, expected: 'success=true, hasEmbedding=true, backend includes HNSW' },
    );
  } catch (err) {
    const detail = errorDetail(err, { firstLineOnly: true });
    ctx.details.push({
      id: `${ctx.idPrefix}.memory_store`, mcpTool: 'memory_store', status: 'fail',
      observed: { error: detail }, expected: 'success=true with embedding', message: `handler threw: ${detail}`,
    });
    return { key, namespace };
  }

  // 2. memory_search with threshold=0 — must find the row we just stored.
  // threshold=0 is the explicit "no threshold" value (#837); regressions
  // there silently filter out matches even when the row is in the index.
  let searchOut: SearchOut | undefined;
  try {
    searchOut = (await invokeOrThrow(ctx.memoryTools, 'memory_search', {
      query: sentinel,
      namespace,
      threshold: 0,
      limit: 5,
    })) as SearchOut;
    const failReason = (() => {
      if (searchOut?.error) return `search returned error: ${searchOut.error}`;
      if (!searchOut?.backend?.includes('HNSW')) return `backend "${searchOut?.backend}" does not include HNSW`;
      if (typeof searchOut.total !== 'number') return 'total field missing';
      if (searchOut.total === 0 || !searchOut.results || searchOut.results.length === 0) {
        return 'search returned 0 results despite an explicit threshold=0 — bridge embedder may be unwired (#837) or the row never reached the HNSW index';
      }
      return null;
    })();
    ctx.details.push(
      failReason
        ? { id: `${ctx.idPrefix}.memory_search`, mcpTool: 'memory_search', status: 'fail', observed: searchOut, expected: 'total>=1 with backend including HNSW', message: failReason }
        : { id: `${ctx.idPrefix}.memory_search`, mcpTool: 'memory_search', status: 'pass', observed: { total: searchOut.total, backend: searchOut.backend, topKey: searchOut.results?.[0]?.key }, expected: 'total>=1 with backend including HNSW' },
    );
  } catch (err) {
    const detail = errorDetail(err, { firstLineOnly: true });
    ctx.details.push({
      id: `${ctx.idPrefix}.memory_search`, mcpTool: 'memory_search', status: 'fail',
      observed: { error: detail }, expected: 'total>=1', message: `handler threw: ${detail}`,
    });
    return { key, namespace };
  }

  // 3. The just-stored row must come back at the top of search results so
  // callers can find what they wrote. memory_search returns a content snippet
  // (truncated to 60 chars), so it's not the right tool for full-value
  // verification — that's `memory_retrieve` (next subcheck).
  const top = searchOut.results?.find(r => r.key === key);
  const presenceFailReason = top
    ? null
    : `stored key ${key} not in results (got: ${searchOut?.results?.map(r => r.key).join(', ') ?? 'none'})`;
  ctx.details.push(
    presenceFailReason
      ? { id: `${ctx.idPrefix}.search-finds-key`, mcpTool: 'memory_search', status: 'fail', observed: { topKey: top?.key, allKeys: searchOut.results?.map(r => r.key) }, expected: `result containing key=${key}`, message: presenceFailReason }
      : { id: `${ctx.idPrefix}.search-finds-key`, mcpTool: 'memory_search', status: 'pass', observed: { topKey: top!.key, similarity: top!.similarity }, expected: `result containing key=${key}` },
  );

  // 4. memory_retrieve returns the full value (search content is truncated to
  // a 60-char snippet, so we use the by-key retrieve to validate sentinel).
  // Catches write clobber and namespace bleed — we get back exactly what we
  // wrote, not someone else's row stored under the same key.
  try {
    const retrieveOut = (await invokeOrThrow(ctx.memoryTools, 'memory_retrieve', { key, namespace })) as {
      found?: boolean;
      value?: { sentinel?: string; persona?: string } | string | null;
    };
    const failReason = (() => {
      if (!retrieveOut?.found) return `retrieve returned found=false for key=${key} — write didn't persist`;
      const v = retrieveOut.value;
      const observedSentinel = typeof v === 'object' && v !== null ? v.sentinel : undefined;
      if (observedSentinel !== sentinel) {
        return `expected sentinel="${sentinel}", got ${JSON.stringify(observedSentinel)} — possible write clobber or namespace bleed`;
      }
      return null;
    })();
    ctx.details.push(
      failReason
        ? { id: `${ctx.idPrefix}.retrieve-roundtrip`, mcpTool: 'memory_retrieve', status: 'fail', observed: retrieveOut, expected: `value.sentinel=${sentinel}`, message: failReason }
        : { id: `${ctx.idPrefix}.retrieve-roundtrip`, mcpTool: 'memory_retrieve', status: 'pass', observed: { found: true, sentinelMatched: true }, expected: `value.sentinel=${sentinel}` },
    );
  } catch (err) {
    const detail = errorDetail(err, { firstLineOnly: true });
    ctx.details.push({
      id: `${ctx.idPrefix}.retrieve-roundtrip`, mcpTool: 'memory_retrieve', status: 'fail',
      observed: { error: detail }, expected: `value.sentinel=${sentinel}`, message: `handler threw: ${detail}`,
    });
  }

  return { key, namespace };
}

async function safeDelete(memoryTools: ToolHandler[], key: string, namespace: string): Promise<void> {
  try { await invokeOrThrow(memoryTools, 'memory_delete', { key, namespace }); } catch { /* best-effort */ }
}

function summarize(name: string, details: FunctionalCheckDetail[]): FunctionalHealthCheck {
  const fails = details.filter(d => d.status === 'fail');
  const warns = details.filter(d => d.status === 'warn');
  if (fails.length > 0) {
    const first = fails[0];
    return {
      name, status: 'fail',
      message: `${fails.length}/${details.length} subcheck(s) failed (e.g. ${first.id} via ${first.mcpTool}: ${first.message ?? first.expected})`,
      fix: 'Run `flo doctor --json` for per-subcheck details. Common fixes: ensure fastembed installed (memory_store.hasEmbedding=false), explicit threshold:0 honored (#837), or rebuild HNSW index (`flo memory rebuild-index`)',
      details,
    };
  }
  if (warns.length > 0) {
    return {
      name, status: 'warn',
      message: `${details.length - warns.length}/${details.length} pass; ${warns.length} degraded`,
      details,
    };
  }
  return {
    name, status: 'pass',
    message: `${details.length} subchecks OK (memory_store + memory_search round-trip verified across subagent, swarm-agent, and hive-mind contexts)`,
    details,
  };
}

export async function checkMemoryAccessFunctional(): Promise<FunctionalHealthCheck> {
  const details: FunctionalCheckDetail[] = [];

  const mods = await loadToolArrays({
    memoryTools: 'dist/src/cli/mcp-tools/memory-tools.js',
    swarmTools: 'dist/src/cli/mcp-tools/swarm-tools.js',
    agentTools: 'dist/src/cli/mcp-tools/agent-tools.js',
    hiveMindTools: 'dist/src/cli/mcp-tools/hive-mind-tools.js',
  });
  if (!mods) {
    return {
      name: MEMORY_ACCESS_CHECK,
      status: 'warn',
      message: 'memory/swarm/agent/hive-mind tool modules not built',
      fix: 'npm run build',
    };
  }
  const { memoryTools, swarmTools, agentTools, hiveMindTools } = mods;

  // Track keys + setup state so cleanup runs regardless of pass/fail.
  const cleanups: Array<() => Promise<void>> = [];
  let spawnedAgentId: string | undefined;
  let hiveInitialized = false;

  try {
    // ── Probe 1: subagent context ─────────────────────────────────────────
    // The "subagent" path is what Claude's Task tool ends up calling: direct
    // MCP tools with no surrounding coordinator state. Failures here indicate
    // the memory subsystem itself is broken before we even get to coordinator
    // interactions.
    {
      const { key, namespace } = await runMemoryRoundTrip({
        persona: 'subagent', idPrefix: 'subagent', memoryTools, details,
      });
      cleanups.push(() => safeDelete(memoryTools, key, namespace));
    }

    // ── Probe 2: swarm-agent context ──────────────────────────────────────
    // After `swarm_init` + `agent_spawn` the UnifiedSwarmCoordinator holds
    // live state. A regression that opens long-lived sql.js handles in the
    // coordinator can clobber writes from the memory subsystem (sql.js
    // dump-on-flush hazard) — the round-trip here would catch that.
    try {
      const swarmInit = (await invokeOrThrow(swarmTools, 'swarm_init', { topology: 'mesh' })) as { success?: boolean };
      if (!swarmInit?.success) {
        details.push({
          id: 'swarm-agent.setup', mcpTool: 'swarm_init', status: 'warn',
          observed: swarmInit, expected: 'success=true so probe can run in coordinator context',
          message: 'swarm_init failed — skipping swarm-agent memory probe (likely environmental)',
        });
      } else {
        const spawnOut = (await invokeOrThrow(agentTools, 'agent_spawn', { agentType: 'coder' })) as { success?: boolean; agentId?: string };
        if (spawnOut?.success && typeof spawnOut.agentId === 'string') {
          spawnedAgentId = spawnOut.agentId;
          const { key, namespace } = await runMemoryRoundTrip({
            persona: 'swarm-agent', idPrefix: 'swarm-agent', memoryTools, details,
          });
          cleanups.push(() => safeDelete(memoryTools, key, namespace));
        } else {
          details.push({
            id: 'swarm-agent.setup', mcpTool: 'agent_spawn', status: 'warn',
            observed: spawnOut, expected: 'success=true with agentId so probe can run',
            message: 'agent_spawn failed — skipping swarm-agent memory probe',
          });
        }
      }
    } catch (err) {
      const detail = errorDetail(err, { firstLineOnly: true });
      details.push({
        id: 'swarm-agent.setup', mcpTool: 'swarm_init', status: 'warn',
        observed: { error: detail }, expected: 'coordinator setup completes',
        message: `swarm setup threw: ${detail}`,
      });
    }

    // ── Probe 3: hive-mind worker context ─────────────────────────────────
    // After `hive-mind_init` + `hive-mind_spawn` the MessageBus + adapter
    // are wired. We probe the underlying memory tools (not the
    // hive-mind_memory wrapper) so a regression in the wrapper doesn't mask
    // a healthy underlying store, and vice versa — the existing
    // checkHiveMindFunctional already exercises the wrapper.
    try {
      const hiveInit = (await invokeOrThrow(hiveMindTools, 'hive-mind_init', { topology: 'mesh' })) as { success?: boolean };
      if (!hiveInit?.success) {
        details.push({
          id: 'hive-mind-worker.setup', mcpTool: 'hive-mind_init', status: 'warn',
          observed: hiveInit, expected: 'success=true so probe can run in hive context',
          message: 'hive-mind_init failed — skipping hive-mind memory probe',
        });
      } else {
        hiveInitialized = true;
        const spawnHive = (await invokeOrThrow(hiveMindTools, 'hive-mind_spawn', {
          count: 1, role: 'worker', agentType: 'worker',
        })) as { success?: boolean; spawned?: number };
        if (spawnHive?.success && spawnHive.spawned === 1) {
          const { key, namespace } = await runMemoryRoundTrip({
            persona: 'hive-mind-worker', idPrefix: 'hive-mind-worker', memoryTools, details,
          });
          cleanups.push(() => safeDelete(memoryTools, key, namespace));
        } else {
          details.push({
            id: 'hive-mind-worker.setup', mcpTool: 'hive-mind_spawn', status: 'warn',
            observed: spawnHive, expected: 'success=true with spawned=1 so probe can run',
            message: 'hive-mind_spawn failed — skipping hive-mind memory probe',
          });
        }
      }
    } catch (err) {
      const detail = errorDetail(err, { firstLineOnly: true });
      details.push({
        id: 'hive-mind-worker.setup', mcpTool: 'hive-mind_init', status: 'warn',
        observed: { error: detail }, expected: 'hive setup completes',
        message: `hive setup threw: ${detail}`,
      });
    }
  } finally {
    // Cleanup order: stored keys first, then agents, then hive. Each step is
    // best-effort so a failure in one doesn't block the next.
    for (const fn of cleanups) {
      try { await fn(); } catch { /* ignore */ }
    }
    if (spawnedAgentId) {
      try {
        await invokeOrThrow(agentTools, 'agent_terminate', {
          agentId: spawnedAgentId, force: true, reason: 'doctor-memory-access-cleanup',
        });
      } catch { /* ignore */ }
    }
    if (hiveInitialized) {
      try {
        const shutdown = getTool(hiveMindTools, 'hive-mind_shutdown');
        if (shutdown?.handler) await shutdown.handler({ force: true });
      } catch { /* ignore */ }
    }
  }

  return summarize(MEMORY_ACCESS_CHECK, details);
}

// Re-export for callers that want the plain HealthCheck shape.
export type { HealthCheck };
