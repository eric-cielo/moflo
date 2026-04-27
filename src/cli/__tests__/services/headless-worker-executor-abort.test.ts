/**
 * HeadlessWorkerExecutor — AbortSignal kill path (#669)
 *
 * Focused tests for the new signal-aware execute() so a worker disabled or
 * timed-out mid-flight actually kills the spawned `claude` child instead of
 * letting it run to natural completion.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue(''),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

vi.mock('glob', () => ({
  glob: vi.fn().mockResolvedValue([]),
  globSync: vi.fn().mockReturnValue([]),
}));

import { spawn, execSync } from 'child_process';
import {
  HeadlessWorkerExecutor,
  HEADLESS_WORKER_CONFIGS,
} from '../../services/headless-worker-executor.js';

/** Build a stub ChildProcess that records kill invocations. */
function makeStubChild(): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  const ee = new EventEmitter() as ChildProcess & { kill: ReturnType<typeof vi.fn>; killed: boolean };
  ee.stdout = new EventEmitter() as NodeJS.ReadableStream;
  ee.stderr = new EventEmitter() as NodeJS.ReadableStream;
  ee.killed = false;
  ee.kill = vi.fn().mockImplementation(() => {
    ee.killed = true;
    // Simulate the OS reaping the child: emit close so the executor's
    // close handler fires and resolves cleanly.
    setImmediate(() => ee.emit('close', 143));
    return true;
  });
  return ee;
}

describe('HeadlessWorkerExecutor abort-on-signal (#669)', () => {
  let executor: HeadlessWorkerExecutor;

  beforeEach(() => {
    // Treat `claude --version` as available so isAvailable() short-circuits true.
    // execSync is called with encoding: 'utf-8' so it returns a string, not a Buffer.
    (execSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue('1.2.3');
    executor = new HeadlessWorkerExecutor('/tmp/test-headless', { maxConcurrent: 1 });
    // Suppress 'error' event throws — emit('error', ...) on EventEmitter without
    // a listener becomes an unhandled rejection. We assert via the resolved
    // Promise instead.
    executor.on('error', () => { /* swallow */ });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('kills the spawned child when the AbortSignal fires', async () => {
    const child = makeStubChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);

    const workerType = Object.keys(HEADLESS_WORKER_CONFIGS)[0] as keyof typeof HEADLESS_WORKER_CONFIGS;
    const controller = new AbortController();

    const resultPromise = executor.execute(workerType, undefined, controller.signal);

    // Wait a tick so executeClaudeCode has installed its abort listener.
    await new Promise((r) => setImmediate(r));
    expect(child.kill).not.toHaveBeenCalled();

    controller.abort();
    const result = await resultPromise;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/aborted/i);
  });
});
