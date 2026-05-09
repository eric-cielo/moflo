/**
 * Tests for `isKnownWindowsCleanupQuirk` in harness/consumer-smoke/lib/checks.mjs (#1018).
 *
 * The classifier decides whether `cleanupWorkDir` should swallow a stray
 * post-retry rmSync error: yes for Windows EBUSY (known platform quirk
 * already covered by the retry budget + ephemeral CI runners), no for
 * everything else.
 */
import { describe, it, expect } from 'vitest';
// .mjs ESM module — vitest resolves the relative path from project root.
// @ts-ignore — JS module without .d.ts.
import { isKnownWindowsCleanupQuirk } from '../../harness/consumer-smoke/lib/checks.mjs';

describe('isKnownWindowsCleanupQuirk (#1018)', () => {
  it('returns true for Windows + EBUSY (the case we suppress)', () => {
    const err = new Error('EBUSY: resource busy or locked, rmdir');
    expect(isKnownWindowsCleanupQuirk(err, 'win32')).toBe(true);
  });

  it('returns false for Windows + EPERM (a real signal worth warning on)', () => {
    const err = new Error('EPERM: operation not permitted, unlink');
    expect(isKnownWindowsCleanupQuirk(err, 'win32')).toBe(false);
  });

  it('returns false for Windows + EACCES', () => {
    const err = new Error('EACCES: permission denied');
    expect(isKnownWindowsCleanupQuirk(err, 'win32')).toBe(false);
  });

  it('returns false for POSIX + EBUSY (no Windows AV/indexer story to excuse it)', () => {
    const err = new Error('EBUSY: resource busy or locked');
    expect(isKnownWindowsCleanupQuirk(err, 'linux')).toBe(false);
    expect(isKnownWindowsCleanupQuirk(err, 'darwin')).toBe(false);
  });

  it('returns false for an error with no message field', () => {
    expect(isKnownWindowsCleanupQuirk({}, 'win32')).toBe(false);
    expect(isKnownWindowsCleanupQuirk(null, 'win32')).toBe(false);
    expect(isKnownWindowsCleanupQuirk(undefined, 'win32')).toBe(false);
  });

  it('matches EBUSY only on word boundaries (avoids false positives on substrings)', () => {
    // A theoretical error whose message merely *contains* "EBUSY" as part of
    // another token shouldn't qualify — only standalone EBUSY does.
    const err = new Error('NOTEBUSYY: something else');
    expect(isKnownWindowsCleanupQuirk(err, 'win32')).toBe(false);
  });
});
