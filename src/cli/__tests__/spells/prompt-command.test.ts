import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Scripted answer the mocked readline.createInterface will feed back.
// Individual tests set this before invoking promptCommand.execute.
let scriptedAnswer: string = '';
vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (answer: string) => void) => cb(scriptedAnswer),
    close: () => { /* noop */ },
  }),
}));

import {
  promptCommand,
  resolveDefault,
} from '../../spells/commands/prompt-command.js';
import {
  registerTTYPauser,
  _resetTTYLockForTest,
} from '../../spells/core/tty-lock.js';
import { createMockContext } from './helpers.js';

describe('resolveDefault', () => {
  const now = Date.parse('2026-04-17T12:00:00Z');

  it('returns trimmed raw default when non-empty', () => {
    expect(resolveDefault('  hello  ', undefined, now)).toBe('hello');
  });

  it('falls through to fallbackDaysAgo ISO when raw is null', () => {
    expect(resolveDefault(null, 7, now)).toBe('2026-04-10T12:00:00.000Z');
  });

  it('falls through when raw is the literal string "null" (interpolation artifact)', () => {
    expect(resolveDefault('null', 1, now)).toBe('2026-04-16T12:00:00.000Z');
  });

  it('falls through when raw is "undefined"', () => {
    expect(resolveDefault('undefined', 2, now)).toBe('2026-04-15T12:00:00.000Z');
  });

  it('returns empty string when no raw and no fallback', () => {
    expect(resolveDefault(null, undefined, now)).toBe('');
    expect(resolveDefault(undefined, undefined, now)).toBe('');
    expect(resolveDefault('', undefined, now)).toBe('');
  });

  it('ignores non-positive fallbackDaysAgo', () => {
    expect(resolveDefault(null, 0, now)).toBe('');
    expect(resolveDefault(null, -5, now)).toBe('');
  });
});

describe('promptCommand', () => {
  let origTty: boolean | undefined;
  let origOutTty: boolean | undefined;

  beforeEach(() => {
    origTty = process.stdin.isTTY;
    origOutTty = process.stdout.isTTY;
    // Default to non-interactive for tests — individual cases can flip these.
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: origTty, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: origOutTty, configurable: true });
    vi.restoreAllMocks();
  });

  describe('validate', () => {
    it('accepts a valid config', () => {
      const result = promptCommand.validate({ message: 'Continue?' }, createMockContext());
      expect(result.valid).toBe(true);
    });

    it('rejects missing message', () => {
      const result = promptCommand.validate({} as never, createMockContext());
      expect(result.valid).toBe(false);
    });

    it('accepts default: null (memory-backed interpolation)', () => {
      const result = promptCommand.validate(
        { message: 'When?', default: null },
        createMockContext(),
      );
      expect(result.valid).toBe(true);
    });

    it('rejects non-string, non-null default', () => {
      const result = promptCommand.validate(
        { message: 'When?', default: 42 as never },
        createMockContext(),
      );
      expect(result.valid).toBe(false);
    });

    it('rejects non-number fallbackDaysAgo', () => {
      const result = promptCommand.validate(
        { message: 'When?', fallbackDaysAgo: 'seven' as never },
        createMockContext(),
      );
      expect(result.valid).toBe(false);
    });
  });

  describe('execute (non-interactive)', () => {
    it('returns raw default when TTY is absent', async () => {
      const output = await promptCommand.execute(
        { message: 'Continue?', default: 'yes' },
        createMockContext(),
      );
      expect(output.success).toBe(true);
      expect(output.data.response).toBe('yes');
      expect(output.data.interactive).toBe(false);
    });

    it('uses fallbackDaysAgo when default is missing', async () => {
      const output = await promptCommand.execute(
        { message: 'When?', fallbackDaysAgo: 3 },
        createMockContext(),
      );
      expect(output.success).toBe(true);
      expect(typeof output.data.response).toBe('string');
      expect((output.data.response as string).length).toBeGreaterThan(0);
      // Should be a valid ISO timestamp roughly 3 days ago
      const parsed = Date.parse(output.data.response as string);
      expect(Date.now() - parsed).toBeGreaterThan(3 * 86_400_000 - 5_000);
      expect(Date.now() - parsed).toBeLessThan(3 * 86_400_000 + 5_000);
    });

    it('returns empty string when neither default nor fallback is given', async () => {
      const output = await promptCommand.execute(
        { message: 'Anything?' },
        createMockContext(),
      );
      expect(output.data.response).toBe('');
    });

    it('interpolates default from context variables', async () => {
      const ctx = createMockContext({
        variables: { lastRun: { value: '2026-04-01T00:00:00Z' } },
      });
      const output = await promptCommand.execute(
        { message: 'When?', default: '{lastRun.value}' },
        ctx,
      );
      expect(output.data.response).toBe('2026-04-01T00:00:00Z');
    });

    it('treats null interpolated default as missing and uses fallback', async () => {
      const ctx = createMockContext({
        variables: { lastRun: { value: null } },
      });
      const output = await promptCommand.execute(
        { message: 'When?', default: '{lastRun.value}', fallbackDaysAgo: 2 },
        ctx,
      );
      const parsed = Date.parse(output.data.response as string);
      expect(Date.now() - parsed).toBeGreaterThan(2 * 86_400_000 - 5_000);
      expect(Date.now() - parsed).toBeLessThan(2 * 86_400_000 + 5_000);
    });
  });

  describe('execute (interactive)', () => {
    /** Simulate TTY and set the scripted answer; readline is module-mocked above. */
    async function runWithStdinLine(line: string, config: Parameters<typeof promptCommand.execute>[0]) {
      scriptedAnswer = line;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      return promptCommand.execute(config, createMockContext());
    }

    it('returns user input when non-empty', async () => {
      const output = await runWithStdinLine('2026-04-15T00:00:00Z', {
        message: 'When?',
        default: 'yes',
      });
      expect(output.data.response).toBe('2026-04-15T00:00:00Z');
      expect(output.data.interactive).toBe(true);
    });

    it('falls back to effective default when user hits enter (empty input)', async () => {
      const output = await runWithStdinLine('', {
        message: 'When?',
        default: '2026-04-10T00:00:00Z',
      });
      expect(output.data.response).toBe('2026-04-10T00:00:00Z');
      expect(output.data.interactive).toBe(true);
    });

    it('shows fallbackDaysAgo default when no stored value exists', async () => {
      const output = await runWithStdinLine('', {
        message: 'When?',
        default: null,
        fallbackDaysAgo: 7,
      });
      // Empty input → effective default (7 days ago ISO)
      const parsed = Date.parse(output.data.response as string);
      expect(Date.now() - parsed).toBeGreaterThan(7 * 86_400_000 - 5_000);
      expect(Date.now() - parsed).toBeLessThan(7 * 86_400_000 + 5_000);
    });

    it('acquires and releases the TTY lock around the readline call', async () => {
      _resetTTYLockForTest();
      const events: string[] = [];
      registerTTYPauser(() => {
        events.push('pause');
        return { release: () => events.push('resume') };
      });
      try {
        await runWithStdinLine('answer', { message: 'Q?', default: null });
      } finally {
        _resetTTYLockForTest();
      }
      expect(events).toEqual(['pause', 'resume']);
    });
  });
});
