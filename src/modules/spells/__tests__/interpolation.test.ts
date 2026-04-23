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

  it('should pass through empty braces (no match for regex)', () => {
    const ctx = createContext();
    // {} has no content inside braces, so the regex {([^}]+)} won't match
    expect(interpolateString('empty {} braces', ctx)).toBe('empty {} braces');
  });

  it('should ignore ${VAR} bash parameter expansion', () => {
    const ctx = createContext({ args: { epic_number: '287' } });
    // A bash command embedding a shell variable alongside a spell variable.
    // ${STORY} is a bash ref, {args.epic_number} is a spell ref.
    const input = 'gh issue edit {args.epic_number} --body "closed #${STORY}"';
    expect(interpolateString(input, ctx)).toBe('gh issue edit 287 --body "closed #${STORY}"');
  });

  it('should ignore ${VAR} even when spell has no matching variable', () => {
    const ctx = createContext();
    // Must not throw "Variable not found: STORY" for a bash-only expression.
    expect(() => interpolateString('sed "s/#${STORY}/.../g"', ctx)).not.toThrow();
    expect(interpolateString('sed "s/#${STORY}/.../g"', ctx)).toBe('sed "s/#${STORY}/.../g"');
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

  it('should pass non-string primitives unchanged', () => {
    const ctx = createContext();
    const result = interpolateConfig({ flag: true, count: 3, nothing: null }, ctx);
    expect(result.flag).toBe(true);
    expect(result.count).toBe(3);
    expect(result.nothing).toBeNull();
  });

  it('should recursively interpolate nested objects', () => {
    const ctx = createContext({ args: { token: 'abc123', host: 'api.example.com' } });
    const result = interpolateConfig({
      headers: { Authorization: 'Bearer {args.token}', Host: '{args.host}' },
    }, ctx);
    expect(result.headers).toEqual({
      Authorization: 'Bearer abc123',
      Host: 'api.example.com',
    });
  });

  it('should recursively interpolate deeply nested structures', () => {
    const ctx = createContext({ args: { val: 'deep' } });
    const result = interpolateConfig({
      level1: { level2: { level3: 'value is {args.val}' } },
    }, ctx);
    expect(result.level1).toEqual({ level2: { level3: 'value is deep' } });
  });

  it('should interpolate strings inside nested arrays', () => {
    const ctx = createContext({ args: { env: 'prod' } });
    const result = interpolateConfig({
      nested: { tags: ['deploy-{args.env}', 'latest'] },
    }, ctx);
    expect(result.nested).toEqual({ tags: ['deploy-prod', 'latest'] });
  });
});
