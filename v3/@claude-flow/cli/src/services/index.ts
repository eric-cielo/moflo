/**
 * V3 CLI Services Index
 * Central registry for all background services
 */

export {
  WorkerDaemon,
  getDaemon,
  startDaemon,
  stopDaemon,
  type WorkerType,
} from './worker-daemon.js';

export {
  HeadlessWorkerExecutor,
  HEADLESS_WORKERS,
  HEADLESS_WORKER_CONFIGS,
  isHeadlessWorker,
  type HeadlessWorkerType,
  type LocalWorkerType,
  type HeadlessWorkerConfig,
  type HeadlessExecutionResult,
  type SandboxMode,
  type ModelType,
} from './headless-worker-executor.js';

// Re-export types
export type { default as WorkerDaemonType } from './worker-daemon.js';
export type { default as HeadlessWorkerExecutorType } from './headless-worker-executor.js';
