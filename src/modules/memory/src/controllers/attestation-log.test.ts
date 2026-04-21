import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { Database } from 'sql.js';
import { AttestationLog } from './attestation-log.js';

let SQL: any;

beforeAll(async () => {
  SQL = await initSqlJs();
});

describe('AttestationLog', () => {
  let db: Database;
  let log: AttestationLog;

  beforeEach(() => {
    db = new SQL.Database();
    log = new AttestationLog(db as any);
  });

  it('creates schema idempotently', () => {
    // Re-instantiating on the same db must not throw.
    const second = new AttestationLog(db as any);
    expect(second.count()).toBe(0);
  });

  it('records entries via record() and counts them', () => {
    log.record({ operation: 'store', entryId: 'e-1', ns: 'default' });
    log.record({ operation: 'delete', entryId: 'e-2', timestamp: 123 });
    expect(log.count()).toBe(2);
  });

  it('records entries via log() alternate signature', () => {
    log.log('store', 'e-1', { source: 'test' });
    log.log('store', 'e-2');
    expect(log.count()).toBe(2);
  });

  it('preserves insertion order in list()', () => {
    log.record({ operation: 'a', entryId: '1' });
    log.record({ operation: 'b', entryId: '2' });
    log.record({ operation: 'c', entryId: '3' });
    const list = log.list();
    expect(list.map((e) => e.operation)).toEqual(['c', 'b', 'a']); // newest-first
    expect(list.map((e) => e.entryId)).toEqual(['3', '2', '1']);
  });

  it('carries metadata through the round-trip', () => {
    log.record({ operation: 'store', entryId: 'e-1', user: 'alice', score: 0.9 });
    const [entry] = log.list();
    expect(entry.metadata).toMatchObject({ user: 'alice', score: 0.9 });
  });

  it('builds a hash chain that verify() validates', () => {
    log.log('a', '1');
    log.log('b', '2');
    log.log('c', '3');
    expect(log.verify()).toBe(true);
  });

  it('detects tampering via verify()', () => {
    log.log('store', '1');
    log.log('store', '2');
    // Mutate a row under the hood — verify() must fail.
    db.run(`UPDATE moflo_attestation_log SET operation = 'forged' WHERE id = 1`);
    expect(log.verify()).toBe(false);
  });

  it('resumes hash chain across instances on the same db', () => {
    log.log('a', '1');
    log.log('b', '2');
    // New instance sees existing state.
    const resumed = new AttestationLog(db as any);
    resumed.log('c', '3');
    expect(resumed.count()).toBe(3);
    expect(resumed.verify()).toBe(true);
  });

  it('rejects null db', () => {
    expect(() => new AttestationLog(null as any)).toThrow(/requires a sql\.js/i);
  });
});
