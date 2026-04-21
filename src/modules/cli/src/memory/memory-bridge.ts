/**
 * Memory Bridge — Routes CLI memory operations through any + MofloDb.
 *
 * Controllers are moflo-owned and typed (see @moflo/memory), so this bridge
 * calls them directly. System-boundary try/catch remains around sql.js and fs
 * operations. Inner catch { return null } still signals "registry unavailable,
 * caller should fall back to raw sql.js" — that contract is used by
 * memory-initializer.ts.
 *
 * @module v3/cli/memory-bridge
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// ===== Project root resolution =====
// When run via npx, CWD may be node_modules/moflo — walk up to find actual project

let _projectRoot: string | undefined;
function getProjectRoot(): string {
  if (_projectRoot) return _projectRoot;
  if (process.env.CLAUDE_PROJECT_DIR) {
    _projectRoot = process.env.CLAUDE_PROJECT_DIR;
    return _projectRoot;
  }
  let dir = process.cwd();
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.swarm', 'memory.db'))) {
      _projectRoot = dir;
      return _projectRoot;
    }
    if (fs.existsSync(path.join(dir, 'CLAUDE.md')) && fs.existsSync(path.join(dir, 'package.json'))) {
      _projectRoot = dir;
      return _projectRoot;
    }
    if (path.basename(dir) === 'node_modules') {
      dir = path.dirname(dir);
      continue;
    }
    dir = path.dirname(dir);
  }
  _projectRoot = process.cwd();
  return _projectRoot;
}

// ===== Lazy singleton =====

let registryPromise: Promise<any | null> | null = null;
// Sync handle populated once the promise resolves. Lets sync callers
// (refreshVectorStatsCache) read the registry without awaiting.
let resolvedRegistry: any | null = null;
const schemaInitialized = new WeakSet<object>();

/**
 * Resolve database path with path traversal protection.
 */
function getDbPath(customPath?: string): string {
  const swarmDir = path.resolve(getProjectRoot(), '.swarm');
  if (!customPath) return path.join(swarmDir, 'memory.db');
  if (customPath === ':memory:') return ':memory:';
  const resolved = path.resolve(customPath);
  const cwd = getProjectRoot();
  if (!resolved.startsWith(cwd)) {
    return path.join(swarmDir, 'memory.db');
  }
  return resolved;
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Lazily initialize the any singleton.
 * Returns null if @moflo/memory cannot be loaded or sql.js fails to open.
 */
async function getRegistry(dbPath?: string): Promise<any | null> {
  if (!registryPromise) {
    registryPromise = (async () => {
      try {
        const { ControllerRegistry } = await import('@moflo/memory');
        const registry = new ControllerRegistry();

        // Suppress noisy init logs
        const origLog = console.log;
        console.log = (...args: unknown[]) => {
          const msg = String(args[0] ?? '');
          if (msg.includes('Transformers.js') ||
              msg.includes('[MofloDb]') ||
              msg.includes('[HNSWLibBackend]') ||
              msg.includes('MoVector graph')) return;
          origLog.apply(console, args);
        };

        try {
          await registry.initialize({
            dbPath: dbPath || getDbPath(),
            dimension: 384,
            controllers: {
              learningBridge: false,
              tieredCache: true,
              hierarchicalMemory: true,
              memoryConsolidation: true,
              memoryGraph: true,
            },
          });
        } finally {
          console.log = origLog;
        }

        resolvedRegistry = registry;
        return registry;
      } catch {
        registryPromise = null;
        return null;
      }
    })();
  }

  return registryPromise;
}

// ===== BM25 hybrid scoring =====

function bm25Score(
  queryTerms: string[],
  docContent: string,
  avgDocLength: number,
  docCount: number,
  termDocFreqs: Map<string, number>,
): number {
  const k1 = 1.2;
  const b = 0.75;
  const docWords = docContent.toLowerCase().split(/\s+/);
  const docLength = docWords.length;

  let score = 0;
  for (const term of queryTerms) {
    const tf = docWords.filter(w => w === term || w.includes(term)).length;
    if (tf === 0) continue;

    const df = termDocFreqs.get(term) || 1;
    const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / Math.max(1, avgDocLength))));
    score += idf * tfNorm;
  }

  return score;
}

function computeTermDocFreqs(
  queryTerms: string[],
  rows: Array<{ content: string }>,
): { termDocFreqs: Map<string, number>; avgDocLength: number } {
  const termDocFreqs = new Map<string, number>();
  let totalLength = 0;

  for (const row of rows) {
    const content = (row.content || '').toLowerCase();
    const words = content.split(/\s+/);
    totalLength += words.length;

    for (const term of queryTerms) {
      if (content.includes(term)) {
        termDocFreqs.set(term, (termDocFreqs.get(term) || 0) + 1);
      }
    }
  }

  return { termDocFreqs, avgDocLength: rows.length > 0 ? totalLength / rows.length : 1 };
}

// ===== Cache helpers (tieredCache is always enabled) =====

async function cacheGet(registry: any, cacheKey: string): Promise<any | null> {
  const cache = registry.get('tieredCache');
  if (!cache) return null;
  return (await cache.get(cacheKey)) ?? null;
}

async function cacheSet(registry: any, cacheKey: string, value: any): Promise<void> {
  const cache = registry.get('tieredCache');
  if (!cache) return;
  await cache.set(cacheKey, value);
}

async function cacheInvalidate(registry: any, cacheKey: string): Promise<void> {
  const cache = registry.get('tieredCache');
  if (!cache) return;
  cache.delete(cacheKey);
}

// ===== MutationGuard (always enabled) =====

/**
 * Validate a mutation through MutationGuard. Returns allowed=true by default;
 * returns allowed=false only if the guard explicitly rejects.
 */
async function guardValidate(
  registry: any,
  operation: string,
  params: Record<string, unknown>,
): Promise<{ allowed: boolean; reason?: string }> {
  const guard = registry.get('mutationGuard');
  if (!guard) return { allowed: true };
  const result = guard.validate({ operation, params, timestamp: Date.now() });
  return { allowed: result?.allowed === true, reason: result?.reason };
}

// ===== AttestationLog helpers =====

/**
 * Log an audit entry for a write operation. Observability only —
 * failures are non-fatal.
 */
async function logAttestation(
  registry: any,
  operation: string,
  entryId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const attestation = registry.get('attestationLog');
  if (!attestation) return;
  try {
    attestation.record({ operation, entryId, timestamp: Date.now(), ...metadata });
  } catch {
    // Non-fatal — attestation is observability, not correctness
  }
}

/**
 * Get the MofloDb database handle and ensure memory_entries table exists.
 * Schema DDL runs once per database handle (tracked in schemaInitialized).
 */
function getDb(registry: any): { db: any; mofloDb: any } | null {
  const mofloDb = registry.getMofloDb();
  if (!mofloDb?.database) return null;

  const db = mofloDb.database;

  if (!schemaInitialized.has(db)) {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        namespace TEXT DEFAULT 'default',
        content TEXT NOT NULL,
        type TEXT DEFAULT 'semantic',
        embedding TEXT,
        embedding_model TEXT DEFAULT 'local',
        embedding_dimensions INTEGER,
        tags TEXT,
        metadata TEXT,
        owner_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
        expires_at INTEGER,
        last_accessed_at INTEGER,
        access_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        UNIQUE(namespace, key)
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bridge_ns ON memory_entries(namespace)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bridge_key ON memory_entries(key)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bridge_status ON memory_entries(status)`);
      schemaInitialized.add(db);
    } catch {
      // Table already exists or db is read-only — that's fine
    }
  }

  return { db, mofloDb };
}

// ===== Shared wrapper =====

/**
 * Common bridge-function prelude: resolve registry + db, run fn, return null
 * on any unexpected failure so the caller falls back to raw sql.js.
 */
async function withDb<T>(
  dbPath: string | undefined,
  fn: (ctx: { db: any; mofloDb: any }, registry: any) => Promise<T | null>,
): Promise<T | null> {
  const registry = await getRegistry(dbPath);
  if (!registry) return null;
  const ctx = getDb(registry);
  if (!ctx) return null;
  try {
    return await fn(ctx, registry);
  } catch {
    return null;
  }
}

// ===== Bridge functions — match memory-initializer.ts signatures =====

/**
 * Store an entry. Returns null to signal fallback to sql.js.
 */
export async function bridgeStoreEntry(options: {
  key: string;
  value: string;
  namespace?: string;
  generateEmbeddingFlag?: boolean;
  tags?: string[];
  ttl?: number;
  dbPath?: string;
  upsert?: boolean;
}): Promise<{
  success: boolean;
  id: string;
  embedding?: { dimensions: number; model: string };
  guarded?: boolean;
  cached?: boolean;
  attested?: boolean;
  error?: string;
} | null> {
  return withDb(options.dbPath, async (ctx, registry) => {
    const { key, value, namespace = 'default', tags = [], ttl } = options;
    const id = generateId('entry');
    const now = Date.now();

    const guardResult = await guardValidate(registry, 'store', { key, namespace, size: value.length });
    if (!guardResult.allowed) {
      return { success: false, id, error: `MutationGuard rejected: ${guardResult.reason}` };
    }

    let embeddingJson: string | null = null;
    let dimensions = 0;
    let model = 'local';

    if (options.generateEmbeddingFlag !== false && value.length > 0) {
      try {
        const embedder = ctx.mofloDb.embedder;
        if (embedder) {
          const emb = await embedder.embed(value);
          if (emb) {
            embeddingJson = JSON.stringify(Array.from(emb));
            dimensions = emb.length;
            model = 'Xenova/all-MiniLM-L6-v2';
          }
        }
      } catch {
        // Embedding failed — store without
      }
    }

    const insertSql = options.upsert
      ? `INSERT OR REPLACE INTO memory_entries (
          id, key, namespace, content, type,
          embedding, embedding_dimensions, embedding_model,
          tags, metadata, created_at, updated_at, expires_at, status
        ) VALUES (?, ?, ?, ?, 'semantic', ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
      : `INSERT INTO memory_entries (
          id, key, namespace, content, type,
          embedding, embedding_dimensions, embedding_model,
          tags, metadata, created_at, updated_at, expires_at, status
        ) VALUES (?, ?, ?, ?, 'semantic', ?, ?, ?, ?, ?, ?, ?, ?, 'active')`;

    const stmt = ctx.db.prepare(insertSql);
    stmt.run(
      id, key, namespace, value,
      embeddingJson, dimensions || null, model,
      tags.length > 0 ? JSON.stringify(tags) : null,
      '{}',
      now, now,
      ttl ? now + (ttl * 1000) : null,
    );

    const safeNs = String(namespace).replace(/:/g, '_');
    const safeKey = String(key).replace(/:/g, '_');
    const cacheKey = `entry:${safeNs}:${safeKey}`;
    await cacheSet(registry, cacheKey, { id, key, namespace, content: value, embedding: embeddingJson });

    await logAttestation(registry, 'store', id, { key, namespace, hasEmbedding: !!embeddingJson });

    if (embeddingJson) refreshVectorStatsCache();

    return {
      success: true,
      id,
      embedding: embeddingJson ? { dimensions, model } : undefined,
      guarded: true,
      cached: true,
      attested: true,
    };
  });
}

/**
 * Search entries with hybrid BM25 + cosine scoring.
 */
export async function bridgeSearchEntries(options: {
  query: string;
  namespace?: string;
  limit?: number;
  threshold?: number;
  dbPath?: string;
}): Promise<{
  success: boolean;
  results: {
    id: string;
    key: string;
    content: string;
    score: number;
    namespace: string;
    provenance?: string;
  }[];
  searchTime: number;
  searchMethod?: string;
  error?: string;
} | null> {
  return withDb(options.dbPath, async (ctx) => {
    const { query: queryStr, namespace = 'default', limit = 10, threshold = 0.3 } = options;
    const startTime = Date.now();

    let queryEmbedding: number[] | null = null;
    try {
      const embedder = ctx.mofloDb.embedder;
      if (embedder) {
        const emb = await embedder.embed(queryStr);
        queryEmbedding = Array.from(emb);
      }
    } catch {
      // Fall back to keyword search
    }

    const nsFilter = namespace !== 'all' ? `AND namespace = ?` : '';

    let rows: any[];
    try {
      const stmt = ctx.db.prepare(`
        SELECT id, key, namespace, content, embedding
        FROM memory_entries
        WHERE status = 'active' ${nsFilter}
        LIMIT 1000
      `);
      rows = namespace !== 'all' ? stmt.all(namespace) : stmt.all();
    } catch {
      return null;
    }

    const queryTerms = queryStr.toLowerCase().split(/\s+/).filter(t => t.length > 1);
    const { termDocFreqs, avgDocLength } = computeTermDocFreqs(queryTerms, rows);
    const docCount = rows.length;

    const results: { id: string; key: string; content: string; score: number; namespace: string; provenance?: string }[] = [];

    for (const row of rows) {
      let semanticScore = 0;
      let bm25ScoreVal = 0;

      if (queryEmbedding && row.embedding) {
        try {
          const embedding = JSON.parse(row.embedding) as number[];
          semanticScore = cosineSim(queryEmbedding, embedding);
        } catch {
          // Invalid embedding
        }
      }

      if (queryTerms.length > 0 && row.content) {
        bm25ScoreVal = bm25Score(queryTerms, row.content, avgDocLength, docCount, termDocFreqs);
        bm25ScoreVal = Math.min(bm25ScoreVal / 10, 1.0);
      }

      const usedSemantic = queryEmbedding != null;
      const score = usedSemantic ? 0.7 * semanticScore + 0.3 * bm25ScoreVal : bm25ScoreVal;

      if (score >= threshold) {
        const provenance = usedSemantic
          ? `semantic:${semanticScore.toFixed(3)}+bm25:${bm25ScoreVal.toFixed(3)}`
          : `bm25:${bm25ScoreVal.toFixed(3)}`;

        results.push({
          id: String(row.id).substring(0, 12),
          key: row.key || String(row.id).substring(0, 15),
          content: (row.content || '').substring(0, 60) + ((row.content || '').length > 60 ? '...' : ''),
          score,
          namespace: row.namespace || 'default',
          provenance,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);

    return {
      success: true,
      results: results.slice(0, limit),
      searchTime: Date.now() - startTime,
      searchMethod: queryEmbedding ? 'hybrid-bm25-semantic' : 'bm25-only',
    };
  });
}

export async function bridgeListEntries(options: {
  namespace?: string;
  limit?: number;
  offset?: number;
  dbPath?: string;
}): Promise<{
  success: boolean;
  entries: {
    id: string;
    key: string;
    namespace: string;
    size: number;
    accessCount: number;
    createdAt: string;
    updatedAt: string;
    hasEmbedding: boolean;
  }[];
  total: number;
  error?: string;
} | null> {
  return withDb(options.dbPath, async (ctx) => {
    const { namespace, limit = 20, offset = 0 } = options;
    const nsFilter = namespace ? `AND namespace = ?` : '';
    const nsParams = namespace ? [namespace] : [];

    let total = 0;
    try {
      const countStmt = ctx.db.prepare(
        `SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active' ${nsFilter}`,
      );
      const countRow = countStmt.get(...nsParams);
      total = countRow?.cnt ?? 0;
    } catch {
      return null;
    }

    const entries: any[] = [];
    try {
      const stmt = ctx.db.prepare(`
        SELECT id, key, namespace, content, embedding, access_count, created_at, updated_at
        FROM memory_entries
        WHERE status = 'active' ${nsFilter}
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `);
      const rows = stmt.all(...nsParams, limit, offset);
      for (const row of rows) {
        entries.push({
          id: String(row.id).substring(0, 20),
          key: row.key || String(row.id).substring(0, 15),
          namespace: row.namespace || 'default',
          size: (row.content || '').length,
          accessCount: row.access_count ?? 0,
          createdAt: row.created_at || new Date().toISOString(),
          updatedAt: row.updated_at || new Date().toISOString(),
          hasEmbedding: !!(row.embedding && String(row.embedding).length > 10),
        });
      }
    } catch {
      return null;
    }

    return { success: true, entries, total };
  });
}

/**
 * Get a specific entry via TieredCache → DB.
 */
export async function bridgeGetEntry(options: {
  key: string;
  namespace?: string;
  dbPath?: string;
}): Promise<{
  success: boolean;
  found: boolean;
  entry?: {
    id: string;
    key: string;
    namespace: string;
    content: string;
    accessCount: number;
    createdAt: string;
    updatedAt: string;
    hasEmbedding: boolean;
    tags: string[];
  };
  cacheHit?: boolean;
  error?: string;
} | null> {
  return withDb(options.dbPath, async (ctx, registry) => {
    const { key, namespace = 'default' } = options;

    const safeNs = String(namespace).replace(/:/g, '_');
    const safeKey = String(key).replace(/:/g, '_');
    const cacheKey = `entry:${safeNs}:${safeKey}`;
    const cached = await cacheGet(registry, cacheKey);
    if (cached && cached.content) {
      return {
        success: true,
        found: true,
        cacheHit: true,
        entry: {
          id: String(cached.id || ''),
          key: cached.key || key,
          namespace: cached.namespace || namespace,
          content: cached.content || '',
          accessCount: cached.accessCount ?? 0,
          createdAt: cached.createdAt || new Date().toISOString(),
          updatedAt: cached.updatedAt || new Date().toISOString(),
          hasEmbedding: !!cached.embedding,
          tags: cached.tags || [],
        },
      };
    }

    let row: any;
    try {
      const stmt = ctx.db.prepare(`
        SELECT id, key, namespace, content, embedding, access_count, created_at, updated_at, tags
        FROM memory_entries
        WHERE status = 'active' AND key = ? AND namespace = ?
        LIMIT 1
      `);
      row = stmt.get(key, namespace);
    } catch {
      return null;
    }

    if (!row) return { success: true, found: false };

    try {
      ctx.db.prepare(
        `UPDATE memory_entries SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
      ).run(Date.now(), row.id);
    } catch {
      // Non-fatal
    }

    let tags: string[] = [];
    if (row.tags) {
      try { tags = JSON.parse(row.tags); } catch { /* invalid */ }
    }

    const entry = {
      id: String(row.id),
      key: row.key || String(row.id),
      namespace: row.namespace || 'default',
      content: row.content || '',
      accessCount: (row.access_count ?? 0) + 1,
      createdAt: row.created_at || new Date().toISOString(),
      updatedAt: row.updated_at || new Date().toISOString(),
      hasEmbedding: !!(row.embedding && String(row.embedding).length > 10),
      tags,
    };

    await cacheSet(registry, cacheKey, entry);

    return { success: true, found: true, cacheHit: false, entry };
  });
}

/**
 * Soft-delete an entry. Guarded, cache-invalidated, attested.
 */
export async function bridgeDeleteEntry(options: {
  key: string;
  namespace?: string;
  dbPath?: string;
}): Promise<{
  success: boolean;
  deleted: boolean;
  key: string;
  namespace: string;
  remainingEntries: number;
  guarded?: boolean;
  error?: string;
} | null> {
  return withDb(options.dbPath, async (ctx, registry) => {
    const { key, namespace = 'default' } = options;

    const guardResult = await guardValidate(registry, 'delete', { key, namespace });
    if (!guardResult.allowed) {
      return { success: false, deleted: false, key, namespace, remainingEntries: 0, error: `MutationGuard rejected: ${guardResult.reason}` };
    }

    let changes = 0;
    try {
      const result = ctx.db.prepare(`
        UPDATE memory_entries
        SET status = 'deleted', updated_at = ?
        WHERE key = ? AND namespace = ? AND status = 'active'
      `).run(Date.now(), key, namespace);
      changes = result?.changes ?? 0;
    } catch {
      return null;
    }

    const safeNs = String(namespace).replace(/:/g, '_');
    const safeKey = String(key).replace(/:/g, '_');
    await cacheInvalidate(registry, `entry:${safeNs}:${safeKey}`);

    if (changes > 0) {
      await logAttestation(registry, 'delete', key, { namespace });
    }

    let remaining = 0;
    try {
      const row = ctx.db.prepare(`SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active'`).get();
      remaining = row?.cnt ?? 0;
    } catch {
      // Non-fatal
    }

    if (changes > 0) refreshVectorStatsCache();

    return {
      success: true,
      deleted: changes > 0,
      key,
      namespace,
      remainingEntries: remaining,
      guarded: true,
    };
  });
}

// ===== Embedding bridge =====

export async function bridgeGenerateEmbedding(
  text: string,
  dbPath?: string,
): Promise<{ embedding: number[]; dimensions: number; model: string } | null> {
  const registry = await getRegistry(dbPath);
  if (!registry) return null;

  try {
    const mofloDb = registry.getMofloDb();
    const embedder = mofloDb?.embedder;
    if (!embedder) return null;

    const emb = await embedder.embed(text);
    if (!emb) return null;

    return {
      embedding: Array.from(emb),
      dimensions: emb.length,
      model: 'Xenova/all-MiniLM-L6-v2',
    };
  } catch {
    return null;
  }
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

  try {
    const mofloDb = registry.getMofloDb();
    const embedder = mofloDb?.embedder;
    if (!embedder) return null;

    const test = await embedder.embed('test');
    if (!test) return null;

    return {
      success: true,
      dimensions: test.length,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      loadTime: Date.now() - startTime,
    };
  } catch {
    return null;
  }
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
      const row = ctx.db.prepare(
        `SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active' AND embedding IS NOT NULL`,
      ).get();
      entryCount = row?.cnt ?? 0;
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

    let rows: any[];
    try {
      const stmt = ctx.db.prepare(`
        SELECT id, key, namespace, content, embedding
        FROM memory_entries
        WHERE status = 'active' AND embedding IS NOT NULL ${nsFilter}
        LIMIT 10000
      `);
      rows = nsFilter ? stmt.all(options!.namespace) : stmt.all();
    } catch {
      return null;
    }

    const results: Array<{ id: string; key: string; content: string; score: number; namespace: string }> = [];

    for (const row of rows) {
      if (!row.embedding) continue;
      try {
        const emb = JSON.parse(row.embedding) as number[];
        const score = cosineSim(queryEmbedding, emb);
        if (score >= threshold) {
          results.push({
            id: String(row.id).substring(0, 12),
            key: row.key || String(row.id).substring(0, 15),
            content: (row.content || '').substring(0, 60) +
              ((row.content || '').length > 60 ? '...' : ''),
            score,
            namespace: row.namespace || 'default',
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
    ctx.db.prepare(`
      INSERT OR REPLACE INTO memory_entries (
        id, key, namespace, content, type,
        embedding, embedding_dimensions, embedding_model,
        created_at, updated_at, status
      ) VALUES (?, ?, ?, ?, 'semantic', ?, ?, 'Xenova/all-MiniLM-L6-v2', ?, ?, 'active')
    `).run(
      id, entry.key, entry.namespace, entry.content,
      embeddingJson, embedding.length,
      now, now,
    );
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

export async function isBridgeAvailable(dbPath?: string): Promise<boolean> {
  const registry = await getRegistry(dbPath);
  return registry !== null;
}

export async function getControllerRegistry(dbPath?: string): Promise<any | null> {
  return getRegistry(dbPath);
}

export async function shutdownBridge(): Promise<void> {
  if (!registryPromise) return;
  const registry = await registryPromise;
  registryPromise = null;
  resolvedRegistry = null;
  if (registry) {
    try {
      await registry.shutdown();
    } catch {
      // Best-effort
    }
  }
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
//
// HierarchicalMemory has two shapes: the real controller (async store returning
// id, has `getStats`+`promote`) and the in-memory stub from any
// (sync store, no promote). We branch on `typeof promote === 'function'` to
// pick the right call shape — this is polymorphism, not duck-typing.

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

    if (typeof hm.promote === 'function') {
      const id = await hm.store(params.value, params.importance || 0.5, tier, {
        metadata: { key: params.key },
        tags: [params.key],
      });
      return { success: true, id, key: params.key, tier };
    }
    hm.store(params.key, params.value, tier);
    return { success: true, key: params.key, tier };
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

    if (typeof hm.promote === 'function') {
      const memoryQuery: any = { query: params.query, k: params.topK || 5 };
      if (params.tier) memoryQuery.tier = params.tier;
      const results = await hm.recall(memoryQuery);
      return { results: results || [], controller: 'hierarchicalMemory' };
    }

    const results = hm.recall(params.query, params.topK || 5);
    const filtered = params.tier
      ? results.filter((r: any) => r.tier === params.tier)
      : results;
    return { results: filtered, controller: 'hierarchicalMemory' };
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
      const recalled = typeof hm.promote === 'function'
        ? await hm.recall({ query: params.query, k: params.maxEntries || 10 })
        : hm.recall(params.query, params.maxEntries || 10);
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

// ===== Utility =====

function cosineSim(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    const ai = a[i], bi = b[i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const mag = Math.sqrt(normA * normB);
  return mag === 0 ? 0 : dot / mag;
}

// ===== Vector stats cache for statusline =====

/**
 * Write vector-stats.json cache file used by the statusline.
 * No-ops if registry isn't loaded.
 */
export function refreshVectorStatsCache(dbPathOverride?: string): void {
  // Synchronous — only runs when the registry is already resolved.
  const registry = resolvedRegistry;
  if (!registry) return;

  try {
    const ctx = getDb(registry);
    if (!ctx?.db) return;

    let vectorCount = 0;
    let namespaces = 0;
    let dbSizeKB = 0;
    let hasHnsw = false;

    try {
      const countRow = ctx.db.prepare(
        'SELECT COUNT(*) as c FROM memory_entries WHERE status = ? AND embedding IS NOT NULL',
      ).get('active') as { c: number } | undefined;
      vectorCount = countRow?.c ?? 0;

      const nsRow = ctx.db.prepare(
        'SELECT COUNT(DISTINCT namespace) as n FROM memory_entries WHERE status = ?',
      ).get('active') as { n: number } | undefined;
      namespaces = nsRow?.n ?? 0;
    } catch {
      // Table may not exist yet
    }

    const dbFile = dbPathOverride || getDbPath();
    try {
      const stat = fs.statSync(dbFile);
      dbSizeKB = Math.floor(stat.size / 1024);
    } catch { /* file may not exist */ }

    const root = getProjectRoot();
    const hnswPaths = [
      path.join(root, '.swarm', 'hnsw.index'),
      path.join(root, '.claude-flow', 'hnsw.index'),
    ];
    for (const p of hnswPaths) {
      try { fs.statSync(p); hasHnsw = true; break; } catch { /* nope */ }
    }

    const cacheDir = path.join(root, '.claude-flow');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'vector-stats.json'),
      JSON.stringify({ vectorCount, dbSizeKB, namespaces, hasHnsw, updatedAt: Date.now() }),
    );
  } catch {
    // Non-fatal — statusline falls back to file size estimate
  }
}
