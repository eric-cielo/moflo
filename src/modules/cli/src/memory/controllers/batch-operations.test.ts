import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { Database } from 'sql.js';
import { BatchOperations } from './batch-operations.js';

let SQL: any;

beforeAll(async () => {
  SQL = await initSqlJs();
});

describe('BatchOperations', () => {
  let db: Database;
  let bo: BatchOperations;

  beforeEach(() => {
    db = new SQL.Database();
    bo = new BatchOperations(db as any);
  });

  describe('insertEpisodes', () => {
    it('inserts episodes and returns ids', async () => {
      const r = await bo.insertEpisodes([
        { content: 'alpha' },
        { content: 'bravo', metadata: { key: 'b-key' } },
      ]);
      expect(r.inserted).toBe(2);
      expect(r.ids).toHaveLength(2);
    });

    it('handles empty input as a no-op', async () => {
      const r = await bo.insertEpisodes([]);
      expect(r).toEqual({ inserted: 0, ids: [] });
    });

    it('rolls back the entire batch on failure', async () => {
      await bo.insertEpisodes([{ content: 'seed' }]);
      const seedCount = rowCount(db, BatchOperations.EPISODES_TABLE);

      // Force the batch to fail mid-transaction by passing a value that
      // won't serialize — bigint gets bound cleanly, so use circular ref
      // inside metadata to break JSON.stringify.
      const circular: any = {};
      circular.self = circular;
      await expect(
        bo.insertEpisodes([{ content: 'ok-1' }, { content: 'bad', metadata: circular }]),
      ).rejects.toThrow();

      expect(rowCount(db, BatchOperations.EPISODES_TABLE)).toBe(seedCount);
    });

    it('serializes Float32Array embeddings as BLOB', async () => {
      const emb = Float32Array.from([0.1, 0.2, 0.3]);
      const r = await bo.insertEpisodes([{ content: 'x', embedding: emb }]);
      expect(r.inserted).toBe(1);
      const row = queryOne(db, `SELECT embedding FROM ${BatchOperations.EPISODES_TABLE} WHERE id = ?`, [r.ids[0]]);
      expect(row.embedding).toBeInstanceOf(Uint8Array);
      expect((row.embedding as Uint8Array).byteLength).toBe(emb.byteLength);
    });
  });

  describe('bulkDelete', () => {
    it('deletes by key', async () => {
      await bo.insertEpisodes([
        { content: 'a', metadata: { key: 'k-a' } },
        { content: 'b', metadata: { key: 'k-b' } },
      ]);
      const r = await bo.bulkDelete('episodes', { key: 'k-a' });
      expect(r.deleted).toBe(1);
      expect(rowCount(db, BatchOperations.EPISODES_TABLE)).toBe(1);
    });

    it('refuses unbounded delete', async () => {
      await expect(bo.bulkDelete('episodes', {})).rejects.toThrow(/at least one condition/i);
    });

    it('rejects non-whitelisted tables', async () => {
      await expect(bo.bulkDelete('users', { id: 1 })).rejects.toThrow(/not whitelisted/i);
    });

    it('rejects unsafe identifiers in conditions', async () => {
      await expect(bo.bulkDelete('episodes', { 'key; DROP TABLE x --': 1 })).rejects.toThrow(/unsafe/i);
    });
  });

  describe('bulkUpdate', () => {
    it('updates matching rows', async () => {
      await bo.insertEpisodes([
        { content: 'old', metadata: { key: 'k-1' } },
        { content: 'old', metadata: { key: 'k-2' } },
      ]);
      const r = await bo.bulkUpdate('episodes', { content: 'new' }, { key: 'k-1' });
      expect(r.updated).toBe(1);
      const row = queryOne(db, `SELECT content FROM ${BatchOperations.EPISODES_TABLE} WHERE key = ?`, ['k-1']);
      expect(row.content).toBe('new');
    });

    it('is a no-op when updates is empty', async () => {
      await bo.insertEpisodes([{ content: 'x', metadata: { key: 'k' } }]);
      const r = await bo.bulkUpdate('episodes', {}, { key: 'k' });
      expect(r.updated).toBe(0);
    });

    it('rejects unsafe update columns', async () => {
      await expect(bo.bulkUpdate('episodes', { 'content; DROP TABLE x --': 1 }, { key: 'k' })).rejects.toThrow(/unsafe/i);
    });
  });

  it('rejects null db', () => {
    expect(() => new BatchOperations(null as any)).toThrow(/requires a sql\.js/i);
  });
});

function rowCount(db: Database, table: string): number {
  const stmt = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`);
  stmt.step();
  const n = Number(stmt.getAsObject().n ?? 0);
  stmt.free();
  return n;
}

function queryOne(db: Database, sql: string, params: any[]): Record<string, any> {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  return row;
}
