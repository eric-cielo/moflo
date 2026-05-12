import { describe, it, expect, beforeEach } from 'vitest';
import { MutationGuard } from './mutation-guard.js';

describe('MutationGuard', () => {
  let guard: MutationGuard;

  beforeEach(() => {
    guard = new MutationGuard();
  });

  it('requires an operation string', () => {
    expect(guard.validate({} as any)).toEqual({ allowed: false, reason: 'operation is required' });
    expect(guard.validate({ operation: '' } as any).allowed).toBe(false);
  });

  it('passes through un-watched operations', () => {
    expect(guard.validate({ operation: 'unknown-op', params: {} })).toEqual({ allowed: true });
  });

  it('allows a first-time store and returns a token', () => {
    const result = guard.validate({ operation: 'store', params: { key: 'k', value: 'hello' } });
    expect(result.allowed).toBe(true);
    expect(result.token).toBeDefined();
    expect(result.token).toMatchObject({ op: 'store' });
  });

  it('rejects duplicate within dedupe window after commit', () => {
    const params = { key: 'k', value: 'same' };
    const first = guard.validate({ operation: 'store', params, timestamp: 1000 });
    expect(first.allowed).toBe(true);
    guard.commit(first.token);
    const second = guard.validate({ operation: 'store', params, timestamp: 1500 });
    expect(second.allowed).toBe(false);
    expect(second.reason).toMatch(/duplicate/i);
  });

  it('does NOT reject duplicate if the first validate was never committed (#1098 retry safety)', () => {
    // Critical invariant for withDb's SQLITE_BUSY retry path: when a write
    // fails before commit, MutationGuard must leave the dedupe buffer clean
    // so the retry re-validates as a fresh mutation instead of being
    // rejected as a duplicate of its own failed prior attempt.
    const params = { key: 'k', value: 'same' };
    const first = guard.validate({ operation: 'store', params, timestamp: 1000 });
    expect(first.allowed).toBe(true);
    // Intentionally NO commit — simulates a failed write.
    const retry = guard.validate({ operation: 'store', params, timestamp: 1050 });
    expect(retry.allowed).toBe(true);
  });

  it('allows duplicate after dedupe window expires', () => {
    const params = { key: 'k', value: 'same' };
    const first = guard.validate({ operation: 'store', params, timestamp: 1000 });
    expect(first.allowed).toBe(true);
    guard.commit(first.token);
    const later = guard.validate({ operation: 'store', params, timestamp: 10_000 });
    expect(later.allowed).toBe(true);
  });

  it('commit is null-safe and idempotent', () => {
    // Null/undefined tokens are silently ignored so callers can fire
    // `guard.commit(result.token)` without a defensive null check.
    expect(() => guard.commit(null)).not.toThrow();
    expect(() => guard.commit(undefined)).not.toThrow();
  });

  it('applies rate limit per operation per second (counts committed ops)', () => {
    const g = new MutationGuard({ maxOpsPerSecond: 3 });
    // Vary payloads to bypass the dedupe check — we want rate limit alone.
    // Commit each validate so the rate buffer fills; uncommitted validates
    // don't burn rate budget (intentional, #1098: retry-safety).
    const r1 = g.validate({ operation: 'store', params: { value: '1' }, timestamp: 1000 });
    g.commit(r1.token);
    const r2 = g.validate({ operation: 'store', params: { value: '2' }, timestamp: 1100 });
    g.commit(r2.token);
    const r3 = g.validate({ operation: 'store', params: { value: '3' }, timestamp: 1200 });
    g.commit(r3.token);
    const r4 = g.validate({ operation: 'store', params: { value: '4' }, timestamp: 1300 });
    expect([r1, r2, r3].every((r) => r.allowed)).toBe(true);
    expect(r4.allowed).toBe(false);
    expect(r4.reason).toMatch(/rate limit/i);
  });

  it('rejects values shorter than minValueLength', () => {
    const g = new MutationGuard({ minValueLength: 5 });
    const res = g.validate({ operation: 'store', params: { value: 'hi' } });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/too short/i);
  });

  it('segregates state per operation', () => {
    const g = new MutationGuard({ maxOpsPerSecond: 1 });
    const a = g.validate({ operation: 'store', params: { value: 'x' }, timestamp: 1000 });
    const b = g.validate({ operation: 'update', params: { value: 'x' }, timestamp: 1100 });
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });

  it('reset clears rate-limit and dedupe state', () => {
    const g = new MutationGuard({ maxOpsPerSecond: 1 });
    const v1 = g.validate({ operation: 'store', params: { value: '1' }, timestamp: 1000 });
    g.commit(v1.token);
    g.validate({ operation: 'store', params: { value: '2' }, timestamp: 1100 }); // would-be rejected on rate
    g.reset();
    expect(g.validate({ operation: 'store', params: { value: '3' }, timestamp: 1200 }).allowed).toBe(true);
  });

  it('dedupe hash is order-insensitive for param keys', () => {
    const first = guard.validate({
      operation: 'store',
      params: { a: 1, b: 2, value: 'v' },
      timestamp: 1000,
    });
    guard.commit(first.token);
    const second = guard.validate({
      operation: 'store',
      params: { b: 2, a: 1, value: 'v' },
      timestamp: 1500,
    });
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
  });

  it('custom watched operations override defaults', () => {
    const g = new MutationGuard({ watchedOperations: ['write-only'] });
    expect(g.validate({ operation: 'store', params: { value: 'x' } }).allowed).toBe(true);
    const first = g.validate({ operation: 'write-only', params: { value: 'x' }, timestamp: 1000 });
    g.commit(first.token);
    const second = g.validate({ operation: 'write-only', params: { value: 'x' }, timestamp: 1500 });
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
  });
});
