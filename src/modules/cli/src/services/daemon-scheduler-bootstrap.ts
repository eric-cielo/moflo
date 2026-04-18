/**
 * Daemon Scheduler Bootstrap
 *
 * Wires the SpellScheduler into a running WorkerDaemon. Builds the
 * Grimoire registry, pre-resolves the sandbox config (so per-execute
 * runs don't re-read moflo.yaml), constructs a DaemonSpellExecutor,
 * instantiates the scheduler, and attaches it.
 */

import type { WorkerDaemon } from './worker-daemon.js';
import type { MemoryAccessor } from '../../../spells/src/types/step-command.types.js';
import type { SpellScheduler } from '../../../spells/src/scheduler/scheduler.js';
import type { SchedulerOptions } from '../../../spells/src/scheduler/schedule.types.js';
import { loadSpellEngine } from './engine-loader.js';
import { buildGrimoire } from './grimoire-builder.js';
import { DaemonSpellExecutor } from './daemon-spell-executor.js';

export interface BootstrapSchedulerOptions {
  readonly projectRoot: string;
  readonly memory: MemoryAccessor;
  /** When false, bootstrap is a no-op and returns null. Defaults to true. */
  readonly enabled?: boolean;
  /** Scheduler tuning (poll interval, max concurrent, catch-up window, etc.). */
  readonly schedulerOptions?: SchedulerOptions;
}

/**
 * Load the spell registry, build the executor, and attach a fresh scheduler
 * to the daemon. Returns the scheduler for callers that want to observe
 * events directly, or null when scheduling is disabled via config. Throws
 * if the spells package can't be loaded — the caller decides whether
 * scheduler bootstrap failure is fatal for the daemon as a whole.
 */
export async function bootstrapDaemonScheduler(
  daemon: WorkerDaemon,
  options: BootstrapSchedulerOptions,
): Promise<SpellScheduler | null> {
  if (options.enabled === false) return null;

  const engine = await loadSpellEngine();
  const { registry } = await buildGrimoire(options.projectRoot, engine);

  // Pre-resolve the sandbox config so the executor doesn't re-read
  // moflo.yaml + re-parse YAML on every scheduled execute.
  const sandboxConfig = await engine.loadSandboxConfigFromProject(options.projectRoot);

  const executor = new DaemonSpellExecutor({
    registry,
    projectRoot: options.projectRoot,
    memory: options.memory,
    engine,
    sandboxConfig,
  });

  const scheduler = new engine.SpellScheduler(
    options.memory,
    executor,
    options.schedulerOptions,
  );
  await daemon.attachScheduler(scheduler);
  return scheduler;
}
