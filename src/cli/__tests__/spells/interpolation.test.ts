/**
 * Variable Interpolation Tests
 *
 * Story #102: Built-in Step Commands — interpolation utility
 */

import { describe, it, expect, afterEach } from 'vitest';
import { interpolateString, interpolateConfig } from '../../spells/core/interpolation.js';
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

  it('should leave JS destructuring and object literals untouched inside node -e scripts', () => {
    // Regression (epic #287, 2026-04-22): a loose `{([^}]+)}` regex swallowed
    // JS code like `{ spawnSync }` and `{ encoding: "utf8" }` when a spell
    // embedded a `node -e '…'` script in a bash step, throwing
    // "Variable not found: spawnSync". The interpolator must only consume
    // identifier-shape references.
    const ctx = createContext({ args: { epic_number: '287' } });
    const input = [
      'node -e \'',
      '  const { spawnSync } = require("node:child_process");',
      '  const view = spawnSync("gh", ["issue", "view", "{args.epic_number}"], { encoding: "utf8" });',
      '\'',
    ].join('\n');
    const out = interpolateString(input, ctx);
    expect(out).toContain('{ spawnSync }');
    expect(out).toContain('{ encoding: "utf8" }');
    expect(out).toContain('"287"');
  });

  it('should not treat braces with whitespace or non-identifier chars as references', () => {
    const ctx = createContext();
    // All of these must pass through unchanged — none are identifier-shaped refs.
    const cases = [
      '{ foo }',              // leading/trailing whitespace
      '{a: b}',               // colon
      '{"key": "value"}',     // quotes
      '{1abc}',               // starts with digit
      '{foo bar}',            // inner whitespace
      '{foo+bar}',            // arithmetic/operator
    ];
    for (const s of cases) {
      expect(interpolateString(s, ctx)).toBe(s);
    }
  });

  it('should coerce non-string values to string', () => {
    const ctx = createContext({ variables: { step1: { count: 42, ok: true } } });
    expect(interpolateString('{step1.count}', ctx)).toBe('42');
    expect(interpolateString('{step1.ok}', ctx)).toBe('true');
  });

  describe('{env.KEY} prefix (#518)', () => {
    const ENV_KEY = 'FLO_INTERP_TEST_518';

    afterEach(() => { delete process.env[ENV_KEY]; });

    it('resolves an env-var reference when set', () => {
      process.env[ENV_KEY] = 'secret-value';
      const ctx = createContext();
      expect(interpolateString(`Bearer {env.${ENV_KEY}}`, ctx)).toBe('Bearer secret-value');
    });

    it('throws "Variable not found" when env var is unset', () => {
      delete process.env[ENV_KEY];
      const ctx = createContext();
      expect(() => interpolateString(`{env.${ENV_KEY}}`, ctx))
        .toThrow(`Variable not found: env.${ENV_KEY}`);
    });

    it('throws when env var is an empty string (matches prereq env detector)', () => {
      process.env[ENV_KEY] = '';
      const ctx = createContext();
      expect(() => interpolateString(`{env.${ENV_KEY}}`, ctx))
        .toThrow(`Variable not found: env.${ENV_KEY}`);
    });

    it('does not collide with a step output also named "env"', () => {
      // If a spell had a step with id "env" producing a field "KEY", that
      // {env.KEY} would now hit the env-prefix branch first. Document the
      // expected behaviour: env-prefix wins; when the env var is unset,
      // interpolation falls through to the variables walk.
      process.env[ENV_KEY] = 'from-env';
      const ctx = createContext({ variables: { env: { [ENV_KEY]: 'from-step-output' } } });
      expect(interpolateString(`{env.${ENV_KEY}}`, ctx)).toBe('from-env');

      delete process.env[ENV_KEY];
      expect(interpolateString(`{env.${ENV_KEY}}`, ctx)).toBe('from-step-output');
    });
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
