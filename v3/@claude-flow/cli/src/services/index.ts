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
  HEADLESS_WORKER_TYPES,
  HEADLESS_WORKER_CONFIGS,
  LOCAL_WORKER_TYPES,
  LOCAL_WORKER_CONFIGS,
  ALL_WORKER_CONFIGS,
  isHeadlessWorker,
  isLocalWorker,
  getModelId,
  getWorkerConfig,
  type HeadlessWorkerType,
  type LocalWorkerType,
  type HeadlessWorkerConfig,
  type HeadlessExecutionResult,
  type HeadlessExecutorConfig,
  type HeadlessOptions,
  type PoolStatus,
  type SandboxMode,
  type ModelType,
  type OutputFormat,
  type ExecutionMode,
  type WorkerPriority,
  type WorkerConfig,
} from './headless-worker-executor.js';

// Container Worker Pool (Phase 3)
export {
  ContainerWorkerPool,
  type ContainerInfo,
// Container Worker Pool removed — Docker infra not used by moflo

// Worker Queue (Phase 4)
export {
  WorkerQueue,
  type QueueTask,
  type WorkerQueueConfig,
  type QueueStats,
  type WorkerRegistration,
  type TaskStatus,
} from './worker-queue.js';

// Learning Service
export {
  LearningService,
  getLearningService,
  HNSWIndex,
  hashEmbed,
  cosineSimilarity,
  LEARNING_CONFIG,
  type PatternSearchResult,
  type StoreResult,
  type ConsolidateResult,
  type LearningStats,
  type PatternRow,
} from './learning-service.js';

// Agent Router
export {
  AgentRouter,
  getAgentRouter,
  routeTask,
  AGENT_CAPABILITIES,
  type RouteResult,
  type AgentType,
} from './agent-router.js';

// Re-export types
export type { default as WorkerDaemonType } from './worker-daemon.js';
export type { default as HeadlessWorkerExecutorType } from './headless-worker-executor.js';
// ContainerWorkerPool removed — Docker infra not used by moflo
export type { default as WorkerQueueType } from './worker-queue.js';
