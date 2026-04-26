/**
 * Worker Daemon Scheduler Integration Tests
 *
 * Verifies that WorkerDaemon.attachScheduler correctly wires a scheduler
 * into the daemon lifecycle: events are forwarded through the daemon's
 * EventEmitter, the poll loop starts when the daemon is running, and
 * detach/stop cleans up properly.
 *
 * Story #445.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockImplementation((path: string) => {
      if (path.includes('daemon-state.json') || path.includes('config.json')) return '{}';
      throw new Error('ENOENT');
    }),
    appendFileSync: vi.fn(),
  };
});

vi.mock('../../services/headless-worker-executor.js', () => ({
  HeadlessWorkerExecutor: vi.fn().mockImplementation(() => ({
    isAvailable: vi.fn().mockResolvedValue(false),
    on: vi.fn(),
  })),
  HEADLESS_WORKER_TYPES: [],
  HEADLESS_WORKER_CONFIGS: {},
  isHeadlessWorker: vi.fn().mockReturnValue(false),
}));

const originalOn = process.on.bind(process);
vi.spyOn(process, 'on').mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
  if (['SIGTERM', 'SIGINT', 'SIGHUP'].includes(event)) return process;
  return originalOn(event, handler);
});

import { WorkerDaemon } from '../../services/worker-daemon.js';
import type { SpellScheduler, SchedulerListener, SchedulerEvent } from '../../../spells/src/scheduler/scheduler.js';

function makeFakeScheduler(): {
  scheduler: SpellScheduler;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  fire: (ev: SchedulerEvent) => void;
  isRunning: () => boolean;
} {
  let listeners: SchedulerListener[] = [];
  let running = false;

  const start = vi.fn(() => { running = true; });
  const stop = vi.fn(async () => { running = false; });

  const scheduler = {
    get isRunning() { return running; },
    start,
    stop,
    on(listener: SchedulerListener) {
      listeners.push(listener);
      return () => { listeners = listeners.filter(l => l !== listener); };
    },
  } as unknown as SpellScheduler;

  return {
    scheduler,
    start,
    stop,
    fire(ev) { for (const l of listeners) l(ev); },
    isRunning: () => running,
  };
}

describe('WorkerDaemon scheduler integration', () => {
  let daemon: WorkerDaemon;

  beforeEach(() => {
    daemon = new WorkerDaemon('/tmp/test-project', {
      autoStart: false,
      workers: [],
    });
  });

  afterEach(async () => {
    await daemon.stop();
  });

  it('getScheduler returns null before any attach', () => {
    expect(daemon.getScheduler()).toBeNull();
  });

  it('attachScheduler before start defers the poll loop until start', async () => {
    const fake = makeFakeScheduler();
    await daemon.attachScheduler(fake.scheduler);

    expect(fake.start).not.toHaveBeenCalled();
    expect(daemon.getScheduler()).toBe(fake.scheduler);

    await daemon.start();
    expect(fake.start).toHaveBeenCalledTimes(1);
  });

  it('attachScheduler after start immediately starts the poll loop', async () => {
    await daemon.start();
    const fake = makeFakeScheduler();

    await daemon.attachScheduler(fake.scheduler);
    expect(fake.start).toHaveBeenCalledTimes(1);
  });

  it('forwards scheduler events through the daemon EventEmitter', async () => {
    const fake = makeFakeScheduler();
    await daemon.attachScheduler(fake.scheduler);

    const generic = vi.fn();
    const specific = vi.fn();
    daemon.on('scheduler:event', generic);
    daemon.on('schedule:completed', specific);

    const event: SchedulerEvent = {
      type: 'schedule:completed',
      scheduleId: 's1',
      spellName: 'wf1',
      message: 'done',
      timestamp: Date.now(),
    };
    fake.fire(event);

    expect(generic).toHaveBeenCalledWith(event);
    expect(specific).toHaveBeenCalledWith(event);
  });

  it('stops the attached scheduler when the daemon stops', async () => {
    const fake = makeFakeScheduler();
    await daemon.attachScheduler(fake.scheduler);
    await daemon.start();

    await daemon.stop();

    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it('detachScheduler stops the current scheduler and clears the reference', async () => {
    const fake = makeFakeScheduler();
    await daemon.attachScheduler(fake.scheduler);
    await daemon.start();

    await daemon.detachScheduler();

    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(daemon.getScheduler()).toBeNull();
  });

  it('replacing an existing scheduler stops the old one and wires the new', async () => {
    const first = makeFakeScheduler();
    const second = makeFakeScheduler();

    await daemon.attachScheduler(first.scheduler);
    await daemon.start();
    await daemon.attachScheduler(second.scheduler);

    // First must be stopped; replacement runs under the live daemon
    expect(first.stop).toHaveBeenCalled();
    expect(second.start).toHaveBeenCalledTimes(1);
    expect(daemon.getScheduler()).toBe(second.scheduler);
  });

  it('re-attaching the same scheduler is a no-op', async () => {
    const fake = makeFakeScheduler();
    await daemon.attachScheduler(fake.scheduler);
    await daemon.start();
    expect(fake.start).toHaveBeenCalledTimes(1);

    await daemon.attachScheduler(fake.scheduler);
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(fake.stop).not.toHaveBeenCalled();
  });

  it('events stop flowing after detach', async () => {
    const fake = makeFakeScheduler();
    await daemon.attachScheduler(fake.scheduler);
    const listener = vi.fn();
    daemon.on('scheduler:event', listener);

    await daemon.detachScheduler();
    fake.fire({
      type: 'schedule:due',
      scheduleId: 's1',
      spellName: 'wf1',
      message: 'x',
      timestamp: Date.now(),
    });

    expect(listener).not.toHaveBeenCalled();
  });
});
