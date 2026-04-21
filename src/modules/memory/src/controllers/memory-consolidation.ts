/**
 * MemoryConsolidation — moflo-owned short→long term promotion (epic #464 Phase C3).
 *
 * Replaces `agentdb.MemoryConsolidation`. Walks `HierarchicalMemory` and:
 *   1. Promotes `working` items older than `workingTtlMs` into `episodic`.
 *   2. Promotes `episodic` items with `accessCount >= episodicPromoteThreshold`
 *      into `semantic` (they've been recalled enough to earn long-term status).
 *   3. Forgets `working` items older than `forgetAfterMs` that never got
 *      promoted — prevents unbounded growth.
 *
 * Consumer surface (from src/modules/cli/src/memory/memory-bridge.ts):
 *   consolidate() → ConsolidationReport
 */

import type { HierarchicalMemory, MemoryItem, Tier } from './hierarchical-memory.js';
import type { ControllerSpec } from '../controller-spec.js';

export interface ConsolidationReport {
  episodicProcessed: number;
  semanticCreated: number;
  memoriesForgotten: number;
  workingPromoted: number;
  timestamp: number;
  /** Set when the enclosing NightlyLearner traps a thrown error. */
  error?: string;
}

export interface MemoryConsolidationOptions {
  /** How long a `working` item survives before being considered episodic. */
  workingTtlMs?: number;
  /** How long a `working` item can stay un-promoted before we forget it. */
  forgetAfterMs?: number;
  /** Minimum recall count before an episodic item becomes semantic. */
  episodicPromoteThreshold?: number;
  /** Hard cap on items processed per run — keeps consolidation bounded. */
  maxPerRun?: number;
}

const DEFAULTS: Required<MemoryConsolidationOptions> = {
  workingTtlMs: 60 * 60 * 1000,            // 1h
  forgetAfterMs: 7 * 24 * 60 * 60 * 1000,  // 7d
  episodicPromoteThreshold: 3,
  maxPerRun: 500,
};

export class MemoryConsolidation {
  private hm: HierarchicalMemory;
  private opts: Required<MemoryConsolidationOptions>;

  constructor(hm: HierarchicalMemory, options: MemoryConsolidationOptions = {}) {
    if (!hm) throw new Error('MemoryConsolidation requires a HierarchicalMemory');
    this.hm = hm;
    this.opts = { ...DEFAULTS, ...options };
  }

  async initializeDatabase(): Promise<void> {
    // HierarchicalMemory owns the schema; nothing else to do here.
  }

  async consolidate(): Promise<ConsolidationReport> {
    const now = Date.now();
    const report: ConsolidationReport = {
      episodicProcessed: 0,
      semanticCreated: 0,
      memoriesForgotten: 0,
      workingPromoted: 0,
      timestamp: now,
    };

    // Batch everything in one transaction so sql.js isn't paying per-row fsync.
    await this.hm.transaction(async () => {
      const working = this.hm.listTier('working', this.opts.maxPerRun);
      for (const item of working) {
        const age = now - item.timestamp;
        if (age < this.opts.workingTtlMs) continue;

        if (item.accessCount === 0 && age > this.opts.forgetAfterMs) {
          if (await this.hm.forget(item.id)) report.memoriesForgotten++;
          continue;
        }
        if (await this.hm.promote(item.id, 'working', 'episodic')) {
          report.workingPromoted++;
        }
      }

      const episodic = this.hm.listTier('episodic', this.opts.maxPerRun);
      for (const item of episodic) {
        report.episodicProcessed++;
        if (this.shouldPromoteToSemantic(item)) {
          if (await this.hm.promote(item.id, 'episodic', 'semantic')) {
            report.semanticCreated++;
          }
        }
      }
    });

    return report;
  }

  private shouldPromoteToSemantic(item: MemoryItem): boolean {
    if (item.accessCount >= this.opts.episodicPromoteThreshold) return true;
    // High-importance items get a faster lane — one recall is enough.
    if (item.importance >= 0.9 && item.accessCount >= 1) return true;
    return false;
  }

  /** Exposed for tests. */
  getOptions(): Required<MemoryConsolidationOptions> {
    return { ...this.opts };
  }
}

// Re-export types needed by controller-registry consumers.
export type { Tier, MemoryItem };

/**
 * No-op consolidation used when the real HierarchicalMemory isn't
 * available (in-memory stub only supports store/recall).
 */
function createConsolidationStub() {
  return {
    consolidate() {
      return { promoted: 0, pruned: 0, timestamp: Date.now() };
    },
  };
}

export const memoryConsolidationSpec: ControllerSpec = {
  name: 'memoryConsolidation',
  level: 3,
  enabledByDefault: true,
  create: ({ registry }) => {
    const hm = registry.get<HierarchicalMemory>('hierarchicalMemory');
    if (
      hm &&
      typeof (hm as any).listTier === 'function' &&
      typeof (hm as any).promote === 'function'
    ) {
      return new MemoryConsolidation(hm);
    }
    return createConsolidationStub();
  },
};

export default MemoryConsolidation;
