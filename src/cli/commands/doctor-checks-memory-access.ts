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

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { errorDetail } from '../shared/utils/error-detail.js';
import { mofloImport } from '../services/moflo-require.js';
import { memoryDbPath } from '../services/moflo-paths.js';
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
  const searchMeta = {
    id: `${ctx.idPrefix}.memory_search`,
    mcpTool: 'memory_search',
    expected: 'total>=1 with backend including HNSW',
  };
  let searchOut: SearchOut | undefined;
  try {
    searchOut = (await invokeOrThrow(ctx.memoryTools, 'memory_search', {
      query: sentinel,
      namespace,
      threshold: 0,
      limit: 5,
    })) as SearchOut;
    const failReason = assertSearch(searchOut);
    pushDetail(
      ctx.details,
      searchMeta,
      failReason ? searchOut : { total: searchOut?.total, backend: searchOut?.backend, topKey: searchOut?.results?.[0]?.key },
      failReason,
    );
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
  const top = searchOut.results?.find(r => r.key === key);
  pushDetail(
    ctx.details,
    { id: `${ctx.idPrefix}.search-finds-key`, mcpTool: 'memory_search', expected: `result containing key=${key}` },
    top ? { topKey: top.key, similarity: top.similarity } : { allKeys: searchOut.results?.map(r => r.key) },
    top ? null : `stored key ${key} not in results (got: ${searchOut?.results?.map(r => r.key).join(', ') ?? 'none'})`,
  );

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
 * Three chunks are stored via memory_store, then their `metadata` columns
 * are written directly via sql.js to inject chunk-shaped nav fields
 * (memory_store always sets metadata to '{}', so the chunker write path is
 * the only producer in steady state — bypass it here for an in-process
 * probe). The middle chunk's neighbors are then fetched and verified to
 * carry navigation back, proving S1 + S2 + the metadata column passthrough
 * survive end-to-end.
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

  // Seed three chunks via DIRECT sql.js write (skipping memory_store).
  // Going through memory_store would warm the bridge's TieredCache with
  // metadata='{}', and a follow-up direct UPDATE would race the bridge's
  // writeback (sql.js dump-on-flush hazard, see
  // feedback_sqljs_writeback_clobber.md). Writing straight to disk before
  // the bridge ever sees these keys means memory_get_neighbors → getEntry
  // hits fresh disk state and our injected metadata is what comes back.
  const dbPath = memoryDbPath(process.cwd());
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
  try {
    const initSqlJs = (await mofloImport('sql.js') as { default: () => Promise<unknown> }).default;
    const SQL = await initSqlJs() as { Database: new (buf: Buffer) => { prepare: (sql: string) => { run: (args: unknown[]) => void; free: () => void }; export: () => Uint8Array; close: () => void } };
    const db = new SQL.Database(readFileSync(dbPath));
    const insert = db.prepare(
      `INSERT OR REPLACE INTO memory_entries
        (id, key, namespace, content, type, tags, metadata, created_at, updated_at, status)
       VALUES (?, ?, ?, ?, 'semantic', '[]', ?, ?, ?, 'active')`,
    );
    const now = Date.now();
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
      insert.run([
        `memprobe-neighbors-${stamp}-${i}`,
        chunkKeys[i],
        namespace,
        `chunk body ${i}`,
        JSON.stringify(meta),
        now, now,
      ]);
    }
    insert.free();
    writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();
  } catch (err) {
    const msg = errorDetail(err, { firstLineOnly: true });
    details.push({
      id: 'neighbors.seed',
      mcpTool: 'memory_get_neighbors',
      status: 'fail',
      observed: { error: msg },
      expected: 'three chunk rows seeded with chunk-shaped metadata',
      message: `seed failed: ${msg}`,
    });
    return { key: middleKey, namespace, chunkKeys };
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
    // ── Probe 0: memory_get_neighbors (#1053 S2) ──────────────────────────
    // MUST RUN FIRST — before any memory_store call warms the bridge's
    // in-memory sql.js snapshot. The probe injects chunk metadata via a
    // direct file write to .moflo/moflo.db; once the bridge has loaded the
    // DB into memory and done its first persist, external file writes are
    // clobbered (sql.js dump-on-flush hazard, see
    // feedback_sqljs_writeback_clobber.md). Running this probe first means
    // the bridge instantiates AFTER our seed lands — its initial disk read
    // sees our rows.
    {
      const probeResult = await probeMemoryGetNeighbors(memoryTools, details);
      if (probeResult) {
        const { namespace, chunkKeys } = probeResult;
        for (const key of chunkKeys) {
          cleanups.push(() => safeDelete(memoryTools, key, namespace));
        }
      }
    }

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
