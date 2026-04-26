import { describe, it, expect } from 'vitest';
import {
  filterEmailsSince,
  resolveSinceDate,
  type InboxEmail,
} from '../../spells/connectors/local-outlook.js';

function email(overrides: Partial<InboxEmail> = {}): InboxEmail {
  return {
    index: 0,
    subject: 'sub',
    from: 'from',
    preview: '',
    hasAttachment: false,
    timestamp: '',
    timestampIso: '',
    ...overrides,
  };
}

describe('filterEmailsSince', () => {
  it('keeps all emails when sinceDate is undefined', () => {
    const emails = [
      email({ timestampIso: '2026-01-01T00:00:00Z' }),
      email({ timestampIso: '2026-04-10T00:00:00Z' }),
    ];
    const { kept, newestTimestamp } = filterEmailsSince(emails, undefined);
    expect(kept).toHaveLength(2);
    expect(newestTimestamp).toBe('2026-04-10T00:00:00.000Z');
  });

  it('excludes emails older than sinceDate', () => {
    const emails = [
      email({ index: 0, timestampIso: '2026-01-01T00:00:00Z' }),
      email({ index: 1, timestampIso: '2026-04-15T00:00:00Z' }),
      email({ index: 2, timestampIso: '2026-04-16T12:00:00Z' }),
    ];
    const { kept, newestTimestamp } = filterEmailsSince(emails, '2026-04-10T00:00:00Z');
    expect(kept.map(e => e.index)).toEqual([1, 2]);
    expect(newestTimestamp).toBe('2026-04-16T12:00:00.000Z');
  });

  it('includes emails with no parseable ISO timestamp (cannot safely exclude)', () => {
    const emails = [
      email({ index: 0, timestampIso: '' }),
      email({ index: 1, timestampIso: '2026-04-15T00:00:00Z' }),
    ];
    const { kept } = filterEmailsSince(emails, '2026-04-10T00:00:00Z');
    expect(kept.map(e => e.index)).toEqual([0, 1]);
  });

  it('returns null newestTimestamp when no emails have ISO timestamps', () => {
    const emails = [email({ timestampIso: '' }), email({ timestampIso: 'yesterday' })];
    const { newestTimestamp } = filterEmailsSince(emails, undefined);
    expect(newestTimestamp).toBeNull();
  });

  it('treats unparseable sinceDate as no filter', () => {
    const emails = [
      email({ timestampIso: '2026-01-01T00:00:00Z' }),
      email({ timestampIso: '2026-04-15T00:00:00Z' }),
    ];
    const { kept } = filterEmailsSince(emails, 'not-a-date');
    expect(kept).toHaveLength(2);
  });

  it('emails exactly at sinceDate boundary are kept', () => {
    const emails = [email({ timestampIso: '2026-04-10T00:00:00Z' })];
    const { kept } = filterEmailsSince(emails, '2026-04-10T00:00:00Z');
    expect(kept).toHaveLength(1);
  });
});

describe('resolveSinceDate', () => {
  it('returns explicit sinceDate when parseable', () => {
    expect(resolveSinceDate('2026-04-10T00:00:00Z', 3)).toBe('2026-04-10T00:00:00Z');
  });

  it('falls back to N-days-ago when sinceDate is null', () => {
    const result = resolveSinceDate(null, 2);
    expect(result).not.toBeNull();
    const ms = Date.parse(result!);
    expect(Date.now() - ms).toBeGreaterThanOrEqual(2 * 86_400_000 - 1000);
    expect(Date.now() - ms).toBeLessThan(2 * 86_400_000 + 1000);
  });

  it('falls back to N-days-ago when sinceDate is an empty string', () => {
    expect(resolveSinceDate('', 1)).not.toBeNull();
  });

  it('falls back when sinceDate is the literal string "null" (common interpolation output)', () => {
    expect(resolveSinceDate('null', 1)).not.toBeNull();
  });

  it('returns null when both inputs are empty', () => {
    expect(resolveSinceDate(null, null)).toBeNull();
    expect(resolveSinceDate(undefined, undefined)).toBeNull();
    expect(resolveSinceDate(null, 0)).toBeNull();
  });
});
