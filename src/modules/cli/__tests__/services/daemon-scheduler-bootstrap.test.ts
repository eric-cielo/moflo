/**
 * Daemon Scheduler Bootstrap Tests
 *
 * Story #446 — verifies the bootstrap respects `enabled: false` as a full
 * no-op, and that SchedulerOptions (pollIntervalMs, maxConcurrent,
 * catchUpWindowMs) flow from moflo.yaml → bootstrap → SpellScheduler
 * constructor.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/engine-loader.js', () => ({
  loadSpellEngine: vi.fn(),
}));

vi.mock('../../src/services/grimoire-builder.js', () => ({
  buildGrimoire: vi.fn(),
}));

vi.mock('../../src/services/daemon-spell-executor.js', () => ({
  DaemonSpellExecutor: vi.fn().mockImplementation(function () {
    return { execute: vi.fn(), exists: vi.fn() };
  }),
}));

import { bootstrapDaemonScheduler } from '../../src/services/daemon-scheduler-bootstrap.js';
import { loadSpellEngine } from '../../src/services/engine-loader.js';
import { buildGrimoire } from '../../src/services/grimoire-builder.js';
import type { WorkerDaemon } from '../../src/services/worker-daemon.js';
import type { MemoryAccessor } from '../../../spells/src/types/step-command.types.js';

const mockLoadEngine = vi.mocked(loadSpellEngine);
const mockBuildGrimoire = vi.mocked(buildGrimoire);

function makeDaemon() {
  return {
    attachScheduler: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkerDaemon;
}

function makeMemory(): MemoryAccessor {
  return {
    read: vi.fn(),
    write: vi.fn(),
    search: vi.fn(),
  } as unknown as MemoryAccessor;
}

describe('bootstrapDaemonScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null and skips engine loading entirely when enabled=false', async () => {
    const daemon = makeDaemon();
    const memory = makeMemory();

    const result = await bootstrapDaemonScheduler(daemon, {
      projectRoot: '/p',
      memory,
      enabled: false,
    });

    expect(result).toBeNull();
    // No engine import, no Grimoire build, no attach — full no-op so the
    // daemon can run without pulling in the heavy spells bundle.
    expect(mockLoadEngine).not.toHaveBeenCalled();
    expect(mockBuildGrimoire).not.toHaveBeenCalled();
    expect(daemon.attachScheduler).not.toHaveBeenCalled();
  });

  it('bootstraps normally when enabled is omitted (defaults to true)', async () => {
    const daemon = makeDaemon();
    const memory = makeMemory();
    const schedulerCtor = vi.fn().mockImplementation(function () {
      return { start: vi.fn(), isRunning: false };
    });
    mockLoadEngine.mockResolvedValue({
      SpellScheduler: schedulerCtor,
      loadSandboxConfigFromProject: vi.fn().mockResolvedValue(undefined),
    } as any);
    mockBuildGrimoire.mockResolvedValue({ registry: {} } as any);

    const result = await bootstrapDaemonScheduler(daemon, {
      projectRoot: '/p',
      memory,
    });

    expect(result).not.toBeNull();
    expect(mockLoadEngine).toHaveBeenCalled();
    expect(daemon.attachScheduler).toHaveBeenCalled();
  });

  it('passes schedulerOptions through to the SpellScheduler constructor', async () => {
    const daemon = makeDaemon();
    const memory = makeMemory();
    const schedulerCtor = vi.fn().mockImplementation(function () {
      return { start: vi.fn(), isRunning: false };
    });
    mockLoadEngine.mockResolvedValue({
      SpellScheduler: schedulerCtor,
      loadSandboxConfigFromProject: vi.fn().mockResolvedValue(undefined),
    } as any);
    mockBuildGrimoire.mockResolvedValue({ registry: {} } as any);

    await bootstrapDaemonScheduler(daemon, {
      projectRoot: '/p',
      memory,
      enabled: true,
      schedulerOptions: {
        pollIntervalMs: 5000,
        maxConcurrent: 8,
        catchUpWindowMs: 7_200_000,
      },
    });

    // 3rd constructor arg is the options bag — proves config flows through.
    expect(schedulerCtor).toHaveBeenCalledTimes(1);
    const callArgs = schedulerCtor.mock.calls[0];
    expect(callArgs[2]).toEqual({
      pollIntervalMs: 5000,
      maxConcurrent: 8,
      catchUpWindowMs: 7_200_000,
    });
  });

  it('awaits the async attachScheduler call', async () => {
    const daemon = makeDaemon();
    const memory = makeMemory();
    mockLoadEngine.mockResolvedValue({
      SpellScheduler: vi.fn().mockImplementation(function () {
        return { start: vi.fn(), isRunning: false };
      }),
      loadSandboxConfigFromProject: vi.fn().mockResolvedValue(undefined),
    } as any);
    mockBuildGrimoire.mockResolvedValue({ registry: {} } as any);

    await bootstrapDaemonScheduler(daemon, { projectRoot: '/p', memory });

    expect(daemon.attachScheduler).toHaveBeenCalledTimes(1);
  });
});
