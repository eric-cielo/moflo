/**
 * Load-average helper — #1358.
 *
 * Rule #1. Every assertion here passes an explicit `platform`, so the Windows
 * behaviour is proven on the Ubuntu leg that actually runs this suite. A
 * `process.platform === 'win32'` fork inside a test would be dead code on two
 * of the three CI legs and would assert nothing — the trap behind #1145, and
 * the reason #1354 gave these helpers a platform parameter in the first place.
 */

import { describe, it, expect } from 'vitest';
import {
  isLoadAverageMeasurable,
  readLoadAverage,
  readCpuUsagePercent,
  NOT_MEASURED,
} from '../../../shared/utils/load-average.js';

describe('#1358 — isLoadAverageMeasurable', () => {
  it('is false on Windows, where os.loadavg() is documented as always [0, 0, 0]', () => {
    expect(isLoadAverageMeasurable('win32')).toBe(false);
  });

  it('is true on the platforms that report a real load average', () => {
    expect(isLoadAverageMeasurable('linux')).toBe(true);
    expect(isLoadAverageMeasurable('darwin')).toBe(true);
    expect(isLoadAverageMeasurable('freebsd')).toBe(true);
  });
});

describe('#1358 — readLoadAverage', () => {
  it('returns null on Windows rather than the fabricated [0, 0, 0]', () => {
    // This is the exact value Node hands back on Windows. Passing it through
    // unchanged is what made three reporters print a confidently idle machine.
    expect(readLoadAverage([0, 0, 0], 'win32')).toBeNull();
  });

  it('passes the reading straight through on Unix', () => {
    expect(readLoadAverage([1.5, 1.2, 0.9], 'linux')).toEqual([1.5, 1.2, 0.9]);
    expect(readLoadAverage([4, 2, 1], 'darwin')).toEqual([4, 2, 1]);
  });

  it('does not suppress a genuine zero on Unix — an idle Linux box is a measurement', () => {
    expect(readLoadAverage([0, 0, 0], 'linux')).toEqual([0, 0, 0]);
  });
});

describe('#1358 — readCpuUsagePercent keeps its #1354 contract after the move', () => {
  it('returns null on Windows instead of a fabricated 0.0%', () => {
    expect(readCpuUsagePercent([0, 0, 0], 8, 'win32')).toBeNull();
  });

  it('returns a real percentage on Linux and macOS', () => {
    expect(readCpuUsagePercent([4, 2, 1], 8, 'linux')).toBeCloseTo(50);
    expect(readCpuUsagePercent([2, 1, 1], 8, 'darwin')).toBeCloseTo(25);
  });

  it('returns null rather than Infinity when os.cpus() reports no cores', () => {
    // os.cpus() is documented as possibly returning an empty array.
    expect(readCpuUsagePercent([1, 1, 1], 0, 'linux')).toBeNull();
  });

  it('clamps to 100 rather than reporting an over-100 percentage', () => {
    expect(readCpuUsagePercent([32, 16, 8], 4, 'linux')).toBe(100);
  });
});

describe('#1358 — NOT_MEASURED', () => {
  it('is a phrase, not a number — a renderer must never substitute a zero', () => {
    expect(NOT_MEASURED).toBe('not measured');
    expect(Number.isNaN(Number(NOT_MEASURED))).toBe(true);
  });
});
