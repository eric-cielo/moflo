/**
 * ControllerRegistry — generic lifecycle manager for memory controllers.
 *
 * Iterates the declarative {@link CONTROLLER_SPECS} list (see
 * ./controller-specs.ts) in level order. Each spec owns its own
 * instantiation + enablement logic, so adding a new controller never
 * requires editing this file.
 *
 * Per ADR-053.
 *
 * @module moflo/cli/memory/controller-registry
 */

import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import type { IMemoryBackend } from './types.js';
import { openSqlJsDatabase } from './sqljs-backend.js';
import { CONTROLLER_SPECS } from './controller-specs.js';
import type {
  ControllerName,
  ControllerSpec,
  EnablementContext,
  RegistryView,
  RuntimeConfig,
  SqlJsHandle,
} from './controller-spec.js';

// Re-export public types so consumers can import them from
// memory/controller-registry (pre-spec-pattern surface).
export type {
  ControllerName,
  CLIControllerName,
  MofloDbControllerName,
  RuntimeConfig,
} from './controller-spec.js';

// ===== Types =====

export interface InitLevel {
  level: number;
  controllers: ControllerName[];
}

export interface ControllerHealth {
  name: ControllerName;
  status: 'healthy' | 'degraded' | 'unavailable';
  initTimeMs: number;
  error?: string;
}

export interface RegistryHealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  controllers: ControllerHealth[];
  mofloDbAvailable: boolean;
  initTimeMs: number;
  timestamp: number;
  activeControllers: number;
  totalControllers: number;
}

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
 * Specs grouped by level, sorted ascending. Built once at module load so
 * {@link ControllerRegistry.initialize} doesn't re-scan the full spec list
 * per level. Level 0 stays as an empty foundation slot per ADR-053.
 */
const SPECS_BY_LEVEL: ReadonlyArray<{ level: number; specs: readonly ControllerSpec[] }> =
  (() => {
    const byLevel = new Map<number, ControllerSpec[]>([[0, []]]);
    for (const spec of CONTROLLER_SPECS) {
      const bucket = byLevel.get(spec.level) ?? [];
      bucket.push(spec);
      byLevel.set(spec.level, bucket);
    }
    return [...byLevel.entries()]
      .sort(([a], [b]) => a - b)
      .map(([level, specs]) => ({ level, specs }));
  })();

/**
 * Public view of the init order — controller names per level. Derived from
 * {@link CONTROLLER_SPECS} so adding a controller never requires touching
 * this file.
 */
export const INIT_LEVELS: InitLevel[] = SPECS_BY_LEVEL.map(({ level, specs }) => ({
  level,
  controllers: specs.map((s) => s.name),
}));

// ===== ControllerRegistry =====

/**
 * Central registry for moflo memory controller lifecycle management.
 *
 * - Level-based initialization ordering (lowest level first, in parallel per level)
 * - Graceful degradation (each controller fails independently)
 * - Config-driven activation via {@link RuntimeConfig.controllers}
 * - Health check aggregation
 * - Reverse-order shutdown
 *
 * @example
 * ```typescript
 * const registry = new ControllerRegistry();
 * await registry.initialize({ dbPath: './data/memory.db' });
 * const bridge = registry.get<LearningBridge>('learningBridge');
 * await registry.shutdown();
 * ```
 */
export class ControllerRegistry extends EventEmitter implements RegistryView {
  private controllers: Map<ControllerName, ControllerEntry> = new Map();
  private mofloDb: SqlJsHandle | null = null;
  private backend: IMemoryBackend | null = null;
  private config: RuntimeConfig = {};
  private initialized = false;
  private initTimeMs = 0;

  async initialize(config: RuntimeConfig = {}): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.config = config;
    const startTime = performance.now();

    await this.initSqlJs(config);
    this.backend = config.backend || null;
    const ctx: EnablementContext = {
      config: this.config,
      mofloDb: this.mofloDb,
      backend: this.backend,
    };

    for (const { specs: levelSpecs } of SPECS_BY_LEVEL) {
      const specs = levelSpecs.filter((s) => this.shouldInit(s, ctx));
      if (specs.length === 0) continue;

      const results = await Promise.allSettled(
        specs.map((spec) => this.initController(spec)),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const spec = specs[i];
        if (result.status === 'rejected') {
          const errorMsg = result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
          this.controllers.set(spec.name, {
            name: spec.name,
            instance: null,
            level: spec.level,
            initTimeMs: 0,
            enabled: false,
            error: errorMsg,
          });
          this.emit('controller:failed', {
            name: spec.name,
            error: errorMsg,
            level: spec.level,
          });
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

  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    for (const level of [...INIT_LEVELS].reverse()) {
      const toShutdown = level.controllers.filter((name) => {
        const entry = this.controllers.get(name);
        return entry?.enabled && entry?.instance;
      });
      await Promise.allSettled(toShutdown.map((name) => this.shutdownController(name)));
    }

    if (this.mofloDb) {
      try {
        await this.mofloDb.close();
      } catch {
        // Best-effort cleanup.
      }
      this.mofloDb = null;
    }

    this.controllers.clear();
    this.initialized = false;
    this.emit('shutdown');
  }

  get<T>(name: ControllerName): T | null {
    const entry = this.controllers.get(name);
    if (entry?.enabled && entry?.instance) {
      return entry.instance as T;
    }
    return null;
  }

  isEnabled(name: ControllerName): boolean {
    return Boolean(this.controllers.get(name)?.enabled);
  }

  async healthCheck(): Promise<RegistryHealthReport> {
    const controllers: ControllerHealth[] = [];
    for (const [name, entry] of this.controllers) {
      controllers.push({
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
    const active = controllers.filter((c) => c.status === 'healthy').length;
    const unavailable = controllers.filter((c) => c.status === 'unavailable').length;

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (unavailable > 0 && active === 0) status = 'unhealthy';
    else if (unavailable > 0) status = 'degraded';

    return {
      status,
      controllers,
      mofloDbAvailable: this.mofloDb !== null,
      initTimeMs: this.initTimeMs,
      timestamp: Date.now(),
      activeControllers: active,
      totalControllers: controllers.length,
    };
  }

  getMofloDb(): SqlJsHandle | null {
    return this.mofloDb;
  }

  getBackend(): IMemoryBackend | null {
    return this.backend;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getActiveCount(): number {
    let count = 0;
    for (const entry of this.controllers.values()) {
      if (entry.enabled) count++;
    }
    return count;
  }

  listControllers(): Array<{ name: ControllerName; enabled: boolean; level: number }> {
    return Array.from(this.controllers.entries()).map(([name, entry]) => ({
      name,
      enabled: entry.enabled,
      level: entry.level,
    }));
  }

  // ===== Private =====

  private async initSqlJs(config: RuntimeConfig): Promise<void> {
    try {
      const dbPath = config.dbPath || ':memory:';
      if (dbPath !== ':memory:') {
        const resolved = path.resolve(dbPath);
        if (resolved.includes('..')) {
          this.emit('mofloDb:unavailable', { reason: 'Invalid dbPath' });
          return;
        }
      }
      const database = await openSqlJsDatabase(dbPath, config.wasmPath);
      this.mofloDb = { database, close: async () => database.close() };
      this.emit('mofloDb:initialized');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.emit('mofloDb:unavailable', { reason: msg.substring(0, 200) });
      this.mofloDb = null;
    }
  }

  /**
   * Decide whether a spec should be initialized. Returns false if:
   *  - explicitly disabled via config.controllers[name] = false
   *  - enabledByDefault is false and not explicitly enabled
   *  - any `requires` resource is unavailable
   */
  private shouldInit(spec: ControllerSpec, ctx: EnablementContext): boolean {
    const explicit = this.config.controllers?.[spec.name];
    if (explicit === false) return false;

    if (explicit !== true) {
      const defaultOn = typeof spec.enabledByDefault === 'function'
        ? spec.enabledByDefault(ctx)
        : spec.enabledByDefault;
      if (!defaultOn) return false;
    }

    for (const r of spec.requires ?? []) {
      if (r === 'sqljs' && !this.mofloDb) return false;
      if (r === 'backend' && !this.backend) return false;
    }
    return true;
  }

  private async initController(spec: ControllerSpec): Promise<void> {
    const startTime = performance.now();
    try {
      const instance = await spec.create({
        config: this.config,
        mofloDb: this.mofloDb,
        backend: this.backend,
        embedder: this.config.embeddingGenerator,
        registry: this,
      });
      const initTimeMs = performance.now() - startTime;
      this.controllers.set(spec.name, {
        name: spec.name,
        instance,
        level: spec.level,
        initTimeMs,
        enabled: instance !== null,
        error: instance === null ? 'Controller returned null' : undefined,
      });
      if (instance !== null) {
        this.emit('controller:initialized', {
          name: spec.name,
          level: spec.level,
          initTimeMs,
        });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const initTimeMs = performance.now() - startTime;
      this.controllers.set(spec.name, {
        name: spec.name,
        instance: null,
        level: spec.level,
        initTimeMs,
        enabled: false,
        error: errorMsg,
      });
      throw error;
    }
  }

  private async shutdownController(name: ControllerName): Promise<void> {
    const entry = this.controllers.get(name);
    if (!entry?.instance) return;

    try {
      const instance = entry.instance as {
        destroy?: () => unknown;
        shutdown?: () => unknown;
        close?: () => unknown;
      };
      if (typeof instance.destroy === 'function') {
        await instance.destroy();
      } else if (typeof instance.shutdown === 'function') {
        await instance.shutdown();
      } else if (typeof instance.close === 'function') {
        await instance.close();
      }
    } catch {
      // Best-effort cleanup.
    }

    entry.enabled = false;
    entry.instance = null;
  }
}

export default ControllerRegistry;
