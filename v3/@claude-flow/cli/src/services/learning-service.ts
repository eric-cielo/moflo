/**
 * Learning Service
 *
 * Persistent pattern learning with HNSW indexing and sql.js backend.
 * Manages short-term and long-term pattern storage with automatic
 * promotion, deduplication, and consolidation.
 *
 * Features:
 * - Pattern storage/search with sql.js backend (.swarm/memory.db)
 * - Short-term -> long-term pattern promotion (promote after 3 uses)
 * - Quality thresholds: minimum quality 0.6, dedup threshold 0.95
 * - Consolidation: max 500 short-term, 2000 long-term, prune after 30 days
 * - HNSW indexing for fast similarity search
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  hnsw: {
    M: 16,
    efConstruction: 200,
    efSearch: 100,
  },
  patterns: {
    promotionThreshold: 3,
    qualityThreshold: 0.6,
    maxShortTerm: 500,
    maxLongTerm: 2000,
    dedupThreshold: 0.95,
  },
  embedding: {
    dimension: 384,
  },
  consolidation: {
    pruneAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    minUsageForKeep: 2,
  },
};

// ============================================================================
// HNSW Index (in-memory with graph-based search)
// ============================================================================

class HNSWIndex {
  private vectors = new Map<number, Float32Array>();
  private idToVector = new Map<string, number>();
  private vectorToId = new Map<number, string>();
  private nextVectorId = 0;
  private layers: Map<number, Set<number>>[] = [];
  private entryPoint: number | null = null;
  private readonly maxConnections: number;

  constructor(maxConnections = CONFIG.hnsw.M) {
    this.maxConnections = maxConnections;
  }

  add(patternId: string, embedding: Float32Array): number {
    const vectorId = this.nextVectorId++;
    this.vectors.set(vectorId, embedding);
    this.idToVector.set(patternId, vectorId);
    this.vectorToId.set(vectorId, patternId);
    this.insertIntoGraph(vectorId, embedding);
    return vectorId;
  }

  search(queryEmbedding: Float32Array, k = 5): { results: SearchResult[]; searchTimeMs: number } {
    if (this.vectors.size === 0) return { results: [], searchTimeMs: 0 };

    const startTime = performance.now();
    const candidates = this.searchGraph(queryEmbedding, k * 2);
    const results = candidates
      .map(({ vectorId, distance }) => ({
        patternId: this.vectorToId.get(vectorId)!,
        similarity: 1 - distance,
        vectorId,
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);

    return { results, searchTimeMs: performance.now() - startTime };
  }

  remove(patternId: string): boolean {
    const vectorId = this.idToVector.get(patternId);
    if (vectorId === undefined) return false;

    this.vectors.delete(vectorId);
    this.idToVector.delete(patternId);
    this.vectorToId.delete(vectorId);
    this.removeFromGraph(vectorId);
    return true;
  }

  size(): number {
    return this.vectors.size;
  }

  private cosineDistance(a: Float32Array, b: Float32Array): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? 1 - dot / denom : 1;
  }

  private insertIntoGraph(vectorId: number, vector: Float32Array): void {
    if (this.entryPoint === null) {
      this.entryPoint = vectorId;
      this.layers.push(new Map([[vectorId, new Set()]]));
      return;
    }

    if (this.layers.length === 0) {
      this.layers.push(new Map());
    }

    const layer = this.layers[0];
    layer.set(vectorId, new Set());

    // Find M nearest neighbors and connect
    const neighbors = this.findNearestBrute(vector, this.maxConnections);
    for (const { vectorId: neighborId } of neighbors) {
      layer.get(vectorId)!.add(neighborId);
      layer.get(neighborId)?.add(vectorId);

      // Prune excess connections
      const neighborConns = layer.get(neighborId);
      if (neighborConns && neighborConns.size > this.maxConnections * 2) {
        this.pruneConnections(neighborId);
      }
    }
  }

  private searchGraph(query: Float32Array, k: number): { vectorId: number; distance: number }[] {
    if (this.vectors.size <= k) {
      return Array.from(this.vectors.entries())
        .map(([vectorId, vector]) => ({ vectorId, distance: this.cosineDistance(query, vector) }))
        .sort((a, b) => a.distance - b.distance);
    }

    const visited = new Set<number>();
    const candidates = new Map<number, number>();
    const results: { vectorId: number; distance: number }[] = [];
    const layer = this.layers[0];

    let current = this.entryPoint!;
    let currentDist = this.cosineDistance(query, this.vectors.get(current)!);
    candidates.set(current, currentDist);
    results.push({ vectorId: current, distance: currentDist });

    let improved = true;
    let iterations = 0;

    while (improved && iterations < CONFIG.hnsw.efSearch) {
      improved = false;
      iterations++;

      let bestCandidate: number | null = null;
      let bestDist = Infinity;

      for (const [id, dist] of candidates) {
        if (!visited.has(id) && dist < bestDist) {
          bestDist = dist;
          bestCandidate = id;
        }
      }

      if (bestCandidate === null) break;
      visited.add(bestCandidate);

      const neighbors = layer.get(bestCandidate) || new Set();
      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        const neighborVector = this.vectors.get(neighborId);
        if (!neighborVector) continue;

        const dist = this.cosineDistance(query, neighborVector);
        if (!candidates.has(neighborId) || candidates.get(neighborId)! > dist) {
          candidates.set(neighborId, dist);
          results.push({ vectorId: neighborId, distance: dist });
          improved = true;
        }
      }
    }

    return results.sort((a, b) => a.distance - b.distance).slice(0, k);
  }

  private findNearestBrute(query: Float32Array, k: number): { vectorId: number; distance: number }[] {
    return Array.from(this.vectors.entries())
      .map(([vectorId, vector]) => ({ vectorId, distance: this.cosineDistance(query, vector) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k);
  }

  private pruneConnections(vectorId: number): void {
    const layer = this.layers[0];
    const connections = layer.get(vectorId);
    if (!connections || connections.size <= this.maxConnections) return;

    const vector = this.vectors.get(vectorId)!;
    const scored = Array.from(connections)
      .map(neighborId => ({
        neighborId,
        distance: this.cosineDistance(vector, this.vectors.get(neighborId)!),
      }))
      .sort((a, b) => a.distance - b.distance);

    const toRemove = scored.slice(this.maxConnections);
    for (const { neighborId } of toRemove) {
      connections.delete(neighborId);
      layer.get(neighborId)?.delete(vectorId);
    }
  }

  private removeFromGraph(vectorId: number): void {
    const layer = this.layers[0];
    if (!layer) return;

    const connections = layer.get(vectorId);
    if (connections) {
      for (const neighborId of connections) {
        layer.get(neighborId)?.delete(vectorId);
      }
    }
    layer.delete(vectorId);

    if (this.entryPoint === vectorId) {
      this.entryPoint = layer.size > 0 ? layer.keys().next().value ?? null : null;
    }
  }
}

// ============================================================================
// Types
// ============================================================================

interface SearchResult {
  patternId: string;
  similarity: number;
  vectorId: number;
}

interface PatternRow {
  id: string;
  pattern: string;
  domain: string;
  quality: number;
  uses: number;
  tier: string;
  embedding: Uint8Array | null;
  created_at: string;
  last_used_at: string | null;
  promoted_at: string | null;
}

interface PatternSearchResult {
  patternId: string;
  similarity: number;
  pattern: string;
  domain: string;
  quality: number;
  uses: number;
  tier: string;
}

interface StoreResult {
  id: string;
  action: 'created' | 'updated';
  similarity?: number;
}

interface ConsolidateResult {
  promoted: number;
  pruned: number;
  deduplicated: number;
  durationMs: number;
}

interface LearningStats {
  shortTermPatterns: number;
  longTermPatterns: number;
  totalPatterns: number;
  avgQuality: number;
  domains: string[];
}

// ============================================================================
// sql.js helpers
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqlJsDatabase = any;

async function loadSqlJs(): Promise<{ Database: new (data?: ArrayLike<number>) => SqlJsDatabase }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initSqlJs = (await import('sql.js')).default as any;
  return initSqlJs();
}

function dbAll(db: SqlJsDatabase, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function dbGet(db: SqlJsDatabase, sql: string, params: unknown[] = []): Record<string, unknown> | null {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  let row: Record<string, unknown> | null = null;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
}

function dbRun(db: SqlJsDatabase, sql: string, params: unknown[] = []): { changes: number } {
  db.run(sql, params);
  return { changes: db.getRowsModified() as number };
}

// ============================================================================
// Embedding (deterministic hash-based fallback)
// ============================================================================

function hashEmbed(text: string): Float32Array {
  const embedding = new Float32Array(CONFIG.embedding.dimension);
  const normalized = text.toLowerCase().trim();

  for (let i = 0; i < embedding.length; i++) {
    let hash = 0;
    for (let j = 0; j < normalized.length; j++) {
      hash = ((hash << 5) - hash + normalized.charCodeAt(j) * (i + 1)) | 0;
    }
    embedding[i] = (Math.sin(hash) + 1) / 2;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < embedding.length; i++) {
    norm += embedding[i] * embedding[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] /= norm;
    }
  }

  return embedding;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

// ============================================================================
// Learning Service
// ============================================================================

export class LearningService {
  private db: SqlJsDatabase | null = null;
  private shortTermIndex = new HNSWIndex();
  private longTermIndex = new HNSWIndex();
  private dirty = false;
  private dbPath: string;
  private dataDir: string;

  constructor(projectRoot?: string) {
    const root = projectRoot || process.cwd();
    this.dataDir = join(root, '.swarm');
    this.dbPath = join(this.dataDir, 'memory.db');
  }

  /**
   * Initialize the learning service, opening or creating the DB.
   */
  async initialize(): Promise<void> {
    if (this.db) return;

    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    const SQL = await loadSqlJs();

    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    this.ensureSchema();
    this.loadIndexes();
  }

  /**
   * Store a learning pattern.
   */
  async storePattern(pattern: string, domain = 'general', quality = 0.5): Promise<StoreResult> {
    this.requireDb();

    if (quality < CONFIG.patterns.qualityThreshold) {
      quality = CONFIG.patterns.qualityThreshold;
    }

    const embedding = hashEmbed(pattern);

    // Check for duplicates via HNSW
    const { results } = this.shortTermIndex.search(embedding, 1);
    if (results.length > 0 && results[0].similarity > CONFIG.patterns.dedupThreshold) {
      const existingId = results[0].patternId;
      dbRun(this.db!, `
        UPDATE learned_patterns
        SET uses = uses + 1, last_used_at = datetime('now'), quality = MAX(quality, ?)
        WHERE id = ?
      `, [quality, existingId]);
      this.dirty = true;
      this.checkPromotion(existingId);
      return { id: existingId, action: 'updated', similarity: results[0].similarity };
    }

    // Also check long-term
    const { results: ltResults } = this.longTermIndex.search(embedding, 1);
    if (ltResults.length > 0 && ltResults[0].similarity > CONFIG.patterns.dedupThreshold) {
      const existingId = ltResults[0].patternId;
      dbRun(this.db!, `
        UPDATE learned_patterns
        SET uses = uses + 1, last_used_at = datetime('now'), quality = MAX(quality, ?)
        WHERE id = ?
      `, [quality, existingId]);
      this.dirty = true;
      return { id: existingId, action: 'updated', similarity: ltResults[0].similarity };
    }

    const id = `pat_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const embeddingJson = JSON.stringify(Array.from(embedding));

    dbRun(this.db!, `
      INSERT INTO learned_patterns (id, pattern, domain, quality, uses, tier, embedding, created_at)
      VALUES (?, ?, ?, ?, 1, 'short-term', ?, datetime('now'))
    `, [id, pattern, domain, quality, embeddingJson]);
    this.dirty = true;

    this.shortTermIndex.add(id, embedding);
    this.pruneShortTerm();

    return { id, action: 'created' };
  }

  /**
   * Search for patterns similar to the query.
   */
  async searchPatterns(query: string, k = 5): Promise<PatternSearchResult[]> {
    this.requireDb();

    const embedding = hashEmbed(query);
    const results: (SearchResult & { type: string })[] = [];

    // Search long-term first (higher quality)
    const lt = this.longTermIndex.search(embedding, k);
    results.push(...lt.results.map(r => ({ ...r, type: 'long-term' })));

    // Search short-term
    const st = this.shortTermIndex.search(embedding, k);
    results.push(...st.results.map(r => ({ ...r, type: 'short-term' })));

    // Sort by similarity, deduplicate, take top k
    results.sort((a, b) => b.similarity - a.similarity);
    const seen = new Set<string>();
    const deduped = results.filter(r => {
      if (seen.has(r.patternId)) return false;
      seen.add(r.patternId);
      return true;
    }).slice(0, k);

    // Fetch full pattern data
    return deduped.map(r => {
      const row = dbGet(this.db!, 'SELECT * FROM learned_patterns WHERE id = ?', [r.patternId]);
      return {
        patternId: r.patternId,
        similarity: r.similarity,
        pattern: (row?.pattern as string) || '',
        domain: (row?.domain as string) || 'general',
        quality: (row?.quality as number) || 0,
        uses: (row?.uses as number) || 0,
        tier: (row?.tier as string) || 'short-term',
      };
    }).filter(r => r.pattern); // Filter out patterns not found in DB
  }

  /**
   * Promote short-term patterns that meet the threshold.
   */
  async promotePatterns(): Promise<number> {
    this.requireDb();

    const candidates = dbAll(this.db!, `
      SELECT id FROM learned_patterns
      WHERE tier = 'short-term'
        AND uses >= ?
        AND quality >= ?
    `, [CONFIG.patterns.promotionThreshold, CONFIG.patterns.qualityThreshold]) as { id: string }[];

    let promoted = 0;
    for (const { id } of candidates) {
      const ok = this.checkPromotion(id);
      if (ok) promoted++;
    }

    if (promoted > 0) this.save();
    return promoted;
  }

  /**
   * Consolidate patterns: promote eligible, prune old, deduplicate.
   */
  async consolidate(): Promise<ConsolidateResult> {
    this.requireDb();
    const startTime = Date.now();

    // 1. Promote eligible short-term patterns
    const promoted = await this.promotePatterns();

    // 2. Prune old short-term patterns (older than 30 days, low usage)
    const pruneDate = new Date(Date.now() - CONFIG.consolidation.pruneAge).toISOString();
    const pruned = dbRun(this.db!, `
      DELETE FROM learned_patterns
      WHERE tier = 'short-term'
        AND created_at < ?
        AND uses < ?
    `, [pruneDate, CONFIG.consolidation.minUsageForKeep]);

    // 3. Prune old long-term patterns
    const ltPruned = dbRun(this.db!, `
      DELETE FROM learned_patterns
      WHERE tier = 'long-term'
        AND last_used_at IS NOT NULL
        AND last_used_at < ?
        AND uses < ?
    `, [pruneDate, CONFIG.consolidation.minUsageForKeep]);

    // 4. Enforce max limits
    this.enforceMaxShortTerm();
    this.enforceMaxLongTerm();

    // 5. Deduplicate long-term patterns
    const deduplicated = this.deduplicateLongTerm();

    // Rebuild indexes
    this.loadIndexes();
    this.dirty = true;
    this.save();

    return {
      promoted,
      pruned: pruned.changes + ltPruned.changes,
      deduplicated,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Get statistics about stored patterns.
   */
  getStats(): LearningStats {
    this.requireDb();

    const stRow = dbGet(this.db!, `SELECT COUNT(*) as count FROM learned_patterns WHERE tier = 'short-term'`);
    const ltRow = dbGet(this.db!, `SELECT COUNT(*) as count FROM learned_patterns WHERE tier = 'long-term'`);
    const avgRow = dbGet(this.db!, `SELECT AVG(quality) as avg FROM learned_patterns`);
    const domainRows = dbAll(this.db!, `SELECT DISTINCT domain FROM learned_patterns ORDER BY domain`);

    const shortTerm = (stRow?.count as number) || 0;
    const longTerm = (ltRow?.count as number) || 0;

    return {
      shortTermPatterns: shortTerm,
      longTermPatterns: longTerm,
      totalPatterns: shortTerm + longTerm,
      avgQuality: (avgRow?.avg as number) || 0,
      domains: domainRows.map(r => r.domain as string),
    };
  }

  /**
   * List patterns, optionally filtered by domain.
   */
  listPatterns(domain?: string, limit = 50): PatternRow[] {
    this.requireDb();

    let sql = 'SELECT * FROM learned_patterns';
    const params: unknown[] = [];

    if (domain) {
      sql += ' WHERE domain = ?';
      params.push(domain);
    }

    sql += ' ORDER BY quality DESC, uses DESC LIMIT ?';
    params.push(limit);

    return dbAll(this.db!, sql, params) as unknown as PatternRow[];
  }

  /**
   * Save DB to disk and close.
   */
  close(): void {
    if (this.db) {
      if (this.dirty) {
        this.save();
      }
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Save DB to disk.
   */
  save(): void {
    if (!this.db) return;
    const data = this.db.export();
    writeFileSync(this.dbPath, Buffer.from(data));
    this.dirty = false;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private requireDb(): void {
    if (!this.db) {
      throw new Error('LearningService not initialized. Call initialize() first.');
    }
  }

  private ensureSchema(): void {
    this.db!.run(`
      CREATE TABLE IF NOT EXISTS learned_patterns (
        id TEXT PRIMARY KEY,
        pattern TEXT NOT NULL,
        domain TEXT DEFAULT 'general',
        quality REAL DEFAULT 0.5,
        uses INTEGER DEFAULT 0,
        tier TEXT DEFAULT 'short-term',
        embedding TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        last_used_at TEXT,
        promoted_at TEXT
      )
    `);
    this.db!.run(`CREATE INDEX IF NOT EXISTS idx_lp_domain ON learned_patterns(domain)`);
    this.db!.run(`CREATE INDEX IF NOT EXISTS idx_lp_tier ON learned_patterns(tier)`);
    this.db!.run(`CREATE INDEX IF NOT EXISTS idx_lp_quality ON learned_patterns(quality DESC)`);
    this.dirty = true;
  }

  private loadIndexes(): void {
    this.shortTermIndex = new HNSWIndex();
    this.longTermIndex = new HNSWIndex();

    const rows = dbAll(this.db!, 'SELECT id, tier, embedding FROM learned_patterns') as
      { id: string; tier: string; embedding: string | null }[];

    for (const row of rows) {
      if (!row.embedding) continue;
      try {
        const vec = new Float32Array(JSON.parse(row.embedding));
        if (row.tier === 'long-term') {
          this.longTermIndex.add(row.id, vec);
        } else {
          this.shortTermIndex.add(row.id, vec);
        }
      } catch {
        // Skip corrupt embeddings
      }
    }
  }

  private checkPromotion(patternId: string): boolean {
    const row = dbGet(this.db!, 'SELECT * FROM learned_patterns WHERE id = ? AND tier = ?', [patternId, 'short-term']);
    if (!row) return false;

    const uses = row.uses as number;
    const quality = row.quality as number;

    if (uses >= CONFIG.patterns.promotionThreshold && quality >= CONFIG.patterns.qualityThreshold) {
      dbRun(this.db!, `
        UPDATE learned_patterns SET tier = 'long-term', promoted_at = datetime('now') WHERE id = ?
      `, [patternId]);
      this.dirty = true;

      // Move between indexes
      const embStr = row.embedding as string | null;
      if (embStr) {
        try {
          const vec = new Float32Array(JSON.parse(embStr));
          this.shortTermIndex.remove(patternId);
          this.longTermIndex.add(patternId, vec);
        } catch {
          // Index will be rebuilt on next load
        }
      }

      return true;
    }

    return false;
  }

  private pruneShortTerm(): void {
    const countRow = dbGet(this.db!, `SELECT COUNT(*) as count FROM learned_patterns WHERE tier = 'short-term'`);
    const count = (countRow?.count as number) || 0;

    if (count <= CONFIG.patterns.maxShortTerm) return;

    const toRemove = count - CONFIG.patterns.maxShortTerm;
    const ids = dbAll(this.db!, `
      SELECT id FROM learned_patterns
      WHERE tier = 'short-term'
      ORDER BY quality ASC, uses ASC
      LIMIT ?
    `, [toRemove]) as { id: string }[];

    for (const { id } of ids) {
      dbRun(this.db!, 'DELETE FROM learned_patterns WHERE id = ?', [id]);
      this.shortTermIndex.remove(id);
    }
    this.dirty = true;
  }

  private enforceMaxShortTerm(): void {
    this.pruneShortTerm();
  }

  private enforceMaxLongTerm(): void {
    const countRow = dbGet(this.db!, `SELECT COUNT(*) as count FROM learned_patterns WHERE tier = 'long-term'`);
    const count = (countRow?.count as number) || 0;

    if (count <= CONFIG.patterns.maxLongTerm) return;

    const toRemove = count - CONFIG.patterns.maxLongTerm;
    const ids = dbAll(this.db!, `
      SELECT id FROM learned_patterns
      WHERE tier = 'long-term'
      ORDER BY quality ASC, uses ASC
      LIMIT ?
    `, [toRemove]) as { id: string }[];

    for (const { id } of ids) {
      dbRun(this.db!, 'DELETE FROM learned_patterns WHERE id = ?', [id]);
    }
    this.dirty = true;
  }

  private deduplicateLongTerm(): number {
    const patterns = dbAll(this.db!, `
      SELECT id, embedding, quality FROM learned_patterns WHERE tier = 'long-term'
    `) as { id: string; embedding: string | null; quality: number }[];

    const toDelete = new Set<string>();
    for (let i = 0; i < patterns.length; i++) {
      if (toDelete.has(patterns[i].id)) continue;
      if (!patterns[i].embedding) continue;

      let vecI: Float32Array;
      try {
        vecI = new Float32Array(JSON.parse(patterns[i].embedding!));
      } catch {
        continue;
      }

      for (let j = i + 1; j < patterns.length; j++) {
        if (toDelete.has(patterns[j].id)) continue;
        if (!patterns[j].embedding) continue;

        let vecJ: Float32Array;
        try {
          vecJ = new Float32Array(JSON.parse(patterns[j].embedding!));
        } catch {
          continue;
        }

        const sim = cosineSimilarity(vecI, vecJ);
        if (sim > CONFIG.patterns.dedupThreshold) {
          // Remove the lower quality one
          const removeId = patterns[i].quality >= patterns[j].quality
            ? patterns[j].id
            : patterns[i].id;
          toDelete.add(removeId);
        }
      }
    }

    for (const id of toDelete) {
      dbRun(this.db!, 'DELETE FROM learned_patterns WHERE id = ?', [id]);
    }

    return toDelete.size;
  }
}

// Singleton instance for service access
let _instance: LearningService | null = null;

export function getLearningService(projectRoot?: string): LearningService {
  if (!_instance) {
    _instance = new LearningService(projectRoot);
  }
  return _instance;
}

export { CONFIG as LEARNING_CONFIG, HNSWIndex, hashEmbed, cosineSimilarity };
export type { PatternSearchResult, StoreResult, ConsolidateResult, LearningStats, PatternRow };
