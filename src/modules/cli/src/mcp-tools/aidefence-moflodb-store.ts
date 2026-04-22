/**
 * MofloDb-backed VectorStore adapter for AIDefence.
 *
 * Wraps the CLI memory-bridge (MofloDb v3 + HNSW + embeddings) so the
 * 6 aidefence_* MCP tools persist learned threat patterns and mitigation
 * strategies across process restarts with 150x-12,500x faster search.
 *
 * @moflo/aidefence stays pure-lib: this adapter lives in the CLI package
 * where the bridge is already available. Arbitrary values are JSON-serialised
 * into the bridge's `content` field; namespaces are prefixed with
 * `aidefence:` to isolate from general memory entries.
 */
import {
  bridgeStoreEntry,
  bridgeSearchEntries,
  bridgeGetEntry,
  bridgeDeleteEntry,
  isBridgeAvailable,
} from '../memory/memory-bridge.js';

// Structural duck-typed shape of @moflo/aidefence's VectorStore interface.
// Declared locally to avoid cross-package type resolution fragility; TypeScript
// verifies compatibility structurally when passed to createAIDefence().

const NS_PREFIX = 'aidefence:';

function prefixNs(namespace: string): string {
  return `${NS_PREFIX}${namespace}`;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export class MofloDbAIDefenceStore {
  async store(params: {
    namespace: string;
    key: string;
    value: unknown;
    embedding?: number[];
    ttl?: number;
  }): Promise<void> {
    await bridgeStoreEntry({
      namespace: prefixNs(params.namespace),
      key: params.key,
      value: JSON.stringify(params.value),
      ttl: params.ttl,
      upsert: true,
    });
  }

  async search(params: {
    namespace: string;
    query: string | number[];
    k?: number;
    minSimilarity?: number;
  }): Promise<Array<{ key: string; value: unknown; similarity: number }>> {
    const queryStr =
      typeof params.query === 'string' ? params.query : JSON.stringify(params.query);

    const result = await bridgeSearchEntries({
      namespace: prefixNs(params.namespace),
      query: queryStr,
      limit: params.k ?? 10,
      threshold: params.minSimilarity ?? 0,
    });

    if (!result?.results) return [];

    return result.results.map(r => ({
      key: r.key,
      value: safeParse(r.content),
      similarity: r.score,
    }));
  }

  async get(namespace: string, key: string): Promise<unknown | null> {
    const result = await bridgeGetEntry({
      namespace: prefixNs(namespace),
      key,
    });
    if (!result?.found || !result.entry) return null;
    return safeParse(result.entry.content);
  }

  async delete(namespace: string, key: string): Promise<void> {
    await bridgeDeleteEntry({
      namespace: prefixNs(namespace),
      key,
    });
  }
}

/**
 * Return an MofloDb-backed store if the memory bridge is available,
 * otherwise null so the caller can fall back to the default in-memory store.
 */
export async function tryCreateMofloDbStore(): Promise<MofloDbAIDefenceStore | null> {
  const available = await isBridgeAvailable();
  return available ? new MofloDbAIDefenceStore() : null;
}
