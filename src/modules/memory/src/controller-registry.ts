/**
 * ControllerRegistry - Central controller lifecycle management for AgentDB v3
 *
 * Wraps the AgentDB class and adds CLI-specific controllers from @moflo/memory.
 * Manages initialization (level-based ordering), health checks, and graceful shutdown.
 *
 * Per ADR-053: Replaces memory-initializer.js's raw sql.js usage with a unified
 * controller ecosystem routing all memory operations through AgentDB v3.
 *
 * @module @moflo/memory/controller-registry
 */

import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import type {
  IMemoryBackend,
  HealthCheckResult,
  ComponentHealth,
  BackendStats,
  EmbeddingGenerator,
  SONAMode,
} from './types.js';
import { LearningBridge } from './learning-bridge.js';
import type { LearningBridgeConfig } from './learning-bridge.js';
import { MemoryGraph } from './memory-graph.js';
import type { MemoryGraphConfig } from './memory-graph.js';
import { TieredCacheManager } from './cache-manager.js';
import type { CacheConfig } from './types.js';

// ===== Types =====

/**
 * Controllers accessible via AgentDB.getController()
 */
export type AgentDBControllerName =
  | 'reasoningBank'
  | 'skills'
  | 'reflexion'
  | 'causalGraph'
  | 'learningSystem'
  | 'nightlyLearner'
  | 'mutationGuard'
  | 'attestationLog';

/**
 * CLI-layer controllers (from @moflo/memory or new)
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
export type ControllerName = AgentDBControllerName | CLIControllerName;

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
  agentdbAvailable: boolean;
  initTimeMs: number;
  timestamp: number;
  activeControllers: number;
  totalControllers: number;
}

/**
 * Runtime configuration for controller activation
 */
export interface RuntimeConfig {
  /** Database path for AgentDB */
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
 * Central registry for AgentDB v3 controller lifecycle management.
 *
 * Handles:
 * - Level-based initialization ordering (levels 0-6)
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
 * const reasoning = registry.get<ReasoningBank>('reasoningBank');
 * const graph = registry.get<MemoryGraph>('memoryGraph');
 *
 * await registry.shutdown();
 * ```
 */
export class ControllerRegistry extends EventEmitter {
  private controllers: Map<ControllerName, ControllerEntry> = new Map();
  private agentdb: any = null;
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

    // Step 1: Initialize AgentDB (the core)
    await this.initAgentDB(config);

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

    // Shutdown AgentDB
    if (this.agentdb) {
      try {
        if (typeof this.agentdb.close === 'function') {
          await this.agentdb.close();
        }
      } catch {
        // Best-effort cleanup
      }
      this.agentdb = null;
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
    // First check CLI-layer controllers
    const entry = this.controllers.get(name);
    if (entry?.enabled && entry?.instance) {
      return entry.instance as T;
    }

    // Fall back to AgentDB internal controllers
    if (this.agentdb && typeof this.agentdb.getController === 'function') {
      try {
        const controller = this.agentdb.getController(name);
        if (controller) return controller as T;
      } catch {
        // Controller not available in AgentDB
      }
    }

    return null;
  }

  /**
   * Check if a controller is enabled and initialized.
   */
  isEnabled(name: ControllerName): boolean {
    const entry = this.controllers.get(name);
    if (entry?.enabled) return true;

    // Check AgentDB internal controllers
    if (this.agentdb && typeof this.agentdb.getController === 'function') {
      try {
        return this.agentdb.getController(name) !== null;
      } catch {
        return false;
      }
    }

    return false;
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

    // Check AgentDB health
    let agentdbAvailable = false;
    if (this.agentdb) {
      try {
        agentdbAvailable = typeof this.agentdb.getController === 'function';
      } catch {
        agentdbAvailable = false;
      }
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
      agentdbAvailable,
      initTimeMs: this.initTimeMs,
      timestamp: Date.now(),
      activeControllers: active,
      totalControllers: controllerHealth.length,
    };
  }

  /**
   * Get the underlying AgentDB instance.
   */
  getAgentDB(): any {
    return this.agentdb;
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
   * Initialize AgentDB instance with dynamic import and fallback chain.
   */
  private async initAgentDB(config: RuntimeConfig): Promise<void> {
    try {
      // Validate dbPath to prevent path traversal
      const dbPath = config.dbPath || ':memory:';
      if (dbPath !== ':memory:') {
        const resolved = path.resolve(dbPath);
        if (resolved.includes('..')) {
          this.emit('agentdb:unavailable', { reason: 'Invalid dbPath' });
          return;
        }
      }

      const agentdbModule: any = await import('agentdb');
      const AgentDBClass = agentdbModule.AgentDB || agentdbModule.default;

      if (!AgentDBClass) {
        this.emit('agentdb:unavailable', { reason: 'No AgentDB class found' });
        return;
      }

      this.agentdb = new AgentDBClass({ dbPath });

      // Suppress agentdb's noisy info-level output during init
      // using stderr redirect instead of monkey-patching console.log
      const origLog = console.log;
      const suppressFilter = (args: unknown[]) => {
        const msg = String(args[0] ?? '');
        return msg.includes('Transformers.js') ||
               
               msg.includes('[AgentDB]');
      };
      console.log = (...args: unknown[]) => {
        if (!suppressFilter(args)) origLog.apply(console, args);
      };
      try {
        await this.agentdb.initialize();
      } finally {
        console.log = origLog;
      }
      this.emit('agentdb:initialized');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.emit('agentdb:unavailable', { reason: msg.substring(0, 200) });
      this.agentdb = null;
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
      case 'reasoningBank':
      case 'learningBridge':
      case 'tieredCache':
      case 'hierarchicalMemory':
        return true;

      // Graph — enabled if backend available
      case 'memoryGraph':
        return !!(this.config.memory?.memoryGraph || this.backend);

      // Security — enabled if AgentDB available
      case 'mutationGuard':
      case 'attestationLog':
        return this.agentdb !== null;

      // AgentDB-internal controllers — only if AgentDB available
      case 'skills':
      case 'reflexion':
      case 'causalGraph':
      case 'learningSystem':
      case 'nightlyLearner':
      case 'memoryConsolidation':
      case 'batchOperations':
        return this.agentdb !== null;

      // ContextSynthesizer — moflo-owned, pure static class (no DB needed).
      case 'contextSynthesizer':
        return true;

      // SemanticRouter — moflo-owned, no DB needed.
      case 'semanticRouter':
        return true;

      // Optional controllers
      case 'hybridSearch':
      case 'agentMemoryScope':
        return false; // Require explicit enabling

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
   * Factory method to create a controller instance.
   * Handles CLI-layer controllers; AgentDB-internal controllers are
   * accessed via agentdb.getController().
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
        // Prefer moflo-owned impl (epic #464 Phase C2); no agentdb needed.
        try {
          const { SemanticRouter } = await import('./controllers/semantic-router.js');
          const router = new SemanticRouter();
          await router.initialize();
          return router;
        } catch {
          // Fall through to agentdb's SemanticRouter if our impl fails to load.
        }
        try {
          const agentdbModule: any = await import('agentdb');
          const SR = agentdbModule.SemanticRouter;
          if (!SR) return null;
          const router = new SR();
          await router.initialize();
          return router;
        } catch { return null; }
      }

      case 'hierarchicalMemory': {
        // Prefer moflo-owned impl (epic #464 Phase C3). Needs the sql.js
        // handle agentdb initializes for us; falls back to the in-memory
        // stub if that's unavailable.
        if (!this.agentdb?.database) return this.createTieredMemoryStub();
        try {
          const { HierarchicalMemory } = await import('./controllers/hierarchical-memory.js');
          const embedder = this.config.embeddingGenerator;
          const hm = new HierarchicalMemory(this.agentdb.database, { embedder });
          await hm.initializeDatabase();
          return hm;
        } catch {
          // Fall through to agentdb.
        }
        try {
          const agentdbModule: any = await import('agentdb');
          const HM = agentdbModule.HierarchicalMemory;
          if (!HM) return this.createTieredMemoryStub();
          const embedder = this.createEmbeddingService();
          const hm = new HM(this.agentdb.database, embedder);
          await hm.initializeDatabase();
          return hm;
        } catch {
          return this.createTieredMemoryStub();
        }
      }

      case 'memoryConsolidation': {
        // Prefer moflo-owned impl (epic #464 Phase C3). Composes over the
        // HierarchicalMemory instantiated at level 1.
        const hm: any = this.get('hierarchicalMemory');
        const isMofloHm =
          hm && typeof hm.listTier === 'function' && typeof hm.promote === 'function';
        if (isMofloHm) {
          try {
            const { MemoryConsolidation } = await import('./controllers/memory-consolidation.js');
            return new MemoryConsolidation(hm);
          } catch {
            // Fall through to agentdb.
          }
        }
        if (!this.agentdb) return this.createConsolidationStub();
        try {
          const agentdbModule: any = await import('agentdb');
          const MC = agentdbModule.MemoryConsolidation;
          if (!MC) return this.createConsolidationStub();
          if (!hm || typeof hm.recall !== 'function' || typeof hm.store !== 'function') {
            return this.createConsolidationStub();
          }
          const embedder = this.createEmbeddingService();
          const mc = new MC(this.agentdb.database, hm, embedder);
          await mc.initializeDatabase();
          return mc;
        } catch {
          return this.createConsolidationStub();
        }
      }

      // ----- AgentDB-internal controllers (via getController) -----
      // AgentDB.getController() only supports: reflexion/memory, skills, causalGraph/causal
      case 'reasoningBank': {
        // ReasoningBank is exported directly, not via getController
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const RB = agentdbModule.ReasoningBank;
          if (!RB) return null;
          return new RB(this.agentdb.database);
        } catch { return null; }
      }

      case 'skills': {
        // Prefer moflo-owned impl (epic #464 Phase C3).
        if (this.agentdb?.database) {
          try {
            const { Skills } = await import('./controllers/skills.js');
            const skills = new Skills(this.agentdb.database, {
              embedder: this.config.embeddingGenerator,
            });
            await skills.initializeDatabase();
            return skills;
          } catch {
            // Fall through to agentdb.
          }
        }
        if (!this.agentdb || typeof this.agentdb.getController !== 'function') return null;
        try {
          return this.agentdb.getController('skills') ?? null;
        } catch { return null; }
      }

      case 'reflexion': {
        // Prefer moflo-owned impl (epic #464 Phase C3).
        if (this.agentdb?.database) {
          try {
            const { Reflexion } = await import('./controllers/reflexion.js');
            const reflexion = new Reflexion(this.agentdb.database, {
              embedder: this.config.embeddingGenerator,
            });
            await reflexion.initializeDatabase();
            return reflexion;
          } catch {
            // Fall through to agentdb.
          }
        }
        if (!this.agentdb || typeof this.agentdb.getController !== 'function') return null;
        try {
          return this.agentdb.getController('reflexion') ?? null;
        } catch { return null; }
      }

      case 'causalGraph': {
        if (!this.agentdb || typeof this.agentdb.getController !== 'function') return null;
        try {
          return this.agentdb.getController(name) ?? null;
        } catch { return null; }
      }

      case 'learningSystem': {
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const LS = agentdbModule.LearningSystem;
          if (!LS) return null;
          return new LS(this.agentdb.database);
        } catch { return null; }
      }

      case 'nightlyLearner': {
        // Prefer moflo-owned impl (epic #464 Phase C3). Pulls together
        // MemoryConsolidation / Reflexion / Skills already in the registry.
        try {
          const { NightlyLearner } = await import('./controllers/nightly-learner.js');
          const { hasMethod } = await import('./controllers/_shared.js');
          const mc: any = this.get('memoryConsolidation');
          const refl: any = this.get('reflexion');
          const sk: any = this.get('skills');
          const mofloMc = hasMethod(mc, 'getOptions') ? mc : undefined;
          const mofloRefl = hasMethod(refl, 'episodeCount') ? refl : undefined;
          const mofloSk = hasMethod(sk, 'list') ? sk : undefined;
          if (mofloMc || mofloRefl || mofloSk) {
            return new NightlyLearner({
              memoryConsolidation: mofloMc,
              reflexion: mofloRefl,
              skills: mofloSk,
            });
          }
        } catch {
          // Fall through to agentdb.
        }
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const NL = agentdbModule.NightlyLearner;
          if (!NL) return null;
          return new NL(this.agentdb.database);
        } catch { return null; }
      }

      // ----- Direct-instantiation controllers -----
      case 'batchOperations': {
        if (!this.agentdb?.database) return null;
        // Prefer moflo-owned impl (epic #464 Phase C2).
        try {
          const { BatchOperations } = await import('./controllers/batch-operations.js');
          return new BatchOperations(this.agentdb.database, this.config.embeddingGenerator);
        } catch {
          // Fall through to agentdb.
        }
        try {
          const agentdbModule: any = await import('agentdb');
          const BO = agentdbModule.BatchOperations;
          if (!BO) return null;
          const embedder = this.config.embeddingGenerator || null;
          return new BO(this.agentdb.database, embedder);
        } catch { return null; }
      }

      case 'contextSynthesizer': {
        // ContextSynthesizer.synthesize is static — return the class itself.
        // Prefer moflo-owned impl (epic #464 Phase C2).
        try {
          const { ContextSynthesizer } = await import('./controllers/context-synthesizer.js');
          return ContextSynthesizer;
        } catch {
          // Fall through to agentdb.
        }
        try {
          const agentdbModule: any = await import('agentdb');
          return agentdbModule.ContextSynthesizer ?? null;
        } catch { return null; }
      }

      case 'mutationGuard': {
        // MutationGuard exported from agentdb 3.0.0-alpha.10 (ADR-060)
        // Constructor: (config?) where config.dimension, config.maxElements, config.enableWasmProofs
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const MG = agentdbModule.MutationGuard;
          if (!MG) return null;
          return new MG({ dimension: this.config.dimension || 384 });
        } catch { return null; }
      }

      case 'attestationLog': {
        // AttestationLog: append-only audit log.
        // Prefer moflo-owned impl (epic #464 Phase C2).
        if (!this.agentdb?.database) return null;
        try {
          const { AttestationLog } = await import('./controllers/attestation-log.js');
          return new AttestationLog(this.agentdb.database);
        } catch {
          // Fall through to agentdb.
        }
        try {
          const agentdbModule: any = await import('agentdb');
          const AL = agentdbModule.AttestationLog;
          if (!AL) return null;
          return new AL(this.agentdb.database);
        } catch { return null; }
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
   * Create an EmbeddingService for controllers that need it.
   * Uses the config's embedding generator or creates a minimal local service.
   */
  private createEmbeddingService(): any {
    // If user provided an embedding generator, wrap it
    if (this.config.embeddingGenerator) {
      return {
        embed: async (text: string) => this.config.embeddingGenerator!(text),
        embedBatch: async (texts: string[]) => Promise.all(texts.map(t => this.config.embeddingGenerator!(t))),
        initialize: async () => {},
      };
    }
    // Return a minimal stub — HierarchicalMemory falls back to manualSearch without embeddings
    return {
      embed: async () => new Float32Array(this.config.dimension || 384),
      embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(this.config.dimension || 384)),
      initialize: async () => {},
    };
  }

  /**
   * Lightweight in-memory tiered store (fallback when HierarchicalMemory
   * cannot be initialized from agentdb).
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
   * cannot be initialized from agentdb).
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
