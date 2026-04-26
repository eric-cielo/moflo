import { describe, it, expect } from 'vitest';
import { coerceArgValue, resolveSpellArgs } from '../commands/spell.js';

describe('coerceArgValue', () => {
  it('coerces "true"/"false"/"null" to their literal types', () => {
    expect(coerceArgValue('true')).toBe(true);
    expect(coerceArgValue('false')).toBe(false);
    expect(coerceArgValue('null')).toBeNull();
  });

  it('coerces finite numeric strings to numbers', () => {
    expect(coerceArgValue('42')).toBe(42);
    expect(coerceArgValue('3.14')).toBe(3.14);
    expect(coerceArgValue('-7')).toBe(-7);
  });

  it('parses JSON object/array values', () => {
    expect(coerceArgValue('{"a":1}')).toEqual({ a: 1 });
    expect(coerceArgValue('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('falls back to raw string when JSON parse fails', () => {
    expect(coerceArgValue('{not-json}')).toBe('{not-json}');
  });

  it('treats ambiguous strings as strings', () => {
    expect(coerceArgValue('hello')).toBe('hello');
    expect(coerceArgValue('2026-04-10T00:00:00Z')).toBe('2026-04-10T00:00:00Z');
  });

  it('empty string stays empty, not coerced to 0', () => {
    expect(coerceArgValue('')).toBe('');
  });
});

describe('resolveSpellArgs', () => {
  it('returns empty args when both flags are absent', () => {
    expect(resolveSpellArgs(undefined, undefined)).toEqual({ args: {} });
  });

  it('parses --args JSON object', () => {
    const { args, error } = resolveSpellArgs('{"maxEmails":50,"headless":false}', undefined);
    expect(error).toBeUndefined();
    expect(args).toEqual({ maxEmails: 50, headless: false });
  });

  it('errors on --args malformed JSON', () => {
    const { args, error } = resolveSpellArgs('not-json', undefined);
    expect(error).toContain('Invalid JSON');
    expect(args).toEqual({});
  });

  it('errors when --args is a JSON array (must be object)', () => {
    const { error } = resolveSpellArgs('[1,2]', undefined);
    expect(error).toContain('must be a JSON object');
  });

  it('errors when --args is a JSON primitive', () => {
    const { error } = resolveSpellArgs('42', undefined);
    expect(error).toContain('must be a JSON object');
  });

  it('handles --arg as a single string (single CLI flag)', () => {
    const { args, error } = resolveSpellArgs(undefined, 'maxEmails=5');
    expect(error).toBeUndefined();
    expect(args).toEqual({ maxEmails: 5 });
  });

  it('handles --arg as array (repeated CLI flags)', () => {
    const { args, error } = resolveSpellArgs(undefined, ['headless=false', 'maxEmails=10', 'tag=prod']);
    expect(error).toBeUndefined();
    expect(args).toEqual({ headless: false, maxEmails: 10, tag: 'prod' });
  });

  it('merges JSON args with kv overrides (kv wins)', () => {
    const { args } = resolveSpellArgs('{"maxEmails":10,"tag":"dev"}', ['maxEmails=50']);
    expect(args).toEqual({ maxEmails: 50, tag: 'dev' });
  });

  it('errors on --arg without =', () => {
    const { error } = resolveSpellArgs(undefined, ['no-equals-sign']);
    expect(error).toContain('must be key=value');
    expect(error).toContain('no-equals-sign');
  });

  it('errors on --arg with empty key', () => {
    const { error } = resolveSpellArgs(undefined, ['=value']);
    expect(error).toMatch(/must be key=value|key is empty/);
  });

  it('preserves = signs in the value portion', () => {
    const { args } = resolveSpellArgs(undefined, ['query=a=b=c']);
    expect(args).toEqual({ query: 'a=b=c' });
  });

  it('ignores empty --args string (treated as not set)', () => {
    const { args, error } = resolveSpellArgs('   ', ['x=1']);
    expect(error).toBeUndefined();
    expect(args).toEqual({ x: 1 });
  });
});
