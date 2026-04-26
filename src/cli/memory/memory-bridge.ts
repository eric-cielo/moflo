/**
 * Memory Bridge — Routes CLI memory operations through @moflo/memory + MofloDb.
 *
 * Top-level facade. Primitives live in `./bridge-core.ts`, the sql.js entries
 * store lives in `./bridge-entries.ts`. This module holds controller-op
 * wrappers (hierarchical memory, consolidation, batch, context, session,
 * routing, feedback, causal, HNSW, pattern, health) and re-exports the
 * public surface.
 *
 * @module v3/cli/memory-bridge
 */

import {
  cosineSim,
  execRows,
  generateId,
  getRegistry,
  persistBridgeDb,
  withDb,
} from './bridge-core.js';
import {
  bridgeSearchEntries,
  bridgeStoreEntry,
} from './bridge-entries.js';
import {
  BRIDGE_EMBEDDING_MODEL,
  getBridgeEmbedder,
} from './bridge-embedder.js';

// ===== Re-exports: primitives =====

export {
  REQUIRED_BRIDGE_CONTROLLERS,
  getBridgeLastError,
  getControllerRegistry,
  isBridgeAvailable,
  refreshVectorStatsCache,
  shutdownBridge,
} from './bridge-core.js';

// ===== Re-exports: entries store =====

export {
  bridgeDeleteEntry,
  bridgeGetEntry,
  bridgeListEntries,
  bridgeSearchEntries,
  bridgeStoreEntry,
} from './bridge-entries.js';

// ===== Embedding bridge =====

export async function bridgeGenerateEmbedding(
  text: string,
  dbPath?: string,
): Promise<{ embedding: number[]; dimensions: number; model: string } | null> {
  const registry = await getRegistry(dbPath);
  if (!registry) return null;

  // Pre-#648 this read `mofloDb.embedder`, which never exists on a SqlJsHandle —
  // the path always returned null and silently fell through to the
  // memory-initializer fastembed path. Wired through bridge-embedder so the
  // bridge does the work directly and tags results with the canonical model.
  const embedder = getBridgeEmbedder();
  const vector = await embedder.embed(text);
  return {
    embedding: Array.from(vector),
    dimensions: vector.length,
    model: embedder.model,
  };
}

export async function bridgeLoadEmbeddingModel(
  dbPath?: string,
): Promise<{
  success: boolean;
  dimensions: number;
  modelName: string;
  loadTime?: number;
} | null> {
  const startTime = Date.now();
  const registry = await getRegistry(dbPath);
  if (!registry) return null;

  // Probe the embedder so callers see real load failure rather than a stale
  // cached "available" — embed() lazily initializes fastembed and throws on
  // model-load failure (per #648 acceptance: no silent fallback).
  const embedder = getBridgeEmbedder();
  const probe = await embedder.embed('moflo bridge embedder probe');
  return {
    success: true,
    dimensions: probe.length,
    modelName: embedder.model,
    loadTime: Date.now() - startTime,
  };
}

// ===== HNSW bridge =====

export async function bridgeGetHNSWStatus(
  dbPath?: string,
): Promise<{
  available: boolean;
  initialized: boolean;
  entryCount: number;
  dimensions: number;
} | null> {
  return withDb(dbPath, async (ctx) => {
    let entryCount = 0;
    try {
      const rows = execRows(
        ctx.db,
        `SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active' AND embedding IS NOT NULL`,
      );
      entryCount = Number(rows[0]?.cnt ?? 0);
    } catch {
      // Table might not exist
    }

    return { available: true, initialized: true, entryCount, dimensions: 384 };
  });
}

export async function bridgeSearchHNSW(
  queryEmbedding: number[],
  options?: { k?: number; namespace?: string; threshold?: number },
  dbPath?: string,
): Promise<Array<{
  id: string;
  key: string;
  content: string;
  score: number;
  namespace: string;
}> | null> {
  return withDb(dbPath, async (ctx) => {
    const k = options?.k ?? 10;
    const threshold = options?.threshold ?? 0.3;
    const nsFilter = options?.namespace && options.namespace !== 'all'
      ? `AND namespace = ?`
      : '';

    let rows: Record<string, unknown>[];
    try {
      const sql = `
        SELECT id, key, namespace, content, embedding
        FROM memory_entries
        WHERE status = 'active' AND embedding IS NOT NULL ${nsFilter}
        LIMIT 10000
      `;
      rows = nsFilter ? execRows(ctx.db, sql, [options!.namespace]) : execRows(ctx.db, sql);
    } catch {
      return null;
    }

    const results: Array<{ id: string; key: string; content: string; score: number; namespace: string }> = [];

    for (const row of rows) {
      if (!row.embedding) continue;
      try {
        const emb = JSON.parse(String(row.embedding)) as number[];
        const score = cosineSim(queryEmbedding, emb);
        if (score >= threshold) {
          const content = String(row.content || '');
          results.push({
            id: String(row.id).substring(0, 12),
            key: String(row.key || row.id).substring(0, 15),
            content: content.substring(0, 60) + (content.length > 60 ? '...' : ''),
            score,
            namespace: String(row.namespace || 'default'),
          });
        }
      } catch {
        // Skip invalid embeddings
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  });
}

export async function bridgeAddToHNSW(
  id: string,
  embedding: number[],
  entry: { id: string; key: string; namespace: string; content: string },
  dbPath?: string,
): Promise<boolean | null> {
  return withDb(dbPath, async (ctx) => {
    const now = Date.now();
    const embeddingJson = JSON.stringify(embedding);
    // Bridge-produced vectors come from getBridgeEmbedder() (fastembed, 384-dim).
    // Pre-#648 this column was hardcoded to 'Xenova/all-MiniLM-L6-v2' which
    // misrepresented the producing model — fixed to the canonical bridge label.
    ctx.db.prepare(`
      INSERT OR REPLACE INTO memory_entries (
        id, key, namespace, content, type,
        embedding, embedding_dimensions, embedding_model,
        created_at, updated_at, status
      ) VALUES (?, ?, ?, ?, 'semantic', ?, ?, ?, ?, ?, 'active')
    `).run([
      id, entry.key, entry.namespace, entry.content,
      embeddingJson, embedding.length, BRIDGE_EMBEDDING_MODEL,
      now, now,
    ]);
    persistBridgeDb(ctx.db, dbPath);
    return true;
  });
}

// ===== Controller access =====

export async function bridgeGetController(name: string, dbPath?: string): Promise<any | null> {
  const registry = await getRegistry(dbPath);
  return registry ? (registry.get(name) ?? null) : null;
}

export async function bridgeHasController(name: string, dbPath?: string): Promise<boolean> {
  const registry = await getRegistry(dbPath);
  return registry ? registry.get(name) != null : false;
}

export async function bridgeListControllers(
  dbPath?: string,
): Promise<Array<{ name: string; enabled: boolean; level: number }> | null> {
  const registry = await getRegistry(dbPath);
  return registry ? registry.listControllers() : null;
}

// ===== Pattern operations =====

export async function bridgeStorePattern(options: {
  pattern: string;
  type: string;
  confidence: number;
  metadata?: Record<string, unknown>;
  dbPath?: string;
}): Promise<{ success: boolean; patternId: string; controller: string } | null> {
  const patternId = generateId('pattern');
  const result = await bridgeStoreEntry({
    key: patternId,
    value: JSON.stringify({
      pattern: options.pattern,
      type: options.type,
      confidence: options.confidence,
      metadata: options.metadata,
    }),
    namespace: 'pattern',
    generateEmbeddingFlag: true,
    tags: [options.type, 'reasoning-pattern'],
    dbPath: options.dbPath,
  });
  return result ? { success: true, patternId: result.id, controller: 'bridge' } : null;
}

export async function bridgeSearchPatterns(options: {
  query: string;
  topK?: number;
  minConfidence?: number;
  dbPath?: string;
}): Promise<{ results: Array<{ id: string; content: string; score: number }>; controller: string } | null> {
  const result = await bridgeSearchEntries({
    query: options.query,
    namespace: 'pattern',
    limit: options.topK || 5,
    threshold: options.minConfidence || 0.3,
    dbPath: options.dbPath,
  });
  if (!result) return null;
  return {
    results: result.results.map(r => ({ id: r.id, content: r.content, score: r.score })),
    controller: 'bridge',
  };
}

// ===== Feedback recording =====

export async function bridgeRecordFeedback(options: {
  taskId: string;
  success: boolean;
  quality: number;
  agent?: string;
  duration?: number;
  patterns?: string[];
  dbPath?: string;
}): Promise<{ success: boolean; controller: string; updated: number } | null> {
  const registry = await getRegistry(options.dbPath);
  if (!registry) return null;

  let controller = 'none';
  let updated = 0;

  const learningSystem = registry.get('learningSystem');
  if (learningSystem) {
    try {
      await learningSystem.recordFeedback({
        taskId: options.taskId,
        success: options.success,
        quality: options.quality,
        agent: options.agent,
        duration: options.duration,
        timestamp: Date.now(),
      });
      controller = 'learningSystem';
      updated++;
    } catch {
      // Non-fatal — feedback is observability
    }
  }

  if (options.success && options.quality >= 0.9 && options.patterns?.length) {
    const skills = registry.get('skills');
    if (skills) {
      for (const pattern of options.patterns) {
        try {
          await skills.promote(pattern, options.quality);
          updated++;
        } catch {
          // Skip individual failures
        }
      }
      controller += '+skills';
    }
  }

  const storeResult = await bridgeStoreEntry({
    key: `feedback-${options.taskId}`,
    value: JSON.stringify(options),
    namespace: 'feedback',
    tags: [options.success ? 'success' : 'failure', options.agent || 'unknown'],
    dbPath: options.dbPath,
  });
  if (storeResult?.success) {
    controller = controller === 'none' ? 'bridge-store' : `${controller}+bridge-store`;
    updated++;
  }

  return { success: true, controller, updated };
}

// ===== CausalMemoryGraph =====

export async function bridgeRecordCausalEdge(options: {
  sourceId: string;
  targetId: string;
  relation: string;
  weight?: number;
  dbPath?: string;
}): Promise<{ success: boolean; controller: string } | null> {
  const registry = await getRegistry(options.dbPath);
  if (!registry) return null;

  const causalGraph = registry.get('causalGraph');
  if (!causalGraph) return null;

  causalGraph.addEdge(options.sourceId, options.targetId, {
    relation: options.relation,
    weight: options.weight ?? 1.0,
    timestamp: Date.now(),
  });
  return { success: true, controller: 'causalGraph' };
}

// ===== ReflexionMemory session lifecycle =====

export async function bridgeSessionStart(options: {
  sessionId: string;
  context?: string;
  dbPath?: string;
}): Promise<{
  success: boolean;
  controller: string;
  restoredPatterns: number;
  sessionId: string;
} | null> {
  const registry = await getRegistry(options.dbPath);
  if (!registry) return null;

  let controller = 'none';
  const reflexion = registry.get('reflexion');
  if (reflexion) {
    await reflexion.startEpisode(options.sessionId, { context: options.context });
    controller = 'reflexion';
  }

  const searchResult = await bridgeSearchEntries({
    query: options.context || 'session patterns',
    namespace: 'session',
    limit: 10,
    threshold: 0.2,
    dbPath: options.dbPath,
  });

  return {
    success: true,
    controller: controller === 'none' ? 'bridge-search' : controller,
    restoredPatterns: searchResult?.results.length ?? 0,
    sessionId: options.sessionId,
  };
}

export async function bridgeSessionEnd(options: {
  sessionId: string;
  summary?: string;
  tasksCompleted?: number;
  patternsLearned?: number;
  dbPath?: string;
}): Promise<{
  success: boolean;
  controller: string;
  persisted: boolean;
} | null> {
  const registry = await getRegistry(options.dbPath);
  if (!registry) return null;

  let controller = 'none';
  const reflexion = registry.get('reflexion');
  if (reflexion) {
    await reflexion.endEpisode(options.sessionId, {
      summary: options.summary,
      tasksCompleted: options.tasksCompleted,
      patternsLearned: options.patternsLearned,
    });
    controller = 'reflexion';
  }

  await bridgeStoreEntry({
    key: `session-${options.sessionId}`,
    value: JSON.stringify({
      sessionId: options.sessionId,
      summary: options.summary || 'Session ended',
      tasksCompleted: options.tasksCompleted ?? 0,
      patternsLearned: options.patternsLearned ?? 0,
      endedAt: new Date().toISOString(),
    }),
    namespace: 'session',
    tags: ['session-end'],
    upsert: true,
    dbPath: options.dbPath,
  });

  if (controller === 'none') controller = 'bridge-store';

  const nightlyLearner = registry.get('nightlyLearner');
  if (nightlyLearner) {
    try {
      await nightlyLearner.consolidate({ sessionId: options.sessionId });
      controller += '+nightlyLearner';
    } catch {
      // Non-fatal
    }
  }

  return { success: true, controller, persisted: true };
}

// ===== SemanticRouter bridge =====

export async function bridgeRouteTask(options: {
  task: string;
  context?: string;
  dbPath?: string;
}): Promise<{
  route: string;
  confidence: number;
  agents: string[];
  controller: string;
} | null> {
  const registry = await getRegistry(options.dbPath);
  if (!registry) return null;

  const semanticRouter = registry.get('semanticRouter');
  if (semanticRouter) {
    const result = await semanticRouter.route(options.task, { context: options.context });
    if (result) {
      return {
        route: result.route || result.category || 'general',
        confidence: result.confidence ?? result.score ?? 0.5,
        agents: result.agents || result.suggestedAgents || [],
        controller: 'semanticRouter',
      };
    }
  }

  const learningSystem = registry.get('learningSystem');
  if (learningSystem) {
    const rec = await learningSystem.recommendAlgorithm(options.task);
    if (rec) {
      return {
        route: rec.algorithm || rec.route || 'general',
        confidence: rec.confidence ?? 0.5,
        agents: rec.agents || [],
        controller: 'learningSystem',
      };
    }
  }

  return null;
}

// ===== Health check with attestation =====

export async function bridgeHealthCheck(
  dbPath?: string,
): Promise<{
  available: boolean;
  controllers: Array<{ name: string; enabled: boolean; level: number }>;
  attestationCount?: number;
  cacheStats?: { size: number; hits: number; misses: number };
} | null> {
  const registry = await getRegistry(dbPath);
  if (!registry) return null;

  const controllers = registry.listControllers();

  let attestationCount = 0;
  const attestation = registry.get('attestationLog');
  if (attestation) attestationCount = attestation.count();

  let cacheStats = { size: 0, hits: 0, misses: 0 };
  const cache = registry.get('tieredCache');
  if (cache) {
    const s = cache.getStats();
    cacheStats = { size: s.size ?? 0, hits: s.hits ?? 0, misses: s.misses ?? 0 };
  }

  return { available: true, controllers, attestationCount, cacheStats };
}

// ===== Hierarchical memory, consolidation, batch, context, semantic route =====

/**
 * Store to hierarchical memory with tier (working, episodic, semantic).
 */
export async function bridgeHierarchicalStore(params: {
  key: string;
  value: string;
  tier?: string;
  importance?: number;
}): Promise<any> {
  const registry = await getRegistry();
  if (!registry) return null;
  try {
    const hm = registry.get('hierarchicalMemory');
    if (!hm) return { success: false, error: 'HierarchicalMemory not available' };
    const tier = params.tier || 'working';
    const id = await hm.store(params.value, params.importance || 0.5, tier, {
      metadata: { key: params.key },
      tags: [params.key],
    });
    return { success: true, id, key: params.key, tier };
  } catch (e: any) { return { success: false, error: e.message }; }
}

export async function bridgeHierarchicalRecall(params: {
  query: string;
  tier?: string;
  topK?: number;
}): Promise<any> {
  const registry = await getRegistry();
  if (!registry) return null;
  try {
    const hm = registry.get('hierarchicalMemory');
    if (!hm) return { results: [], error: 'HierarchicalMemory not available' };
    const memoryQuery: any = { query: params.query, k: params.topK || 5 };
    if (params.tier) memoryQuery.tier = params.tier;
    const results = await hm.recall(memoryQuery);
    return { results: results || [], controller: 'hierarchicalMemory' };
  } catch (e: any) { return { results: [], error: e.message }; }
}

export async function bridgeConsolidate(_params: { minAge?: number; maxEntries?: number }): Promise<any> {
  const registry = await getRegistry();
  if (!registry) return null;
  try {
    const mc = registry.get('memoryConsolidation');
    if (!mc) return { success: false, error: 'MemoryConsolidation not available' };
    const result = await mc.consolidate();
    return { success: true, consolidated: result };
  } catch (e: any) { return { success: false, error: e.message }; }
}

export async function bridgeBatchOperation(params: { operation: string; entries: any[] }): Promise<any> {
  const registry = await getRegistry();
  if (!registry) return null;
  try {
    const batch = registry.get('batchOperations');
    if (!batch) return { success: false, error: 'BatchOperations not available' };
    let result;
    switch (params.operation) {
      case 'insert': {
        const episodes = params.entries.map((e: any) => ({
          content: e.value || e.content || JSON.stringify(e),
          metadata: e.metadata || { key: e.key },
        }));
        result = await batch.insertEpisodes(episodes);
        break;
      }
      case 'delete': {
        const keys = params.entries.map((e: any) => e.key).filter(Boolean);
        for (const key of keys) await batch.bulkDelete('episodes', { key });
        result = { deleted: keys.length };
        break;
      }
      case 'update': {
        for (const entry of params.entries) {
          await batch.bulkUpdate('episodes', { content: entry.value || entry.content }, { key: entry.key });
        }
        result = { updated: params.entries.length };
        break;
      }
      default: return { success: false, error: `Unknown operation: ${params.operation}` };
    }
    return { success: true, operation: params.operation, count: params.entries.length, result };
  } catch (e: any) { return { success: false, error: e.message }; }
}

/**
 * Synthesize context from memories via ContextSynthesizer.synthesize (static).
 */
export async function bridgeContextSynthesize(params: { query: string; maxEntries?: number }): Promise<any> {
  const registry = await getRegistry();
  if (!registry) return null;
  try {
    const CS = registry.get('contextSynthesizer');
    if (!CS) return { success: false, error: 'ContextSynthesizer not available' };

    const hm = registry.get('hierarchicalMemory');
    let memories: any[] = [];
    if (hm) {
      const recalled = await hm.recall({ query: params.query, k: params.maxEntries || 10 });
      memories = (recalled || []).map((r: any) => ({
        content: r.value || r.content || '',
        key: r.key || r.id || '',
        reward: 1,
        verdict: 'success',
      }));
    }
    const result = CS.synthesize(memories, { includeRecommendations: true });
    return { success: true, synthesis: result };
  } catch (e: any) { return { success: false, error: e.message }; }
}

export async function bridgeSemanticRoute(params: { input: string }): Promise<any> {
  const registry = await getRegistry();
  if (!registry) return null;
  try {
    const router = registry.get('semanticRouter');
    if (!router) return { route: null, error: 'SemanticRouter not available' };
    const result = await router.route(params.input);
    return { route: result, controller: 'semanticRouter' };
  } catch (e: any) { return { route: null, error: e.message }; }
}
