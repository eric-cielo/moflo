/**
 * Regression tests for `drainStream` — the two-stage stdout/stderr drain that
 * `drainAndExit` uses to avoid the Windows async-pipe race that drops printBox
 * content rows and trips libuv's UV_HANDLE_CLOSING assertion (issue #996).
 *
 * `drainStream` must:
 *   1. Resolve immediately when the stream is already drained.
 *   2. Wait for a `'drain'` event before issuing the libuv-level empty-write
 *      probe when `writableNeedDrain` is set.
 *   3. Resolve via the safety timeout when `'drain'` never fires (broken pipe).
 *   4. Resolve immediately when the stream is unwritable or destroyed.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { drainStream } from '../index.js';

interface FakeStream extends EventEmitter {
  writable: boolean;
  destroyed: boolean;
  writableNeedDrain: boolean;
  write: ReturnType<typeof vi.fn>;
}

function makeFakeStream(opts: Partial<Omit<FakeStream, keyof EventEmitter | 'write'>> = {}): FakeStream {
  const stream = new EventEmitter() as FakeStream;
  stream.writable = opts.writable ?? true;
  stream.destroyed = opts.destroyed ?? false;
  stream.writableNeedDrain = opts.writableNeedDrain ?? false;

  // Default `write` resolves the empty-write callback synchronously next tick,
  // mimicking Node's behaviour when libuv has nothing queued.
  stream.write = vi.fn((_chunk: string, cb?: () => void) => {
    if (cb) queueMicrotask(cb);
    return true;
  });

  return stream;
}

describe('drainStream', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves via the empty-write probe when the buffer is already drained', async () => {
    const stream = makeFakeStream({ writableNeedDrain: false });

    await drainStream(stream as unknown as NodeJS.WriteStream);

    expect(stream.write).toHaveBeenCalledTimes(1);
    expect(stream.write).toHaveBeenCalledWith('', expect.any(Function));
  });

  it('waits for "drain" before issuing the empty-write probe when the buffer is full', async () => {
    const stream = makeFakeStream({ writableNeedDrain: true });

    const drained = drainStream(stream as unknown as NodeJS.WriteStream);

    // The probe must NOT have fired yet — libuv may still hold a queued write.
    await Promise.resolve();
    expect(stream.write).not.toHaveBeenCalled();

    // Simulate Node flushing the userspace buffer to libuv.
    stream.emit('drain');

    await drained;
    expect(stream.write).toHaveBeenCalledTimes(1);
    expect(stream.write).toHaveBeenCalledWith('', expect.any(Function));
  });

  it('resolves via the safety timeout when "drain" never fires', async () => {
    vi.useFakeTimers();
    const stream = makeFakeStream({ writableNeedDrain: true });

    const drained = drainStream(stream as unknown as NodeJS.WriteStream);

    // Advance past the 250 ms safety window without emitting 'drain'.
    await vi.advanceTimersByTimeAsync(300);

    await expect(drained).resolves.toBeUndefined();
    // Probe never ran because we bailed via the timeout.
    expect(stream.write).not.toHaveBeenCalled();
    // And the listener was cleaned up so a stray late 'drain' won't NPE.
    expect(stream.listenerCount('drain')).toBe(0);
  });

  it('resolves immediately when the stream is not writable', async () => {
    const stream = makeFakeStream({ writable: false });

    await drainStream(stream as unknown as NodeJS.WriteStream);

    expect(stream.write).not.toHaveBeenCalled();
  });

  it('resolves immediately when the stream is destroyed', async () => {
    const stream = makeFakeStream({ destroyed: true });

    await drainStream(stream as unknown as NodeJS.WriteStream);

    expect(stream.write).not.toHaveBeenCalled();
  });

  it('resolves even if the empty-write probe throws synchronously', async () => {
    const stream = makeFakeStream({ writableNeedDrain: false });
    stream.write = vi.fn(() => {
      throw new Error('EPIPE');
    });

    await expect(drainStream(stream as unknown as NodeJS.WriteStream)).resolves.toBeUndefined();
  });
});
