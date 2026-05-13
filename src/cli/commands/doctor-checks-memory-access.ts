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

import { existsSync } from 'fs';
import { errorDetail } from '../shared/utils/error-detail.js';
import { memoryDbPath } from '../services/moflo-paths.js';
import { findProjectRoot } from '../services/project-root.js';
import { type HealthCheck } from './doctor-checks-deep.js';
import {
  type FunctionalCheckDetail,
  type FunctionalHealthCheck,
  type ToolHandler,
  loadToolArrays,
  getTool,
  pushDetail,
  summarizeFunctional,
} from './doctor-checks-functional-shared.js';

const MEMORY_ACCESS_CHECK = 'Memory Access Functional';
const MEMORY_ACCESS_FAIL_FIX = 'Run `flo doctor --json` for per-subcheck details. Common fixes: ensure fastembed installed (memory_store.hasEmbedding=false), explicit threshold:0 honored (#837), or rebuild HNSW index (`flo memory rebuild-index`)';

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

export interface RoundTripContext {
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
 *
 * Exported (under `_` prefix) for the #1111 regression test that simulates
 * the empty-HNSW race with a synthetic `memoryTools` array. Not part of the
 * public doctor surface; use `checkMemoryAccessFunctional` from real callers.
 */
export async function _runMemoryRoundTripForTest(ctx: RoundTripContext): Promise<{ key: string; namespace: string }> {
  return runMemoryRoundTrip(ctx);
}

async function runMemoryRoundTrip(ctx: RoundTripContext): Promise<{ key: string; namespace: string }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const key = `doctor-memprobe-${ctx.persona}-${stamp}`;
  const namespace = `doctor-memprobe-${ctx.persona}`;
  const sentinel = `memprobe-${ctx.persona}-${stamp}`;

  // 1. memory_store — write must complete with a real embedding (catches
  // hash-fallback) and an HNSW-backed index (catches plain sql.js fallback).
  const storeMeta = {
    id: `${ctx.idPrefix}.memory_store`,
    mcpTool: 'memory_store',
    expected: 'success=true, hasEmbedding=true, backend includes HNSW',
  };
  let storeOut: StoreOut | undefined;
  try {
    storeOut = (await invokeOrThrow(ctx.memoryTools, 'memory_store', {
      key,
      value: { sentinel, persona: ctx.persona },
      namespace,
    })) as StoreOut;
    pushDetail(ctx.details, storeMeta, storeOut, assertStore(storeOut));
  } catch (err) {
    const detail = errorDetail(err, { firstLineOnly: true });
    ctx.details.push({
      ...storeMeta, status: 'fail',
      observed: { error: detail }, message: `handler threw: ${detail}`,
    });
    return { key, namespace };
  }

  // 2. memory_search with threshold=0 — must find the row we just stored.
  // threshold=0 is the explicit "no threshold" value (#837); regressions
  // there silently filter out matches even when the row is in the index.
  //
  // #1111: when search returns 0 results we do a literal-key fallback via
  // memory_retrieve. On a fresh consumer install pretrain is still computing
  // embeddings async, so the HNSW index can be empty (`0 vectors indexed`)
  // even when the row IS in the DB. The check tests memory access, not
  // embedding-index readiness — a successful literal retrieve demotes the
  // search fail to a warn so the doctor surfaces the race without misreporting
  // it as broken memory access.
  const searchMeta = {
    id: `${ctx.idPrefix}.memory_search`,
    mcpTool: 'memory_search',
    expected: 'total>=1 via semantic search, OR row retrievable by key when HNSW is unpopulated',
  };
  let searchOut: SearchOut | undefined;
  let hnswIndexEmpty = false;
  try {
    searchOut = (await invokeOrThrow(ctx.memoryTools, 'memory_search', {
      query: sentinel,
      namespace,
      threshold: 0,
      limit: 5,
    })) as SearchOut;
    const failReason = assertSearch(searchOut);

    if (failReason && searchOut?.total === 0) {
      const retrievable = await literalKeyReachable(ctx.memoryTools, key, namespace);
      if (retrievable) {
        hnswIndexEmpty = true;
        ctx.details.push({
          ...searchMeta, status: 'warn',
          observed: { total: 0, backend: searchOut.backend, literalRetrieve: 'found' },
          message: 'search returned 0 results despite threshold=0, but row IS reachable by key — HNSW index not yet populated (likely pretrain/embeddings race on fresh install; memory access path works, only the vector index is empty)',
        });
      } else {
        pushDetail(ctx.details, searchMeta, searchOut, failReason);
      }
    } else {
      pushDetail(
        ctx.details,
        searchMeta,
        failReason ? searchOut : { total: searchOut?.total, backend: searchOut?.backend, topKey: searchOut?.results?.[0]?.key },
        failReason,
      );
    }
  } catch (err) {
    const detail = errorDetail(err, { firstLineOnly: true });
    ctx.details.push({
      ...searchMeta, status: 'fail',
      observed: { error: detail }, message: `handler threw: ${detail}`,
    });
    return { key, namespace };
  }

  // 3. The just-stored row must come back from search so callers can find
  // what they wrote. memory_search returns a 60-char content snippet, so
  // full-value verification belongs in the retrieve subcheck below.
  // When step 2 already observed the HNSW index as empty, the literal retrieve
  // in step 4 covers reachability; mark this subcheck warn instead of double-
  // failing on the same root cause.
  if (hnswIndexEmpty) {
    ctx.details.push({
      id: `${ctx.idPrefix}.search-finds-key`, mcpTool: 'memory_search', status: 'warn',
      observed: { hnswEmpty: true },
      expected: `result containing key=${key} via semantic search`,
      message: 'skipped semantic match — HNSW index empty (see memory_search subcheck); literal-key retrieve below covers reachability',
    });
  } else {
    const top = searchOut.results?.find(r => r.key === key);
    pushDetail(
      ctx.details,
      { id: `${ctx.idPrefix}.search-finds-key`, mcpTool: 'memory_search', expected: `result containing key=${key}` },
      top ? { topKey: top.key, similarity: top.similarity } : { allKeys: searchOut.results?.map(r => r.key) },
      top ? null : `stored key ${key} not in results (got: ${searchOut?.results?.map(r => r.key).join(', ') ?? 'none'})`,
    );
  }

  // 4. memory_retrieve returns the full value (search content is truncated
  // to a 60-char snippet). Catches write clobber and namespace bleed — we
  // get back exactly what we wrote, not someone else's row at the same key.
  const retrieveMeta = {
    id: `${ctx.idPrefix}.retrieve-roundtrip`,
    mcpTool: 'memory_retrieve',
    expected: `value.sentinel=${sentinel}`,
  };
  try {
    const retrieveOut = (await invokeOrThrow(ctx.memoryTools, 'memory_retrieve', { key, namespace })) as {
      found?: boolean;
      value?: { sentinel?: string; persona?: string } | string | null;
    };
    const failReason = assertRetrieve(retrieveOut, sentinel, key);
    pushDetail(
      ctx.details,
      retrieveMeta,
      failReason ? retrieveOut : { found: true, sentinelMatched: true },
      failReason,
    );
  } catch (err) {
    const detail = errorDetail(err, { firstLineOnly: true });
    ctx.details.push({
      ...retrieveMeta, status: 'fail',
      observed: { error: detail }, message: `handler threw: ${detail}`,
    });
  }

  return { key, namespace };
}

function assertStore(out: StoreOut | undefined): string | null {
  if (!out?.success) return `memory_store returned success=false: ${out?.error ?? JSON.stringify(out)}`;
  if (out.hasEmbedding !== true) return 'hasEmbedding=false — embedder is not wired (likely missing fastembed) or fell back to hash embeddings';
  if (typeof out.embeddingDimensions !== 'number' || out.embeddingDimensions <= 0) {
    return `embeddingDimensions invalid (${out.embeddingDimensions}) — embedder not producing real vectors`;
  }
  if (!out.backend?.includes('HNSW')) return `backend "${out.backend}" does not include HNSW — index may have fallen back to plain sql.js`;
  return null;
}

function assertSearch(out: SearchOut | undefined): string | null {
  if (out?.error) return `search returned error: ${out.error}`;
  if (!out?.backend?.includes('HNSW')) return `backend "${out?.backend}" does not include HNSW`;
  if (typeof out.total !== 'number') return 'total field missing';
  if (out.total === 0 || !out.results || out.results.length === 0) {
    return 'search returned 0 results despite an explicit threshold=0 — bridge embedder may be unwired (#837) or the row never reached the HNSW index';
  }
  return null;
}

function assertRetrieve(
  out: { found?: boolean; value?: { sentinel?: string; persona?: string } | string | null } | undefined,
  expectedSentinel: string,
  key: string,
): string | null {
  if (!out?.found) return `retrieve returned found=false for key=${key} — write didn't persist`;
  const v = out.value;
  const observedSentinel = typeof v === 'object' && v !== null ? v.sentinel : undefined;
  if (observedSentinel !== expectedSentinel) {
    return `expected sentinel="${expectedSentinel}", got ${JSON.stringify(observedSentinel)} — possible write clobber or namespace bleed`;
  }
  return null;
}

async function safeDelete(memoryTools: ToolHandler[], key: string, namespace: string): Promise<void> {
  try { await invokeOrThrow(memoryTools, 'memory_delete', { key, namespace }); } catch { /* best-effort */ }
}

/**
 * #1111: Probe whether a row is reachable via literal-key lookup. Used to
 * distinguish a real memory-access failure (row missing) from the HNSW-empty
 * race (row written, but vector index not yet populated by pretrain).
 *
 * Best-effort: a thrown handler or missing tool returns false rather than
 * propagating, so the caller still reports the original search failure.
 */
async function literalKeyReachable(memoryTools: ToolHandler[], key: string, namespace: string): Promise<boolean> {
  try {
    const out = (await invokeOrThrow(memoryTools, 'memory_retrieve', { key, namespace })) as { found?: boolean };
    return out?.found === true;
  } catch {
    return false;
  }
}

interface NeighborsResult {
  success?: boolean;
  total?: number;
  neighbors?: Array<{ key: string; navigation?: { parentDoc?: string; chunkTitle?: string } | null }>;
  error?: string;
}

/**
 * #1053 S2: probe `memory_get_neighbors` round-trip.
 *
 * Same #798 protected-functionality posture as the swarm/agent/task probes:
 * if a future refactor stubs the handler to literals (or unwires it from
 * the metadata-passthrough plumbing in S1), this probe fails BEFORE the
 * stub ships to consumers.
 *
 * Three chunks are stored via `memory_store` with the chunk-shaped metadata
 * passed in-band (#1064 — the chokepoint now accepts `metadata` so producers
 * no longer have to open their own DB handle). The middle chunk's neighbors
 * are then fetched and verified to carry navigation back, proving S1 + S2 +
 * the metadata column passthrough survive end-to-end.
 */
async function probeMemoryGetNeighbors(
  memoryTools: ToolHandler[],
  details: FunctionalCheckDetail[],
): Promise<{ key: string; namespace: string; chunkKeys: string[] } | null> {
  const tool = getTool(memoryTools, 'memory_get_neighbors');
  if (!tool?.handler) {
    details.push({
      id: 'neighbors.registered',
      mcpTool: 'memory_get_neighbors',
      status: 'fail',
      observed: { registered: false },
      expected: 'memory_get_neighbors registered in MCP tool surface (#1053 S2)',
      message: 'memory_get_neighbors is not registered — has the tool been removed or its name changed?',
    });
    return null;
  }
  details.push({
    id: 'neighbors.registered',
    mcpTool: 'memory_get_neighbors',
    status: 'pass',
    observed: { registered: true },
    expected: 'memory_get_neighbors registered',
  });

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const namespace = `doctor-neighbors-${stamp}`;
  const prefix = `chunk-doctor-neighbors-${stamp}`;
  const chunkKeys = [`${prefix}-0`, `${prefix}-1`, `${prefix}-2`];
  const middleKey = chunkKeys[1];

  // Seed three chunks through `memory_store` with metadata in-band (#1064).
  // The chokepoint now accepts `metadata`, so we no longer open our own
  // node:sqlite handle here — the bridge's TieredCache stays consistent with
  // disk, and the writer-audit no longer has to whitelist a probe-only bypass.
  const dbPath = memoryDbPath(findProjectRoot());
  if (!existsSync(dbPath)) {
    details.push({
      id: 'neighbors.seed',
      mcpTool: 'memory_get_neighbors',
      status: 'warn',
      observed: { dbPath, exists: false },
      expected: 'memory.db present so the neighbors probe can seed chunks',
      message: 'memory.db missing — skip the neighbors probe (run `flo memory init` first)',
    });
    return { key: middleKey, namespace, chunkKeys };
  }
  for (let i = 0; i < chunkKeys.length; i++) {
    const meta = {
      type: 'chunk',
      parentDoc: 'doc-doctor-neighbors',
      parentPath: '/doctor-neighbors.md',
      chunkIndex: i,
      totalChunks: chunkKeys.length,
      prevChunk: i > 0 ? chunkKeys[i - 1] : null,
      nextChunk: i < chunkKeys.length - 1 ? chunkKeys[i + 1] : null,
      siblings: chunkKeys,
      hierarchicalParent: null,
      hierarchicalChildren: null,
      chunkTitle: `Doctor Probe Chunk ${i}`,
      headerLevel: 2,
      docContentHash: stamp,
    };
    try {
      const out = (await invokeOrThrow(memoryTools, 'memory_store', {
        key: chunkKeys[i],
        value: `chunk body ${i}`,
        namespace,
        metadata: meta,
      })) as StoreOut;
      if (!out?.success) {
        details.push({
          id: 'neighbors.seed',
          mcpTool: 'memory_get_neighbors',
          status: 'fail',
          observed: { chunk: chunkKeys[i], error: out?.error ?? 'unknown' },
          expected: 'memory_store accepts chunk-shaped metadata in-band',
          message: `seed failed at chunk ${i}: ${out?.error ?? 'unknown'}`,
        });
        return { key: middleKey, namespace, chunkKeys };
      }
    } catch (err) {
      const msg = errorDetail(err, { firstLineOnly: true });
      details.push({
        id: 'neighbors.seed',
        mcpTool: 'memory_get_neighbors',
        status: 'fail',
        observed: { error: msg },
        expected: 'three chunk rows seeded via memory_store with chunk-shaped metadata',
        message: `seed failed: ${msg}`,
      });
      return { key: middleKey, namespace, chunkKeys };
    }
  }

  // 3. The probe itself — fetch prev + next of the middle chunk.
  let result: NeighborsResult | undefined;
  try {
    result = (await invokeOrThrow(memoryTools, 'memory_get_neighbors', {
      key: middleKey,
      namespace,
    })) as NeighborsResult;
  } catch (err) {
    const msg = errorDetail(err, { firstLineOnly: true });
    details.push({
      id: 'neighbors.roundtrip',
      mcpTool: 'memory_get_neighbors',
      status: 'fail',
      observed: { error: msg },
      expected: 'memory_get_neighbors returns success=true with prev + next',
      message: `handler threw: ${msg}`,
    });
    return { key: middleKey, namespace, chunkKeys };
  }

  const failReason = assertNeighbors(result, [chunkKeys[0], chunkKeys[2]]);
  pushDetail(
    details,
    {
      id: 'neighbors.roundtrip',
      mcpTool: 'memory_get_neighbors',
      expected: `success=true, total=2, neighbors include ${chunkKeys[0]} + ${chunkKeys[2]} with navigation`,
    },
    failReason ? result : { total: result.total, neighborKeys: result.neighbors?.map(n => n.key) },
    failReason,
  );

  return { key: middleKey, namespace, chunkKeys };
}

function assertNeighbors(result: NeighborsResult | undefined, expectedKeys: string[]): string | null {
  if (!result?.success) {
    return `success=${result?.success} (error: ${result?.error ?? 'unknown'}) — handler did not return success`;
  }
  if (result.total !== expectedKeys.length) {
    return `expected total=${expectedKeys.length}, got ${result.total} — neighbors traversal returned wrong count`;
  }
  const got = (result.neighbors ?? []).map(n => n.key).sort();
  const want = [...expectedKeys].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    return `expected neighbor keys ${JSON.stringify(want)}, got ${JSON.stringify(got)} — wrong neighbors returned`;
  }
  // Every neighbor must carry navigation (S1 metadata passthrough). A stub
  // that returns shaped envelopes but null nav would pass the count check;
  // this catches it.
  const missingNav = (result.neighbors ?? []).filter(n => !n.navigation);
  if (missingNav.length > 0) {
    return `${missingNav.length} neighbor(s) returned with navigation=null — S1 metadata passthrough may be broken`;
  }
  return null;
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
    // interactions. Runs first so the bridge initializes `.moflo/moflo.db`
    // (schema + first WAL commit) before the neighbors probe seeds chunks.
    //
    // Phase 4 (#1083) flipped the engine to node:sqlite + WAL: every
    // node:sqlite connection on the same DB shares the WAL coherently, so
    // the legacy "neighbors first or sql.js snapshot clobbers it" ordering
    // is obsolete. Subagent first means moflo.db exists by the time the
    // neighbors seed's `existsSync` gate runs (probe degraded to warn in
    // the temp-dir test fixture before this reorder).
    {
      const { key, namespace } = await runMemoryRoundTrip({
        persona: 'subagent', idPrefix: 'subagent', memoryTools, details,
      });
      cleanups.push(() => safeDelete(memoryTools, key, namespace));
    }

    // ── Probe 0: memory_get_neighbors (#1053 S2) ──────────────────────────
    // Seeds three chunk rows directly via the node:sqlite factory and asserts
    // memory_get_neighbors returns the prev+next pair. Cross-engine clobber
    // is no longer a concern under Phase 4 (#1083) — every writer on
    // .moflo/moflo.db goes through node:sqlite + WAL.
    {
      const probeResult = await probeMemoryGetNeighbors(memoryTools, details);
      if (probeResult) {
        const { namespace, chunkKeys } = probeResult;
        for (const key of chunkKeys) {
          cleanups.push(() => safeDelete(memoryTools, key, namespace));
        }
      }
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
    // Stored keys can clear in parallel; agent_terminate (which may release
    // a writer lock) and hive shutdown still run after so they don't race
    // the deletes.
    await Promise.all(cleanups.map(fn => fn().catch(() => { /* ignore */ })));
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

  return summarizeFunctional(MEMORY_ACCESS_CHECK, details, {
    passSuffix: '(memory_store + memory_search round-trip verified across subagent, swarm-agent, and hive-mind contexts)',
    failFix: MEMORY_ACCESS_FAIL_FIX,
  });
}

// Re-export for callers that want the plain HealthCheck shape.
export type { HealthCheck };
