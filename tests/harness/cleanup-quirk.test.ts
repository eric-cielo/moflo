/**
 * Tests for `isKnownWindowsCleanupQuirk` in harness/consumer-smoke/lib/checks.mjs (#1018).
 *
 * The classifier decides whether `cleanupWorkDir` should swallow a stray
 * post-retry rmSync error: yes for Windows EBUSY (known platform quirk
 * already covered by the retry budget + ephemeral CI runners), no for
 * everything else.
 *
 * Matches against `err.code` (the canonical Node SystemError field), so
 * tests construct synthetic errors with explicit `code` properties.
 */
import { describe, it, expect } from 'vitest';
// .mjs ESM module — vitest resolves the relative path from project root.
// @ts-ignore — JS module without .d.ts.
import { isKnownWindowsCleanupQuirk } from '../../harness/consumer-smoke/lib/checks.mjs';

function fsErr(code: string, message = `${code}: simulated`): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('isKnownWindowsCleanupQuirk (#1018)', () => {
  it('returns true for Windows + EBUSY (the case we suppress)', () => {
    expect(isKnownWindowsCleanupQuirk(fsErr('EBUSY'), 'win32')).toBe(true);
  });

  it('returns false for Windows + EPERM (a real signal worth warning on)', () => {
    expect(isKnownWindowsCleanupQuirk(fsErr('EPERM'), 'win32')).toBe(false);
  });

  it('returns false for Windows + EACCES', () => {
    expect(isKnownWindowsCleanupQuirk(fsErr('EACCES'), 'win32')).toBe(false);
  });

  it('returns false for Windows + ENOENT', () => {
    expect(isKnownWindowsCleanupQuirk(fsErr('ENOENT'), 'win32')).toBe(false);
  });

  it('returns false for POSIX + EBUSY (no Windows AV/indexer story to excuse it)', () => {
    expect(isKnownWindowsCleanupQuirk(fsErr('EBUSY'), 'linux')).toBe(false);
    expect(isKnownWindowsCleanupQuirk(fsErr('EBUSY'), 'darwin')).toBe(false);
  });

  it('returns false for an error with no code field', () => {
    // Ordinary Error with no .code — must not be classified as the quirk.
    const plain = new Error('something went wrong');
    expect(isKnownWindowsCleanupQuirk(plain, 'win32')).toBe(false);
  });

  it('returns false for null / undefined err (defensive)', () => {
    expect(isKnownWindowsCleanupQuirk(null, 'win32')).toBe(false);
    expect(isKnownWindowsCleanupQuirk(undefined, 'win32')).toBe(false);
  });

  it('does not match on err.message containing EBUSY when err.code differs', () => {
    // Guards against reverting to message-based matching: an error whose
    // message text mentions EBUSY but whose canonical code is something
    // else MUST NOT be classified as the quirk.
    const err = fsErr('EPERM', 'EPERM: operation not permitted (was: EBUSY earlier)');
    expect(isKnownWindowsCleanupQuirk(err, 'win32')).toBe(false);
  });
});
