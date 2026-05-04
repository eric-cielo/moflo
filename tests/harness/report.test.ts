/**
 * Tests for harness/consumer-smoke/lib/report.mjs (issue #907).
 *
 * Verifies summary-mode behavior: pass/info rows + section dividers are
 * suppressed; section headers lazy-emit when a fail/warn lands inside; the
 * tail (Summary line + Failed: block) always prints.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// .mjs ESM module — vitest resolves the relative path from project root.
// @ts-ignore — JS module without .d.ts.
import * as report from '../../harness/consumer-smoke/lib/report.mjs';

let logSpy: ReturnType<typeof vi.spyOn>;

function lines(): string[] {
  return logSpy.mock.calls.map((c: any[]) => String(c[0]));
}

beforeEach(() => {
  report._resetForTest();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

describe('report.resolveSummaryMode', () => {
  it('--no-summary wins over everything', () => {
    expect(report.resolveSummaryMode(['--no-summary', '--summary'], { isTTY: false })).toBe(false);
  });

  it('--summary forces on', () => {
    expect(report.resolveSummaryMode(['--summary'], { isTTY: true })).toBe(true);
  });

  it('--json suppresses auto-default', () => {
    expect(report.resolveSummaryMode(['--json'], { isTTY: false })).toBe(false);
  });

  it('non-TTY auto-enables summary', () => {
    expect(report.resolveSummaryMode([], { isTTY: false })).toBe(true);
  });

  it('TTY default leaves summary off', () => {
    expect(report.resolveSummaryMode([], { isTTY: true })).toBe(false);
  });
});

describe('report summary mode', () => {
  it('all-pass run prints only the tail (Summary line + closer)', () => {
    report.configure({ summary: true });
    report.section('Verify dist hygiene');
    report.record('check-a', 'pass');
    report.record('check-b', 'pass');
    report.section('Doctor');
    report.record('doctor', 'pass', 'exit 0');
    report.printSummary();

    const out = lines();
    expect(out.some(l => l.includes('[PASS]'))).toBe(false);
    expect(out.some(l => l.startsWith('── '))).toBe(false);
    expect(out.some(l => l.startsWith('Summary:'))).toBe(true);
    expect(out.some(l => l.includes('Failed:'))).toBe(false);
  });

  it('failure inside a section emits the section header lazily, then the FAIL line', () => {
    report.configure({ summary: true });
    report.section('Verify dist hygiene');
    report.record('check-a', 'pass');
    report.section('Doctor');
    report.record('doctor', 'fail', 'exit 1: boom');
    report.printSummary();

    const out = lines();
    const passes = out.filter(l => l.includes('[PASS]'));
    expect(passes.length).toBe(0);
    const headers = out.filter(l => l.startsWith('\n── '));
    expect(headers).toHaveLength(1);
    expect(headers[0]).toContain('Doctor');
    expect(out.some(l => l.includes('[FAIL] doctor — exit 1: boom'))).toBe(true);
    expect(out.some(l => l.includes('Failed:'))).toBe(true);
  });

  it('warn behaves like fail for header emission', () => {
    report.configure({ summary: true });
    report.section('Hooks surface');
    report.record('hooks-known', 'warn', 'known regression');
    report.printSummary();

    const out = lines();
    expect(out.some(l => l.includes('── Hooks surface'))).toBe(true);
    expect(out.some(l => l.includes('[WARN] hooks-known'))).toBe(true);
  });

  it('multiple fails in same section emit header once', () => {
    report.configure({ summary: true });
    report.section('Doctor');
    report.record('a', 'fail', 'x');
    report.record('b', 'fail', 'y');
    report.printSummary();

    const out = lines();
    const headers = out.filter(l => l.startsWith('\n── '));
    expect(headers).toHaveLength(1);
    expect(out.some(l => l.includes('[FAIL] a'))).toBe(true);
    expect(out.some(l => l.includes('[FAIL] b'))).toBe(true);
  });

  it('section with only passes is fully suppressed even after a later failing section', () => {
    report.configure({ summary: true });
    report.section('Quiet section');
    report.record('quiet-1', 'pass');
    report.record('quiet-2', 'pass');
    report.section('Loud section');
    report.record('loud-1', 'fail', 'oops');
    report.printSummary();

    const out = lines();
    expect(out.some(l => l.includes('Quiet section'))).toBe(false);
    expect(out.some(l => l.includes('Loud section'))).toBe(true);
  });

  it('log() calls are suppressed in summary mode', () => {
    report.configure({ summary: true });
    report.log('ambient progress chatter');
    report.printSummary();

    const out = lines();
    expect(out.some(l => l.includes('ambient progress chatter'))).toBe(false);
  });
});

describe('report verbose (default) mode unchanged', () => {
  it('prints PASS rows + section headers', () => {
    report.configure({});
    report.section('Doctor');
    report.record('doctor', 'pass', 'exit 0');
    report.printSummary();

    const out = lines();
    expect(out.some(l => l.includes('── Doctor'))).toBe(true);
    expect(out.some(l => l.includes('[PASS] doctor'))).toBe(true);
    expect(out.some(l => l.startsWith('Summary:'))).toBe(true);
  });
});

describe('report json mode unaffected', () => {
  it('emits a single JSON object and nothing else', () => {
    report.configure({ json: true });
    report.section('ignored');
    report.record('a', 'pass');
    report.record('b', 'fail', 'boom');
    report.printSummary();

    const out = lines();
    expect(out.length).toBe(1);
    const parsed = JSON.parse(out[0]);
    expect(parsed.pass).toBe(1);
    expect(parsed.fail).toBe(1);
    expect(parsed.results).toHaveLength(2);
  });
});
