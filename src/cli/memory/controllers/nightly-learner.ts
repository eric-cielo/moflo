/**
 * NightlyLearner — moflo-owned batch offline learning (epic #464 Phase C3).
 *
 * Replaces `agentdb.NightlyLearner`. Coordinates a periodic cycle that
 * stitches together the other moflo controllers:
 *   1. Runs MemoryConsolidation (working → episodic → semantic).
 *   2. Reports current reflexion / skill inventory for observability.
 *   3. Optionally re-fires on an interval (`start(intervalMs)`).
 *
 * Consumer surface (from src/cli/memory/memory-bridge.ts):
 *   consolidate({ sessionId? })  → NightlyReport
 *
 * The bridge calls `consolidate` at session end; additional cron
 * scheduling is optional and off by default so this stays lightweight.
 */

import type { MemoryConsolidation, ConsolidationReport } from './memory-consolidation.js';
import type { Reflexion } from './reflexion.js';
import type { Skills } from './skills.js';
import type { ControllerSpec } from '../controller-spec.js';
import { hasMethod } from './_shared.js';

export interface NightlyReport {
  consolidation?: ConsolidationReport;
  reflexionsIndexed: number;
  skillsIndexed: number;
  sessionId: string | null;
  timestamp: number;
}

export interface NightlyLearnerOptions {
  memoryConsolidation?: MemoryConsolidation;
  reflexion?: Reflexion;
  skills?: Skills;
}

export class NightlyLearner {
  private consolidation?: MemoryConsolidation;
  private reflexion?: Reflexion;
  private skills?: Skills;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: NightlyLearnerOptions = {}) {
    this.consolidation = options.memoryConsolidation;
    this.reflexion = options.reflexion;
    this.skills = options.skills;
  }

  async initializeDatabase(): Promise<void> {
    // No schema of its own — every sub-controller owns its tables.
  }

  /**
   * One pass through all wired-in controllers. Accepts an optional
   * `{ sessionId }` tag so observers can correlate reports with the
   * session that triggered them.
   */
  async consolidate(options: { sessionId?: string } = {}): Promise<NightlyReport> {
    const report: NightlyReport = {
      reflexionsIndexed: 0,
      skillsIndexed: 0,
      sessionId: options.sessionId ?? null,
      timestamp: Date.now(),
    };

    if (this.consolidation) {
      try {
        report.consolidation = await this.consolidation.consolidate();
      } catch (err) {
        // Consolidation is best-effort; surface via report, don't throw.
        report.consolidation = {
          episodicProcessed: 0,
          semanticCreated: 0,
          memoriesForgotten: 0,
          workingPromoted: 0,
          timestamp: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (this.reflexion) {
      try {
        report.reflexionsIndexed = this.reflexion.count();
      } catch {
        // Ignore — inventory is informational.
      }
    }
    if (this.skills) {
      try {
        report.skillsIndexed = this.skills.count();
      } catch {
        // Ignore — inventory is informational.
      }
    }

    return report;
  }

  /** Alias so callers reading the code can grep either name. */
  async runCycle(options: { sessionId?: string } = {}): Promise<NightlyReport> {
    return this.consolidate(options);
  }

  /**
   * Start a recurring consolidate() loop. Calling twice without stop()
   * first is a no-op (prevents leaking intervals).
   */
  start(intervalMs: number): void {
    if (this.timer) return;
    if (typeof intervalMs !== 'number' || intervalMs < 1000) {
      throw new Error('start() requires intervalMs >= 1000');
    }
    const self = this;
    this.timer = setInterval(() => {
      // Fire-and-forget; consolidate swallows its own errors.
      void self.consolidate({ sessionId: `cron-${Date.now()}` });
    }, intervalMs);
    if (typeof (this.timer as NodeJS.Timeout & { unref?: () => void }).unref === 'function') {
      (this.timer as NodeJS.Timeout & { unref?: () => void }).unref!();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Test hook — running state of the cron timer. */
  isRunning(): boolean {
    return this.timer !== null;
  }
}

export const nightlyLearnerSpec: ControllerSpec = {
  name: 'nightlyLearner',
  level: 4,
  enabledByDefault: true,
  create: ({ registry }) => {
    const mc = registry.get<MemoryConsolidation>('memoryConsolidation');
    const refl = registry.get<Reflexion>('reflexion');
    const sk = registry.get<Skills>('skills');
    const memoryConsolidation = hasMethod(mc, 'getOptions') ? mc ?? undefined : undefined;
    const reflexion = hasMethod(refl, 'episodeCount') ? refl ?? undefined : undefined;
    const skills = hasMethod(sk, 'list') ? sk ?? undefined : undefined;
    if (!memoryConsolidation && !reflexion && !skills) return null;
    return new NightlyLearner({ memoryConsolidation, reflexion, skills });
  },
};

export default NightlyLearner;
