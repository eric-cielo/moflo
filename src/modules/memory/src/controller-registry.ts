/**
 * ControllerRegistry - Central controller lifecycle management.
 *
 * Owns a sql.js Database handle and instantiates moflo memory controllers
 * (see ./controllers/) against it.
 *
 * Per ADR-053.
 *
 * @module @moflo/memory/controller-registry
 */

import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import type { Database as SqlJsDatabase } from 'sql.js';
import type {
  IMemoryBackend,
  EmbeddingGenerator,
  SONAMode,
} from './types.js';
import { openSqlJsDatabase } from './sqljs-backend.js';
import { LearningBridge } from './learning-bridge.js';
import type { LearningBridgeConfig } from './learning-bridge.js';
import { MemoryGraph } from './memory-graph.js';
import type { MemoryGraphConfig } from './memory-graph.js';
import { TieredCacheManager } from './cache-manager.js';
import type { CacheConfig } from './types.js';

// ===== Types =====

/**
 * Controllers that require the shared sql.js Database handle.
 * `reasoningBank` has no moflo implementation yet — it registers as
 * unavailable and consumers must null-check.
 */
export type MofloDbControllerName =
  | 'reasoningBank'
  | 'skills'
  | 'reflexion'
  | 'causalGraph'
  | 'learningSystem'
  | 'nightlyLearner'
  | 'mutationGuard'
  | 'attestationLog';

/**
 * CLI-layer controllers (from @moflo/memory)
 */
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

/**
 * All controller names
 */
export type ControllerName = MofloDbControllerName | CLIControllerName;

/**
 * Initialization level for dependency ordering
 */
export interface InitLevel {
  level: number;
  controllers: ControllerName[];
}

/**
 * Individual controller health status
 */
export interface ControllerHealth {
  name: ControllerName;
  status: 'healthy' | 'degraded' | 'unavailable';
  initTimeMs: number;
  error?: string;
}

/**
 * Aggregated health report for all controllers
 */
export interface RegistryHealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  controllers: ControllerHealth[];
  mofloDbAvailable: boolean;
  initTimeMs: number;
  timestamp: number;
  activeControllers: number;
  totalControllers: number;
}

/**
 * Runtime configuration for controller activation
 */
export interface RuntimeConfig {
  /** Database path for sql.js (`:memory:` for in-memory). */
  dbPath?: string;

  /** Vector dimension (default: 384 for MiniLM) */
  dimension?: number;

  /** Embedding generator function */
  embeddingGenerator?: EmbeddingGenerator;

  /** Memory backend config */
  memory?: {
    enableHNSW?: boolean;
    learningBridge?: Partial<LearningBridgeConfig>;
    memoryGraph?: Partial<MemoryGraphConfig>;
    tieredCache?: Partial<CacheConfig>;
  };

  /** Neural config */
  neural?: {
    enabled?: boolean;
    modelPath?: string;
    sonaMode?: SONAMode;
  };

  /** Controllers to explicitly enable/disable */
  controllers?: Partial<Record<ControllerName, boolean>>;

  /** Backend instance to use (if pre-created) */
  backend?: IMemoryBackend;

  /** Optional sql.js WASM path override. */
  wasmPath?: string;
}

/**
 * Controller instance wrapper
 */
interface ControllerEntry {
  name: ControllerName;
  instance: unknown;
  level: number;
  initTimeMs: number;
  enabled: boolean;
  error?: string;
}

/**
 * Minimal wrapper holding the sql.js Database handle used by moflo-owned
 * controllers. Exposed via `getMofloDb()` to consumers.
 */
interface SqlJsHandle {
  database: SqlJsDatabase;
  close(): Promise<void>;
}

// ===== Initialization Levels =====

/**
 * Level-based initialization order per ADR-053.
 * Controllers at each level can be initialized in parallel.
 * Each level must complete before the next begins.
 */
export const INIT_LEVELS: InitLevel[] = [
  // Level 0: Foundation - already exists
  { level: 0, controllers: [] },
  // Level 1: Core intelligence
  { level: 1, controllers: ['reasoningBank', 'hierarchicalMemory', 'learningBridge', 'hybridSearch', 'tieredCache'] },
  // Level 2: Graph & security
  { level: 2, controllers: ['memoryGraph', 'agentMemoryScope', 'mutationGuard'] },
  // Level 3: Specialization
  { level: 3, controllers: ['skills', 'reflexion', 'attestationLog', 'batchOperations', 'memoryConsolidation'] },
  // Level 4: Causal & routing
  { level: 4, controllers: ['causalGraph', 'nightlyLearner', 'learningSystem', 'semanticRouter'] },
  // Level 5: Advanced services
  { level: 5, controllers: ['contextSynthesizer'] },
];

// ===== ControllerRegistry =====

/**
 * Central registry for moflo memory controller lifecycle management.
 *
 * Handles:
 * - Level-based initialization ordering (levels 0-5)
 * - Graceful degradation (each controller fails independently)
 * - Config-driven activation (controllers only instantiate when enabled)
 * - Health check aggregation across all controllers
 * - Ordered shutdown (reverse initialization order)
 *
 * @example
 * ```typescript
 * const registry = new ControllerRegistry();
 * await registry.initialize({
 *   dbPath: './data/memory.db',
 *   dimension: 384,
 *   memory: {
 *     enableHNSW: true,
 *     learningBridge: { sonaMode: 'balanced' },
 *     memoryGraph: { pageRankDamping: 0.85 },
 *   },
 * });
 *
 * const bridge = registry.get<LearningBridge>('learningBridge');
 * const graph = registry.get<MemoryGraph>('memoryGraph');
 *
 * await registry.shutdown();
 * ```
 */
export class ControllerRegistry extends EventEmitter {
  private controllers: Map<ControllerName, ControllerEntry> = new Map();
  /** sql.js Database handle wrapped as MofloDb. */
  private mofloDb: SqlJsHandle | null = null;
  private backend: IMemoryBackend | null = null;
  private config: RuntimeConfig = {};
  private initialized = false;
  private initTimeMs = 0;

  /**
   * Initialize all controllers in level-based order.
   *
   * Each level's controllers are initialized in parallel within the level.
   * Failures are isolated: a controller that fails to init is marked as
   * unavailable but does not block other controllers.
   */
  async initialize(config: RuntimeConfig = {}): Promise<void> {
    if (this.initialized) return;
    this.initialized = true; // Set early to prevent concurrent re-entry

    this.config = config;
    const startTime = performance.now();

    // Step 1: Open the shared sql.js Database used by moflo controllers.
    await this.initSqlJs(config);

    // Step 2: Set up the backend
    this.backend = config.backend || null;

    // Step 3: Initialize controllers level by level
    for (const level of INIT_LEVELS) {
      const controllersToInit = level.controllers.filter(
        (name) => this.isControllerEnabled(name),
      );

      if (controllersToInit.length === 0) continue;

      // Initialize all controllers in this level in parallel
      const results = await Promise.allSettled(
        controllersToInit.map((name) => this.initController(name, level.level)),
      );

      // Process results
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const name = controllersToInit[i];

        if (result.status === 'rejected') {
          const errorMsg = result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);

          this.controllers.set(name, {
            name,
            instance: null,
            level: level.level,
            initTimeMs: 0,
            enabled: false,
            error: errorMsg,
          });

          this.emit('controller:failed', { name, error: errorMsg, level: level.level });
        }
      }
    }

    this.initTimeMs = performance.now() - startTime;
    this.emit('initialized', {
      initTimeMs: this.initTimeMs,
      activeControllers: this.getActiveCount(),
      totalControllers: this.controllers.size,
    });
  }

  /**
   * Shutdown all controllers in reverse initialization order.
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    // Shutdown in reverse level order
    const reverseLevels = [...INIT_LEVELS].reverse();

    for (const level of reverseLevels) {
      const controllersToShutdown = level.controllers
        .filter((name) => {
          const entry = this.controllers.get(name);
          return entry?.enabled && entry?.instance;
        });

      await Promise.allSettled(
        controllersToShutdown.map((name) => this.shutdownController(name)),
      );
    }

    // Close sql.js handle
    if (this.mofloDb) {
      try {
        await this.mofloDb.close();
      } catch {
        // Best-effort cleanup
      }
      this.mofloDb = null;
    }

    this.controllers.clear();
    this.initialized = false;
    this.emit('shutdown');
  }

  /**
   * Get a controller instance by name.
   * Returns null if the controller is not initialized or unavailable.
   */
  get<T>(name: ControllerName): T | null {
    const entry = this.controllers.get(name);
    if (entry?.enabled && entry?.instance) {
      return entry.instance as T;
    }
    return null;
  }

  /**
   * Check if a controller is enabled and initialized.
   */
  isEnabled(name: ControllerName): boolean {
    const entry = this.controllers.get(name);
    return Boolean(entry?.enabled);
  }

  /**
   * Aggregate health check across all controllers.
   */
  async healthCheck(): Promise<RegistryHealthReport> {
    const controllerHealth: ControllerHealth[] = [];

    for (const [name, entry] of this.controllers) {
      controllerHealth.push({
        name,
        status: entry.enabled
          ? 'healthy'
          : entry.error
            ? 'unavailable'
            : 'degraded',
        initTimeMs: entry.initTimeMs,
        error: entry.error,
      });
    }

    const active = controllerHealth.filter((c) => c.status === 'healthy').length;
    const unavailable = controllerHealth.filter((c) => c.status === 'unavailable').length;

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (unavailable > 0 && active === 0) {
      status = 'unhealthy';
    } else if (unavailable > 0) {
      status = 'degraded';
    }

    return {
      status,
      controllers: controllerHealth,
      mofloDbAvailable: this.mofloDb !== null,
      initTimeMs: this.initTimeMs,
      timestamp: Date.now(),
      activeControllers: active,
      totalControllers: controllerHealth.length,
    };
  }

  /**
   * Get the underlying sql.js handle wrapped as MofloDb.
   */
  getMofloDb(): SqlJsHandle | null {
    return this.mofloDb;
  }

  /**
   * Get the memory backend.
   */
  getBackend(): IMemoryBackend | null {
    return this.backend;
  }

  /**
   * Check if the registry is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the number of active (successfully initialized) controllers.
   */
  getActiveCount(): number {
    let count = 0;
    for (const entry of this.controllers.values()) {
      if (entry.enabled) count++;
    }
    return count;
  }

  /**
   * List all registered controller names and their status.
   */
  listControllers(): Array<{ name: ControllerName; enabled: boolean; level: number }> {
    return Array.from(this.controllers.entries()).map(([name, entry]) => ({
      name,
      enabled: entry.enabled,
      level: entry.level,
    }));
  }

  // ===== Private Methods =====

  /**
   * Open a sql.js Database and expose it via `this.mofloDb.database` to the
   * moflo controllers that need one.
   */
  private async initSqlJs(config: RuntimeConfig): Promise<void> {
    try {
      // Validate dbPath to prevent path traversal
      const dbPath = config.dbPath || ':memory:';
      if (dbPath !== ':memory:') {
        const resolved = path.resolve(dbPath);
        if (resolved.includes('..')) {
          this.emit('mofloDb:unavailable', { reason: 'Invalid dbPath' });
          return;
        }
      }

      const database = await openSqlJsDatabase(dbPath, config.wasmPath);

      this.mofloDb = {
        database,
        close: async () => database.close(),
      };
      this.emit('mofloDb:initialized');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.emit('mofloDb:unavailable', { reason: msg.substring(0, 200) });
      this.mofloDb = null;
    }
  }

  /**
   * Check whether a controller should be initialized based on config.
   */
  private isControllerEnabled(name: ControllerName): boolean {
    // Explicit enable/disable from config
    if (this.config.controllers) {
      const explicit = this.config.controllers[name];
      if (explicit !== undefined) return explicit;
    }

    // Default behavior: enable based on category
    switch (name) {
      // Core intelligence — enabled by default
      case 'learningBridge':
      case 'tieredCache':
      case 'hierarchicalMemory':
        return true;

      // No moflo implementation yet — see createController.
      case 'reasoningBank':
        return false;

      case 'memoryGraph':
        return !!(this.config.memory?.memoryGraph || this.backend);

      // In-memory, no DB needed.
      case 'mutationGuard':
      case 'contextSynthesizer':
      case 'semanticRouter':
        return true;

      // Need the sql.js handle.
      case 'attestationLog':
      case 'skills':
      case 'reflexion':
      case 'causalGraph':
      case 'learningSystem':
      case 'nightlyLearner':
      case 'memoryConsolidation':
      case 'batchOperations':
        return this.mofloDb !== null;

      // Require explicit enabling via config.controllers.
      case 'hybridSearch':
      case 'agentMemoryScope':
        return false;

      default:
        return false;
    }
  }

  /**
   * Initialize a single controller with error isolation.
   */
  private async initController(name: ControllerName, level: number): Promise<void> {
    const startTime = performance.now();

    try {
      const instance = await this.createController(name);

      const initTimeMs = performance.now() - startTime;

      this.controllers.set(name, {
        name,
        instance,
        level,
        initTimeMs,
        enabled: instance !== null,
        error: instance === null ? 'Controller returned null' : undefined,
      });

      if (instance !== null) {
        this.emit('controller:initialized', { name, level, initTimeMs });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const initTimeMs = performance.now() - startTime;

      this.controllers.set(name, {
        name,
        instance: null,
        level,
        initTimeMs,
        enabled: false,
        error: errorMsg,
      });

      throw error;
    }
  }

  /**
   * Factory method to create a controller instance. `reasoningBank` has no
   * moflo implementation yet and returns null — consumers null-check already.
   */
  private async createController(name: ControllerName): Promise<unknown> {
    switch (name) {
      // ----- CLI-layer controllers -----

      case 'learningBridge': {
        if (!this.backend) return null;
        const config = this.config.memory?.learningBridge || {};
        const bridge = new LearningBridge(this.backend, {
          sonaMode: config.sonaMode || this.config.neural?.sonaMode || 'balanced',
          confidenceDecayRate: config.confidenceDecayRate,
          accessBoostAmount: config.accessBoostAmount,
          consolidationThreshold: config.consolidationThreshold,
          enabled: true,
        });
        return bridge;
      }

      case 'memoryGraph': {
        const config = this.config.memory?.memoryGraph || {};
        const graph = new MemoryGraph({
          pageRankDamping: config.pageRankDamping,
          maxNodes: config.maxNodes,
          ...config,
        });
        // Build from backend if available
        if (this.backend) {
          try {
            await graph.buildFromBackend(this.backend);
          } catch {
            // Graph build from backend failed — empty graph is still usable
          }
        }
        return graph;
      }

      case 'tieredCache': {
        const config = this.config.memory?.tieredCache || {};
        const cache = new TieredCacheManager({
          maxSize: config.maxSize || 10000,
          ttl: config.ttl || 300000,
          lruEnabled: true,
          writeThrough: false,
          ...config,
        });
        return cache;
      }

      case 'hybridSearch':
        // BM25 hybrid search — placeholder for future implementation
        return null;

      case 'agentMemoryScope':
        // Agent memory scope — placeholder, activated when explicitly enabled
        return null;

      case 'semanticRouter': {
        const { SemanticRouter } = await import('./controllers/semantic-router.js');
        const router = new SemanticRouter();
        await router.initialize();
        return router;
      }

      case 'hierarchicalMemory': {
        if (!this.mofloDb?.database) return this.createTieredMemoryStub();
        const { HierarchicalMemory } = await import('./controllers/hierarchical-memory.js');
        const embedder = this.config.embeddingGenerator;
        const hm = new HierarchicalMemory(this.mofloDb.database, { embedder });
        await hm.initializeDatabase();
        return hm;
      }

      case 'memoryConsolidation': {
        // Composes over the HierarchicalMemory instantiated at level 1.
        const hm: any = this.get('hierarchicalMemory');
        if (hm && typeof hm.listTier === 'function' && typeof hm.promote === 'function') {
          const { MemoryConsolidation } = await import('./controllers/memory-consolidation.js');
          return new MemoryConsolidation(hm);
        }
        return this.createConsolidationStub();
      }

      case 'reasoningBank': {
        // @moflo/neural's ReasoningBank has a trajectory-based API that
        // doesn't match what memory-bridge expects (title/description/content).
        // Null-returning keeps pattern-store calls as no-ops at the bridge.
        return null;
      }

      case 'skills': {
        if (!this.mofloDb?.database) return null;
        const { Skills } = await import('./controllers/skills.js');
        const skills = new Skills(this.mofloDb.database, {
          embedder: this.config.embeddingGenerator,
        });
        await skills.initializeDatabase();
        return skills;
      }

      case 'reflexion': {
        if (!this.mofloDb?.database) return null;
        const { Reflexion } = await import('./controllers/reflexion.js');
        const reflexion = new Reflexion(this.mofloDb.database, {
          embedder: this.config.embeddingGenerator,
        });
        await reflexion.initializeDatabase();
        return reflexion;
      }

      case 'causalGraph': {
        if (!this.mofloDb?.database) return null;
        const { CausalGraph } = await import('./controllers/causal-graph.js');
        const graph = new CausalGraph(this.mofloDb.database);
        await graph.initializeDatabase();
        return graph;
      }

      case 'learningSystem': {
        if (!this.mofloDb?.database) return null;
        const { LearningSystem } = await import('./controllers/learning-system.js');
        const ls = new LearningSystem(this.mofloDb.database);
        await ls.initializeDatabase();
        return ls;
      }

      case 'nightlyLearner': {
        // Pulls together MemoryConsolidation / Reflexion / Skills already in the registry.
        const { NightlyLearner } = await import('./controllers/nightly-learner.js');
        const { hasMethod } = await import('./controllers/_shared.js');
        const mc: any = this.get('memoryConsolidation');
        const refl: any = this.get('reflexion');
        const sk: any = this.get('skills');
        const mofloMc = hasMethod(mc, 'getOptions') ? mc : undefined;
        const mofloRefl = hasMethod(refl, 'episodeCount') ? refl : undefined;
        const mofloSk = hasMethod(sk, 'list') ? sk : undefined;
        if (!mofloMc && !mofloRefl && !mofloSk) return null;
        return new NightlyLearner({
          memoryConsolidation: mofloMc,
          reflexion: mofloRefl,
          skills: mofloSk,
        });
      }

      case 'batchOperations': {
        if (!this.mofloDb?.database) return null;
        const { BatchOperations } = await import('./controllers/batch-operations.js');
        return new BatchOperations(this.mofloDb.database, this.config.embeddingGenerator);
      }

      case 'contextSynthesizer': {
        // ContextSynthesizer.synthesize is static — return the class itself.
        const { ContextSynthesizer } = await import('./controllers/context-synthesizer.js');
        return ContextSynthesizer;
      }

      case 'mutationGuard': {
        const { MutationGuard } = await import('./controllers/mutation-guard.js');
        return new MutationGuard();
      }

      case 'attestationLog': {
        if (!this.mofloDb?.database) return null;
        const { AttestationLog } = await import('./controllers/attestation-log.js');
        return new AttestationLog(this.mofloDb.database);
      }

      default:
        return null;
    }
  }

  /**
   * Shutdown a single controller gracefully.
   */
  private async shutdownController(name: ControllerName): Promise<void> {
    const entry = this.controllers.get(name);
    if (!entry?.instance) return;

    try {
      const instance = entry.instance as any;

      // Try known shutdown methods (always await for safety)
      if (typeof instance.destroy === 'function') {
        await instance.destroy();
      } else if (typeof instance.shutdown === 'function') {
        await instance.shutdown();
      } else if (typeof instance.close === 'function') {
        await instance.close();
      }
    } catch {
      // Best-effort cleanup
    }

    entry.enabled = false;
    entry.instance = null;
  }

  /**
   * Lightweight in-memory tiered store (fallback when HierarchicalMemory
   * cannot be initialized from sql.js).
   * Enforces per-tier size limits to prevent unbounded memory growth.
   */
  private createTieredMemoryStub() {
    const MAX_PER_TIER = 5000;
    const tiers: Record<string, Map<string, { value: string; ts: number }>> = {
      working: new Map(),
      episodic: new Map(),
      semantic: new Map(),
    };
    return {
      store(key: string, value: string, tier = 'working') {
        const t = tiers[tier] || tiers.working;
        // Evict oldest if at capacity
        if (t.size >= MAX_PER_TIER) {
          const oldest = t.keys().next().value;
          if (oldest !== undefined) t.delete(oldest);
        }
        t.set(key, { value: value.substring(0, 100_000), ts: Date.now() });
      },
      recall(query: string, topK = 5) {
        const safeTopK = Math.min(Math.max(1, topK), 100);
        const q = query.toLowerCase().substring(0, 10_000);
        const results: Array<{ key: string; value: string; tier: string; ts: number }> = [];
        for (const [tierName, map] of Object.entries(tiers)) {
          for (const [key, entry] of map) {
            if (key.toLowerCase().includes(q) || entry.value.toLowerCase().includes(q)) {
              results.push({ key, value: entry.value, tier: tierName, ts: entry.ts });
              if (results.length >= safeTopK * 3) break; // Early exit for large stores
            }
          }
        }
        return results.sort((a, b) => b.ts - a.ts).slice(0, safeTopK);
      },
      getTierStats() {
        return Object.fromEntries(
          Object.entries(tiers).map(([name, map]) => [name, map.size]),
        );
      },
    };
  }

  /**
   * No-op consolidation stub (fallback when MemoryConsolidation
   * cannot be initialized).
   */
  private createConsolidationStub() {
    return {
      consolidate() {
        return { promoted: 0, pruned: 0, timestamp: Date.now() };
      },
    };
  }
}

export default ControllerRegistry;
