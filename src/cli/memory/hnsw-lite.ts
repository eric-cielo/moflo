export interface HnswSearchResult {
  id: string;
  score: number;
}

export type HnswMetric = 'cosine' | 'dot' | 'euclidean';
const METRICS: readonly HnswMetric[] = ['cosine', 'dot', 'euclidean'];

const SERIAL_MAGIC = Buffer.from('MFLOHNSW', 'ascii');
const SERIAL_VERSION = 1;
const SERIAL_HEADER_BYTES = 32;
const SERIAL_FLOAT_BYTES = 4;

export class HnswLite {
  private vectors = new Map<string, Float32Array>();
  private neighbors = new Map<string, Set<string>>();
  private readonly dimensions: number;
  private readonly maxNeighbors: number;
  private readonly efConstruction: number;
  private readonly metric: HnswMetric;

  constructor(dimensions: number, m: number, efConstruction: number, metric: HnswMetric | string) {
    this.dimensions = dimensions;
    this.maxNeighbors = m;
    this.efConstruction = efConstruction;
    this.metric = METRICS.includes(metric as HnswMetric) ? (metric as HnswMetric) : 'cosine';
  }

  get size(): number {
    return this.vectors.size;
  }

  add(id: string, vector: Float32Array): void {
    this.vectors.set(id, vector);

    if (this.vectors.size === 1) {
      this.neighbors.set(id, new Set());
      return;
    }

    const nearest = this.findNearest(vector, this.maxNeighbors);
    const neighborSet = new Set<string>();

    for (const n of nearest) {
      neighborSet.add(n.id);
      const nNeighbors = this.neighbors.get(n.id);
      if (nNeighbors) {
        nNeighbors.add(id);
        if (nNeighbors.size > this.maxNeighbors * 2) {
          this.pruneNeighbors(n.id);
        }
      }
    }

    this.neighbors.set(id, neighborSet);
  }

  remove(id: string): void {
    this.vectors.delete(id);
    const myNeighbors = this.neighbors.get(id);
    if (myNeighbors) {
      for (const nId of myNeighbors) {
        this.neighbors.get(nId)?.delete(id);
      }
    }
    this.neighbors.delete(id);
  }

  search(query: Float32Array, k: number, threshold?: number): HnswSearchResult[] {
    if (this.vectors.size === 0) return [];
    if (this.vectors.size <= k * 2) {
      return this.bruteForce(query, k, threshold);
    }

    const visited = new Set<string>();
    const candidates: HnswSearchResult[] = [];

    let entryId: string | undefined;
    let bestScore = -1;
    for (const [id] of this.vectors) {
      const score = this.similarity(query, this.vectors.get(id)!);
      if (score > bestScore) {
        bestScore = score;
        entryId = id;
      }
      if (visited.size >= Math.min(this.efConstruction, this.vectors.size)) break;
      visited.add(id);
      candidates.push({ id, score });
    }

    if (entryId) {
      const queue = [entryId];
      let idx = 0;

      while (idx < queue.length && visited.size < this.efConstruction * 2) {
        const currentId = queue[idx++];
        const currentNeighbors = this.neighbors.get(currentId);
        if (!currentNeighbors) continue;

        for (const nId of currentNeighbors) {
          if (visited.has(nId)) continue;
          visited.add(nId);

          const vec = this.vectors.get(nId);
          if (!vec) continue;

          const score = this.similarity(query, vec);
          candidates.push({ id: nId, score });
          queue.push(nId);
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    let filtered = candidates;
    if (threshold !== undefined) {
      filtered = filtered.filter(c => c.score >= threshold);
    }

    return filtered.slice(0, k);
  }

  /**
   * Serialize the in-memory graph (vectors + neighbor adjacency) to a Buffer
   * suitable for atomic write to `.moflo/hnsw.index`. Format:
   *
   *   bytes  0-7   "MFLOHNSW" magic
   *   byte   8     version (u8)
   *   byte   9     metric code (0 cosine, 1 dot, 2 euclidean)
   *   bytes 10-11  reserved
   *   bytes 12-15  dimensions (u32 LE)
   *   bytes 16-19  maxNeighbors / m (u32 LE)
   *   bytes 20-23  efConstruction (u32 LE)
   *   bytes 24-27  vectorCount (u32 LE)
   *   bytes 28-31  json section length (u32 LE)
   *   bytes 32..   UTF-8 JSON `{ids: string[], neighbors: number[][]}`
   *                — `ids[i]` is the entry id at position i
   *                — `neighbors[i]` lists indices into `ids[]` (not the strings themselves)
   *   then         vectorCount × dimensions × 4 bytes, Float32 LE, in `ids[]` order
   *
   * Indexed-by-position neighbors keep the JSON small even when ids are UUIDs.
   */
  serialize(): Buffer {
    const ids = Array.from(this.vectors.keys());
    const idxOf = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) idxOf.set(ids[i], i);

    const neighborIdx: number[][] = ids.map(id => {
      const set = this.neighbors.get(id);
      if (!set) return [];
      const out: number[] = [];
      for (const nId of set) {
        const i = idxOf.get(nId);
        if (i !== undefined) out.push(i);
      }
      return out;
    });

    const json = JSON.stringify({ ids, neighbors: neighborIdx });
    const jsonBuf = Buffer.from(json, 'utf-8');
    const vectorBytes = ids.length * this.dimensions * SERIAL_FLOAT_BYTES;
    const out = Buffer.alloc(SERIAL_HEADER_BYTES + jsonBuf.length + vectorBytes);

    SERIAL_MAGIC.copy(out, 0);
    out.writeUInt8(SERIAL_VERSION, 8);
    out.writeUInt8(METRICS.indexOf(this.metric), 9);
    // bytes 10-11 reserved (zero-filled by alloc)
    out.writeUInt32LE(this.dimensions, 12);
    out.writeUInt32LE(this.maxNeighbors, 16);
    out.writeUInt32LE(this.efConstruction, 20);
    out.writeUInt32LE(ids.length, 24);
    out.writeUInt32LE(jsonBuf.length, 28);
    jsonBuf.copy(out, SERIAL_HEADER_BYTES);

    // Bulk-copy the vector block — Float32Array shares memory with its
    // backing ArrayBuffer, so a single `Buffer.copy` per vector beats
    // 1.15M scalar writeFloatLE calls (3k × 384) on a typical consumer.
    let offset = SERIAL_HEADER_BYTES + jsonBuf.length;
    const vecBytes = this.dimensions * SERIAL_FLOAT_BYTES;
    for (const id of ids) {
      const vec = this.vectors.get(id)!;
      const srcView = Buffer.from(vec.buffer, vec.byteOffset, vecBytes);
      srcView.copy(out, offset);
      offset += vecBytes;
    }
    return out;
  }

  /**
   * Reconstruct an HnswLite from a serialize() buffer. Throws on bad magic,
   * unknown version, or truncated payload — callers should catch and fall
   * back to rebuilding from the source-of-truth (SQL embedding column).
   */
  static load(buf: Buffer): HnswLite {
    if (buf.length < SERIAL_HEADER_BYTES) {
      throw new Error(`HnswLite.load: buffer too small (${buf.length} < ${SERIAL_HEADER_BYTES})`);
    }
    if (buf.compare(SERIAL_MAGIC, 0, SERIAL_MAGIC.length, 0, SERIAL_MAGIC.length) !== 0) {
      throw new Error(`HnswLite.load: bad magic, expected MFLOHNSW`);
    }
    const version = buf.readUInt8(8);
    if (version !== SERIAL_VERSION) {
      throw new Error(`HnswLite.load: unsupported version ${version} (expected ${SERIAL_VERSION})`);
    }
    const metricCode = buf.readUInt8(9);
    const metric = METRICS[metricCode];
    if (!metric) {
      throw new Error(`HnswLite.load: unknown metric code ${metricCode}`);
    }
    const dimensions = buf.readUInt32LE(12);
    const m = buf.readUInt32LE(16);
    const efConstruction = buf.readUInt32LE(20);
    const vectorCount = buf.readUInt32LE(24);
    const jsonLen = buf.readUInt32LE(28);

    const expectedSize =
      SERIAL_HEADER_BYTES + jsonLen + vectorCount * dimensions * SERIAL_FLOAT_BYTES;
    if (buf.length !== expectedSize) {
      throw new Error(
        `HnswLite.load: size mismatch (have ${buf.length}, expected ${expectedSize})`,
      );
    }

    const json = buf.toString('utf-8', SERIAL_HEADER_BYTES, SERIAL_HEADER_BYTES + jsonLen);
    let parsed: { ids: string[]; neighbors: number[][] };
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new Error(`HnswLite.load: malformed JSON section — ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed.ids) || !Array.isArray(parsed.neighbors)) {
      throw new Error(`HnswLite.load: JSON missing ids[] or neighbors[]`);
    }
    if (parsed.ids.length !== vectorCount || parsed.neighbors.length !== vectorCount) {
      throw new Error(
        `HnswLite.load: JSON arity mismatch (ids=${parsed.ids.length}, neighbors=${parsed.neighbors.length}, expected ${vectorCount})`,
      );
    }

    const inst = new HnswLite(dimensions, m, efConstruction, metric);
    // Bulk-decode floats: each vector is `dim × 4` contiguous LE bytes.
    // We can't view-into-place because the JSON section is variable
    // length — `SERIAL_HEADER_BYTES + jsonLen` rarely lands on a 4-byte
    // boundary, and Float32Array views require aligned start offsets.
    // Allocate the typed array first (always aligned) and memcpy bytes
    // into its backing buffer. One copy per vector vs. `dim` scalar
    // readFloatLE calls. Hot path — every cold-start memory search lands
    // here.
    const vecBytes = dimensions * SERIAL_FLOAT_BYTES;
    let offset = SERIAL_HEADER_BYTES + jsonLen;
    for (let i = 0; i < vectorCount; i++) {
      const vec = new Float32Array(dimensions);
      Buffer.from(vec.buffer).set(buf.subarray(offset, offset + vecBytes));
      inst.vectors.set(parsed.ids[i], vec);
      offset += vecBytes;
    }
    for (let i = 0; i < vectorCount; i++) {
      const nSet = new Set<string>();
      for (const nIdx of parsed.neighbors[i]) {
        const nId = parsed.ids[nIdx];
        if (nId !== undefined) nSet.add(nId);
      }
      inst.neighbors.set(parsed.ids[i], nSet);
    }
    return inst;
  }

  private bruteForce(query: Float32Array, k: number, threshold?: number): HnswSearchResult[] {
    const results: HnswSearchResult[] = [];
    for (const [id, vec] of this.vectors) {
      const score = this.similarity(query, vec);
      if (threshold !== undefined && score < threshold) continue;
      results.push({ id, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  private findNearest(query: Float32Array, k: number): HnswSearchResult[] {
    return this.bruteForce(query, k);
  }

  private pruneNeighbors(id: string): void {
    const myNeighbors = this.neighbors.get(id);
    if (!myNeighbors) return;

    const vec = this.vectors.get(id);
    if (!vec) return;

    const scored: HnswSearchResult[] = [];
    for (const nId of myNeighbors) {
      const nVec = this.vectors.get(nId);
      if (!nVec) continue;
      scored.push({ id: nId, score: this.similarity(vec, nVec) });
    }

    scored.sort((a, b) => b.score - a.score);
    const keep = new Set(scored.slice(0, this.maxNeighbors).map(s => s.id));

    for (const nId of myNeighbors) {
      if (!keep.has(nId)) {
        myNeighbors.delete(nId);
      }
    }
  }

  private similarity(a: Float32Array, b: Float32Array): number {
    if (this.metric === 'dot') return dotProduct(a, b);
    if (this.metric === 'euclidean') return 1 / (1 + euclideanDistance(a, b));
    return cosineSimilarity(a, b);
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

function euclideanDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}
