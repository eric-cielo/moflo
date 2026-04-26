/**
 * Unit tests for the TTY / non-TTY progress renderer.
 */
import { describe, it, expect } from 'vitest';

import { UpgradeRenderer } from '../../../embeddings/migration/upgrade-renderer.js';
import { BufferStream, makeClock } from './upgrade-test-utils.js';

describe('UpgradeRenderer — TTY', () => {
  it('renders an in-place bar and rewrites the same line on progress', () => {
    const out = new BufferStream();
    const clock = makeClock();
    const r = new UpgradeRenderer({ out, isTTY: true, now: clock.now, barWidth: 10 });

    r.stepStart(0, 2, 'Re-index memory database', 100);
    const afterStart = out.buffer;

    clock.advance(1_000);
    r.stepProgress(0, 2, 'Re-index memory database', 50, 100);

    expect(out.buffer.startsWith(afterStart)).toBe(true);
    expect(out.buffer).toContain('\r'); // in-place rewrite happened
    expect(out.buffer).toContain('50%');
    expect(out.buffer).toContain('/s');
    expect(out.buffer).toContain('ETA');
    // Initial render at 0% has no throughput yet.
    expect(afterStart).toContain('0%');
    expect(afterStart).not.toContain('ETA');
  });

  it('clears the in-place line when step completes', () => {
    const out = new BufferStream();
    const r = new UpgradeRenderer({ out, isTTY: true, now: makeClock().now });

    r.stepStart(0, 1, 'Re-index memory database', 10);
    r.stepComplete(0, 1, 'Re-index memory database', 10);

    // The completion line ends with a newline; no trailing in-place fragment.
    expect(out.buffer.endsWith('\n')).toBe(true);
    expect(out.buffer).toContain('✓ Step 1/1 complete');
  });

  it('clamps percent to 100 when itemsDone exceeds itemsTotal', () => {
    const out = new BufferStream();
    const clock = makeClock();
    const r = new UpgradeRenderer({ out, isTTY: true, now: clock.now, barWidth: 5 });

    r.stepStart(0, 1, 'Re-index memory database', 10);
    clock.advance(1_000);
    r.stepProgress(0, 1, 'Re-index memory database', 999, 10);

    expect(out.buffer).toContain('100%');
    // No percentages above 100 leaking through.
    expect(out.buffer).not.toMatch(/\b[2-9]\d\d%|\d{4,}%/);
  });

  it('handles zero-item steps without dividing by zero', () => {
    const out = new BufferStream();
    const r = new UpgradeRenderer({ out, isTTY: true, now: makeClock().now });

    expect(() => r.stepStart(0, 1, 'Re-index memory database', 0)).not.toThrow();
    expect(out.buffer).toContain('0%');
  });
});

describe('UpgradeRenderer — non-TTY', () => {
  it('emits a newline-terminated status line per update, never \\r', () => {
    const out = new BufferStream();
    const clock = makeClock();
    const r = new UpgradeRenderer({
      out,
      isTTY: false,
      now: clock.now,
      nonTtyThrottleMs: 3_000,
    });

    r.stepStart(0, 2, 'Re-index memory database', 100);
    clock.advance(3_500);
    r.stepProgress(0, 2, 'Re-index memory database', 50, 100);

    expect(out.buffer).not.toContain('\r');
    expect(out.buffer.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(2);
    expect(out.buffer).toContain('50/100 items (50%)');
  });

  it('throttles non-TTY progress updates to the configured interval', () => {
    const out = new BufferStream();
    const clock = makeClock();
    const r = new UpgradeRenderer({
      out,
      isTTY: false,
      now: clock.now,
      nonTtyThrottleMs: 3_000,
    });

    r.stepStart(0, 1, 'Re-index memory database', 100);
    const initialLines = out.buffer.split('\n').filter(Boolean).length;

    clock.advance(500);
    r.stepProgress(0, 1, 'Re-index memory database', 10, 100);
    clock.advance(500);
    r.stepProgress(0, 1, 'Re-index memory database', 20, 100);
    clock.advance(500);
    r.stepProgress(0, 1, 'Re-index memory database', 30, 100);

    // None of those three updates should have printed — each was <3s apart.
    expect(out.buffer.split('\n').filter(Boolean).length).toBe(initialLines);

    // Cross the throttle threshold — now a line emits.
    clock.advance(2_000);
    r.stepProgress(0, 1, 'Re-index memory database', 40, 100);
    expect(out.buffer.split('\n').filter(Boolean).length).toBe(initialLines + 1);
  });

  it('emits one status line immediately on step start', () => {
    const out = new BufferStream();
    const r = new UpgradeRenderer({ out, isTTY: false, now: makeClock().now });
    r.stepStart(0, 3, 'Re-index memory database', 50);
    expect(out.buffer).toContain('Step 1/3: Re-index memory database — 0/50 items (0%)');
  });
});

describe('UpgradeRenderer — terminal messaging', () => {
  it('announce prints the text sandwiched by blank lines', () => {
    const out = new BufferStream();
    const r = new UpgradeRenderer({ out, isTTY: false, now: makeClock().now });
    r.announce('Hello\nWorld');
    expect(out.buffer).toBe('\nHello\nWorld\n\n');
  });

  it('paused message carries the items done/total', () => {
    const out = new BufferStream();
    const r = new UpgradeRenderer({ out, isTTY: false, now: makeClock().now });
    r.paused(80, 341);
    expect(out.buffer).toContain(
      'Paused. Will resume automatically next time moflo runs. (80 of 341 items done.)',
    );
  });

  it('failed message names the step and hints at verbose mode', () => {
    const out = new BufferStream();
    const r = new UpgradeRenderer({ out, isTTY: false, now: makeClock().now });
    r.failed('Re-index memory database');
    expect(out.buffer).toContain('Upgrade failed while re-indexing "Re-index memory database"');
    expect(out.buffer).toContain('MOFLO_UPGRADE_VERBOSE=1');
  });

  it('complete prints the final summary with total items and duration', () => {
    const out = new BufferStream();
    const r = new UpgradeRenderer({ out, isTTY: false, now: makeClock().now });
    r.complete(469, 185_000);
    expect(out.buffer).toContain(
      '✓ Memory upgrade complete — 469 items re-indexed in 3m 5s.',
    );
  });
});
