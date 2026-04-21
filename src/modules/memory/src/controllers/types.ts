/**
 * Shared types for moflo-owned memory controllers (epic #464 Phase C2).
 *
 * These controllers replace agentdb-provided ones, backed by sql.js.
 * All controllers accept a minimal Database interface so they can bind to
 * either agentdb's sql.js handle (pre-C6) or moflo's own (post-C6).
 */

/**
 * Structural subset of sql.js `Database` used by moflo controllers.
 * Declared here (rather than `import type { Database } from 'sql.js'`) so
 * callers can pass any compatible handle without pulling the dep into
 * controllers that don't need it.
 */
export interface SqlJsDatabaseLike {
  run(sql: string, params?: any): unknown;
  exec(sql: string): Array<{ columns: string[]; values: any[][] }>;
  prepare(sql: string): SqlJsStatement;
  /** Rows touched by the last successful INSERT/UPDATE/DELETE. */
  getRowsModified?(): number;
}

export interface SqlJsStatement {
  run?(params?: any): unknown;
  step(): boolean;
  getAsObject(params?: any): Record<string, any>;
  get(params?: any): any[];
  bind?(params: any): boolean;
  reset?(): void;
  free(): void;
}

/**
 * Memory pattern shape consumed by ContextSynthesizer — matches the object
 * memory-bridge.ts synthesizes from hierarchicalMemory.recall() output.
 */
export interface MemoryPattern {
  content: string;
  key: string;
  reward?: number;
  verdict?: 'success' | 'failure' | 'neutral' | string;
  [key: string]: unknown;
}

/**
 * Episode shape consumed by BatchOperations.insertEpisodes().
 */
export interface EpisodeInput {
  content: string;
  metadata?: Record<string, unknown>;
  embedding?: Float32Array | number[];
}
