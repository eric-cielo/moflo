/**
 * ControllerSpec — declarative contract used by {@link ControllerRegistry}
 * to instantiate and gate memory controllers.
 *
 * Each controller module exports its own `*Spec` and the registry iterates
 * a central list ({@link ./controller-specs.ts}) — no switch-on-name.
 *
 * @module @moflo/memory/controller-spec
 */

import type { Database as SqlJsDatabase } from 'sql.js';
import type {
  IMemoryBackend,
  EmbeddingGenerator,
  SONAMode,
  CacheConfig,
} from './types.js';
import type { LearningBridgeConfig } from './learning-bridge.js';
import type { MemoryGraphConfig } from './memory-graph.js';

/** Controllers that bind to the shared sql.js Database handle. */
export type MofloDbControllerName =
  | 'skills'
  | 'reflexion'
  | 'causalGraph'
  | 'learningSystem'
  | 'nightlyLearner'
  | 'mutationGuard'
  | 'attestationLog';

/** CLI-layer controllers (live outside `./controllers/`). */
export type CLIControllerName =
  | 'learningBridge'
  | 'memoryGraph'
  | 'agentMemoryScope'
  | 'tieredCache'
  | 'hybridSearch'
  | 'semanticRouter'
  | 'hierarchicalMemory'
  | 'memoryConsolidation'
  | 'batchOperations'
  | 'contextSynthesizer';

export type ControllerName = MofloDbControllerName | CLIControllerName;

/** Registry-owned resource a spec can declare as a prerequisite. */
export type ResourceName = 'sqljs' | 'backend';

/** Minimal wrapper holding the sql.js Database handle. */
export interface SqlJsHandle {
  database: SqlJsDatabase;
  close(): Promise<void>;
}

/** Runtime configuration for controller activation. */
export interface RuntimeConfig {
  /** Database path for sql.js (`:memory:` for in-memory). */
  dbPath?: string;
  /** Vector dimension (default: 384 for MiniLM). */
  dimension?: number;
  /** Embedding generator function. */
  embeddingGenerator?: EmbeddingGenerator;
  /** Memory backend config. */
  memory?: {
    enableHNSW?: boolean;
    learningBridge?: Partial<LearningBridgeConfig>;
    memoryGraph?: Partial<MemoryGraphConfig>;
    tieredCache?: Partial<CacheConfig>;
  };
  /** Neural config. */
  neural?: {
    enabled?: boolean;
    modelPath?: string;
    sonaMode?: SONAMode;
  };
  /** Controllers to explicitly enable/disable. */
  controllers?: Partial<Record<ControllerName, boolean>>;
  /** Backend instance to use (if pre-created). */
  backend?: IMemoryBackend;
  /** Optional sql.js WASM path override. */
  wasmPath?: string;
}

/** Context passed to `enabledByDefault` predicates. */
export interface EnablementContext {
  config: RuntimeConfig;
  mofloDb: SqlJsHandle | null;
  backend: IMemoryBackend | null;
}

/**
 * Read-only registry view exposed to a spec's `create` so composite
 * controllers can reference already-built controllers (guaranteed by
 * level ordering).
 */
export interface RegistryView {
  get<T>(name: ControllerName): T | null;
  isEnabled(name: ControllerName): boolean;
}

export interface ControllerDeps extends EnablementContext {
  embedder: EmbeddingGenerator | undefined;
  registry: RegistryView;
}

/**
 * Declarative controller contract. Each controller file exports one.
 *
 * @example
 * ```typescript
 * export const skillsSpec: ControllerSpec = {
 *   name: 'skills',
 *   level: 3,
 *   requires: ['sqljs'],
 *   enabledByDefault: true,
 *   create: async ({ mofloDb, embedder }) => {
 *     const s = new Skills(mofloDb!.database, { embedder });
 *     await s.initializeDatabase();
 *     return s;
 *   },
 * };
 * ```
 */
export interface ControllerSpec {
  name: ControllerName;
  /** Initialization level (0–5). Lower levels init first. */
  level: number;
  /**
   * Registry-owned resources required for this controller to init.
   * Missing resources skip the controller (no instance registered).
   */
  requires?: ResourceName[];
  /**
   * Default enablement. A function receives {@link EnablementContext}
   * for config-driven decisions. Overridden by `config.controllers[name]`.
   */
  enabledByDefault: boolean | ((ctx: EnablementContext) => boolean);
  /**
   * Factory. Return `null` to register the controller as unavailable
   * (useful for placeholder / stub fallbacks).
   */
  create: (deps: ControllerDeps) => Promise<unknown> | unknown;
}
