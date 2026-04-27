/**
 * Shared helpers for moflo-owned controllers (epic #464 Phase C3).
 *
 * Vector-store utilities kept in one place so reflexion / skills /
 * hierarchical-memory don't each reinvent cosine and BLOB serialization.
 */

import { randomBytes } from 'node:crypto';

/**
 * Matches `EmbeddingGenerator` in controller-spec; accepts number[] so
 * fastembed's raw return shape doesn't need coercing at every call site.
 */
export type Embedder = (text: string) => Promise<Float32Array | number[]>;

export function toFloat32(vec: Float32Array | number[]): Float32Array {
  return vec instanceof Float32Array ? vec : Float32Array.from(vec);
}

/**
 * Serialize a vector to a BLOB suitable for sql.js storage. Returns null
 * when no vector is supplied so callers can persist `NULL`.
 */
export function serializeEmbedding(embedding: Float32Array | number[] | null | undefined): Uint8Array | null {
  if (!embedding) return null;
  const arr = toFloat32(embedding);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Reverse of serializeEmbedding. Returns null if the BLOB is absent or
 * malformed (wrong byte alignment for a Float32Array).
 */
export function deserializeEmbedding(blob: unknown): Float32Array | null {
  if (!blob) return null;
  if (!(blob instanceof Uint8Array)) return null;
  if (blob.byteLength === 0 || blob.byteLength % 4 !== 0) return null;
  // Copy into a fresh buffer — sql.js may reuse the underlying storage.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const mag = Math.sqrt(na) * Math.sqrt(nb);
  return mag === 0 ? 0 : dot / mag;
}

/**
 * Embed `text` with the supplied neural embedder.
 *
 * Throws if no embedder is configured or if the embedder itself fails.
 * ADR-EMB-001 makes neural embeddings a hard requirement — silent
 * degradation to hash-quality vectors is a correctness hazard, so this
 * never falls back. Wire a fastembed-backed provider through the
 * controller registry's `embeddingGenerator` config.
 */
export async function embedText(
  embedder: Embedder | undefined,
  text: string,
): Promise<Float32Array> {
  if (!embedder) {
    throw new Error(
      '[moflo memory] No embedder configured. ADR-EMB-001 requires a ' +
        'fastembed-backed IEmbeddingProvider — hash fallbacks are banned. ' +
        "Supply one via RuntimeConfig.embeddingGenerator.",
    );
  }
  return toFloat32(await embedder(text));
}

/**
 * Rank `rows` by cosine similarity against `query`. Rows without an
 * embedding are scored against a keyword-overlap signal so they still
 * participate in recall instead of silently dropping out.
 */
export function rankByVector<T extends { embedding: Float32Array | null; content?: string }>(
  rows: T[],
  query: Float32Array,
  queryText: string,
  k: number,
): Array<T & { score: number }> {
  const scored: Array<T & { score: number }> = [];
  const lowerQuery = queryText.toLowerCase();
  for (const row of rows) {
    let score = 0;
    if (row.embedding) {
      score = cosine(query, row.embedding);
    } else if (row.content) {
      score = keywordOverlap(lowerQuery, row.content.toLowerCase());
    }
    scored.push({ ...row, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, k));
}

function keywordOverlap(lowerQuery: string, lowerContent: string): number {
  if (!lowerQuery || !lowerContent) return 0;
  const tokens = new Set(lowerQuery.split(/[^a-z0-9]+/).filter((t) => t.length > 1));
  if (tokens.size === 0) return 0;
  let hits = 0;
  for (const t of tokens) if (lowerContent.includes(t)) hits++;
  return hits / tokens.size;
}

export function generateId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

/**
 * Bounded-value helpers shared by controllers. `clamp01` is the common
 * score/weight path; `clampInt` coerces pagination/limit arguments.
 */
export function clamp01(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function clampInt(n: unknown, min: number, max: number, fallback: number = min): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * Runtime duck-type check. Small helper so controller-registry can detect
 * moflo-owned controllers without a static import-cycle on the classes.
 */
export function hasMethod(obj: unknown, name: string): boolean {
  return !!obj && typeof (obj as Record<string, unknown>)[name] === 'function';
}

/**
 * Shared vector-search path used by Reflexion and Skills: embed the query,
 * cosine-rank, return top-k with scores and without the synthetic content
 * field used only for keyword fallback.
 */
export async function vectorSearchRows<T extends { embedding: Float32Array | null }>(
  rows: T[],
  queryText: string,
  k: number,
  embedder: Embedder | undefined,
  getContent: (row: T) => string,
): Promise<Array<T & { score: number }>> {
  const safeK = clampInt(k, 1, 1000, 10);
  if (rows.length === 0) return [];
  const queryVec = await embedText(embedder, queryText);
  const withContent = rows.map((r) => ({ ...r, content: getContent(r) }));
  const ranked = rankByVector(withContent, queryVec, queryText, safeK);
  return ranked.map(({ content: _content, ...rest }) => rest as unknown as T & { score: number });
}

export function parseJsonSafe(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
