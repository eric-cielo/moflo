/**
 * In-memory test fake for `SwarmMemoryFns`.
 *
 * Lets persistence-using tests assert the same writes that would have hit
 * moflo.db in production, without touching sql.js. Leading underscore signals
 * "test fixture, not a test" — vitest's `*.{test,spec}.ts` include glob
 * skips it.
 */

import type { SwarmMemoryFns } from '../../swarm/swarm-persistence.js';

export interface FakeRow {
  key: string;
  namespace: string;
  content: string;
}

export interface InMemoryPersistenceBackend {
  fns: SwarmMemoryFns;
  rows: Map<string, FakeRow>;
}

export function createInMemoryPersistence(): InMemoryPersistenceBackend {
  const rows = new Map<string, FakeRow>();
  const compositeKey = (namespace: string, key: string) => `${namespace}::${key}`;

  const fns: SwarmMemoryFns = {
    async storeEntry(opts) {
      rows.set(compositeKey(opts.namespace, opts.key), {
        key: opts.key,
        namespace: opts.namespace,
        content: opts.value,
      });
      return { success: true, id: `id_${rows.size}` };
    },
    async getEntry(opts) {
      const ns = opts.namespace ?? 'default';
      const row = rows.get(compositeKey(ns, opts.key));
      if (!row) return { success: true, found: false };
      return { success: true, found: true, entry: { content: row.content } };
    },
    async listEntries(opts) {
      const ns = opts.namespace;
      const entries = ns
        ? Array.from(rows.values()).filter(r => r.namespace === ns)
        : Array.from(rows.values());
      return {
        success: true,
        entries: entries.map(r => ({ key: r.key })),
        total: entries.length,
      };
    },
    async deleteEntry(opts) {
      const ns = opts.namespace ?? 'default';
      const existed = rows.delete(compositeKey(ns, opts.key));
      return { success: true, deleted: existed };
    },
  };

  return { fns, rows };
}
