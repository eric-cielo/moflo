/**
 * Variable Interpolation Tests
 *
 * Story #102: Built-in Step Commands — interpolation utility
 */

import { describe, it, expect } from 'vitest';
import { interpolateString, interpolateConfig } from '../src/core/interpolation.js';
import { createMockContext as createContext } from './helpers.js';

describe('interpolateString', () => {
  it('should resolve simple variable references', () => {
    const ctx = createContext({ variables: { step1: { output: 'hello' } } });
    expect(interpolateString('{step1.output}', ctx)).toBe('hello');
  });

  it('should resolve nested variable paths', () => {
    const ctx = createContext({
      variables: { fetch: { data: { users: { count: 42 } } } },
    });
    expect(interpolateString('Found {fetch.data.users.count} users', ctx)).toBe('Found 42 users');
  });

  it('should resolve args as fallback', () => {
    const ctx = createContext({ args: { issueNumber: '123' } });
    expect(interpolateString('Issue #{issueNumber}', ctx)).toBe('Issue #123');
  });

  it('should resolve args. prefix', () => {
    const ctx = createContext({ args: { dryRun: 'true' } });
    expect(interpolateString('{args.dryRun}', ctx)).toBe('true');
  });

  it('should pass through strings without placeholders', () => {
    const ctx = createContext();
    expect(interpolateString('no variables here', ctx)).toBe('no variables here');
  });

  it('should resolve multiple placeholders in one string', () => {
    const ctx = createContext({
      variables: { a: { x: 'hello' }, b: { y: 'world' } },
    });
    expect(interpolateString('{a.x} {b.y}!', ctx)).toBe('hello world!');
  });

  it('should throw on missing variable', () => {
    const ctx = createContext();
    expect(() => interpolateString('{missing.var}', ctx)).toThrow('Variable not found: missing.var');
  });

  it('should coerce non-string values to string', () => {
    const ctx = createContext({ variables: { step1: { count: 42, ok: true } } });
    expect(interpolateString('{step1.count}', ctx)).toBe('42');
    expect(interpolateString('{step1.ok}', ctx)).toBe('true');
  });
});

describe('interpolateConfig', () => {
  it('should interpolate all string values in a config', () => {
    const ctx = createContext({ variables: { s1: { name: 'test' } } });
    const result = interpolateConfig({ cmd: 'echo {s1.name}', timeout: 5000 }, ctx);
    expect(result.cmd).toBe('echo test');
    expect(result.timeout).toBe(5000);
  });

  it('should interpolate strings inside arrays', () => {
    const ctx = createContext({ args: { env: 'prod' } });
    const result = interpolateConfig({ tags: ['deploy-{env}', 'latest'] }, ctx);
    expect(result.tags).toEqual(['deploy-prod', 'latest']);
  });

  it('should pass non-string non-array values unchanged', () => {
    const ctx = createContext();
    const result = interpolateConfig({ flag: true, count: 3, obj: { nested: true } }, ctx);
    expect(result.flag).toBe(true);
    expect(result.count).toBe(3);
    expect(result.obj).toEqual({ nested: true });
  });
});
