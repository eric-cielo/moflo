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

  it('allows a first-time store', () => {
    expect(
      guard.validate({ operation: 'store', params: { key: 'k', value: 'hello' } }),
    ).toEqual({ allowed: true });
  });

  it('rejects duplicate within dedupe window', () => {
    const params = { key: 'k', value: 'same' };
    expect(guard.validate({ operation: 'store', params, timestamp: 1000 }).allowed).toBe(true);
    const second = guard.validate({ operation: 'store', params, timestamp: 1500 });
    expect(second.allowed).toBe(false);
    expect(second.reason).toMatch(/duplicate/i);
  });

  it('allows duplicate after dedupe window expires', () => {
    const params = { key: 'k', value: 'same' };
    expect(guard.validate({ operation: 'store', params, timestamp: 1000 }).allowed).toBe(true);
    const later = guard.validate({ operation: 'store', params, timestamp: 10_000 });
    expect(later.allowed).toBe(true);
  });

  it('applies rate limit per operation per second', () => {
    const g = new MutationGuard({ maxOpsPerSecond: 3 });
    // Vary payloads to bypass the dedupe check — we want rate limit alone.
    const r1 = g.validate({ operation: 'store', params: { value: '1' }, timestamp: 1000 });
    const r2 = g.validate({ operation: 'store', params: { value: '2' }, timestamp: 1100 });
    const r3 = g.validate({ operation: 'store', params: { value: '3' }, timestamp: 1200 });
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
    g.validate({ operation: 'store', params: { value: '1' }, timestamp: 1000 });
    g.validate({ operation: 'store', params: { value: '2' }, timestamp: 1100 });
    g.reset();
    expect(g.validate({ operation: 'store', params: { value: '3' }, timestamp: 1200 }).allowed).toBe(true);
  });

  it('dedupe hash is order-insensitive for param keys', () => {
    const first = guard.validate({
      operation: 'store',
      params: { a: 1, b: 2, value: 'v' },
      timestamp: 1000,
    });
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
    const second = g.validate({ operation: 'write-only', params: { value: 'x' }, timestamp: 1500 });
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
  });
});
