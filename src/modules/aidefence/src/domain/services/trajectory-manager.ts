/**
 * Trajectory Manager with Memory Management
 *
 * Performance improvements:
 * - Automatic cleanup of stale trajectories
 * - LRU eviction when memory limit reached
 * - Configurable max trajectories
 * - TTL-based expiration
 */

export interface LearningTrajectory {
  sessionId: string;
  task: string;
  steps: Array<{
    input: string;
    output: unknown;
    reward: number;
    timestamp: Date;
  }>;
  verdict: 'success' | 'failure' | 'partial';
  totalReward: number;
  createdAt: number;
  lastActivityAt: number;
}

export interface TrajectoryManagerConfig {
  maxTrajectories?: number; // Max concurrent trajectories
  trajectoryTTL?: number; // Time to live in ms (default: 30 minutes)
  cleanupInterval?: number; // How often to cleanup (default: 5 minutes)
  maxStepsPerTrajectory?: number; // Prevent memory bloat from huge trajectories
}

/**
 * Memory-safe trajectory manager with automatic cleanup
 */
export class TrajectoryManager {
  private trajectories = new Map<string, LearningTrajectory>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private config: Required<TrajectoryManagerConfig>;

  // Track access order for LRU eviction
  private accessOrder: string[] = [];

  constructor(config: TrajectoryManagerConfig = {}) {
    this.config = {
      maxTrajectories: config.maxTrajectories ?? 1000,
      trajectoryTTL: config.trajectoryTTL ?? 30 * 60 * 1000, // 30 minutes
      cleanupInterval: config.cleanupInterval ?? 5 * 60 * 1000, // 5 minutes
      maxStepsPerTrajectory: config.maxStepsPerTrajectory ?? 1000,
    };

    this.startCleanupTimer();
  }

  /**
   * Start a new trajectory with automatic memory management
   */
  startTrajectory(sessionId: string, task: string): void {
    const now = Date.now();

    // Evict if at capacity (LRU)
    if (this.trajectories.size >= this.config.maxTrajectories) {
      this.evictLRU();
    }

    const trajectory: LearningTrajectory = {
      sessionId,
      task,
      steps: [],
      verdict: 'partial',
      totalReward: 0,
      createdAt: now,
      lastActivityAt: now,
    };

    this.trajectories.set(sessionId, trajectory);
    this.updateAccessOrder(sessionId);
  }

  /**
   * Record a trajectory step with bounds checking
   */
  recordStep(
    sessionId: string,
    input: string,
    output: unknown,
    reward: number
  ): boolean {
    const trajectory = this.trajectories.get(sessionId);
    if (!trajectory) return false;

    // Prevent memory bloat from huge trajectories
    if (trajectory.steps.length >= this.config.maxStepsPerTrajectory) {
      console.warn(
        `Trajectory ${sessionId} reached max steps (${this.config.maxStepsPerTrajectory}). Dropping new steps.`
      );
      return false;
    }

    trajectory.steps.push({
      input,
      output,
      reward,
      timestamp: new Date(),
    });
    trajectory.totalReward += reward;
    trajectory.lastActivityAt = Date.now();

    this.updateAccessOrder(sessionId);
    return true;
  }

  /**
   * Get trajectory (updates access time)
   */
  getTrajectory(sessionId: string): LearningTrajectory | null {
    const trajectory = this.trajectories.get(sessionId);
    if (!trajectory) return null;

    // Check if expired
    if (this.isExpired(trajectory)) {
      this.trajectories.delete(sessionId);
      return null;
    }

    trajectory.lastActivityAt = Date.now();
    this.updateAccessOrder(sessionId);
    return trajectory;
  }

  /**
   * End trajectory and remove from memory
   */
  endTrajectory(
    sessionId: string,
    verdict: 'success' | 'failure' | 'partial'
  ): LearningTrajectory | null {
    const trajectory = this.trajectories.get(sessionId);
    if (!trajectory) return null;

    trajectory.verdict = verdict;
    this.trajectories.delete(sessionId);
    this.removeFromAccessOrder(sessionId);

    return trajectory;
  }

  /**
   * Get current memory usage stats
   */
  getStats(): {
    activeTrajectories: number;
    totalSteps: number;
    oldestTrajectory: number;
    memoryEstimateMB: number;
  } {
    let totalSteps = 0;
    let oldestCreated = Date.now();

    for (const trajectory of this.trajectories.values()) {
      totalSteps += trajectory.steps.length;
      if (trajectory.createdAt < oldestCreated) {
        oldestCreated = trajectory.createdAt;
      }
    }

    // Rough memory estimate (very conservative)
    const avgStepSize = 1024; // 1KB per step estimate
    const memoryBytes = totalSteps * avgStepSize;
    const memoryMB = memoryBytes / (1024 * 1024);

    return {
      activeTrajectories: this.trajectories.size,
      totalSteps,
      oldestTrajectory: Date.now() - oldestCreated,
      memoryEstimateMB: memoryMB,
    };
  }

  /**
   * Cleanup expired trajectories
   */
  cleanupExpired(): number {
    let cleaned = 0;

    for (const [sessionId, trajectory] of this.trajectories) {
      if (this.isExpired(trajectory)) {
        this.trajectories.delete(sessionId);
        this.removeFromAccessOrder(sessionId);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Shutdown and cleanup
   */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.trajectories.clear();
    this.accessOrder = [];
  }

  // ===== Private Methods =====

  private isExpired(trajectory: LearningTrajectory): boolean {
    return Date.now() - trajectory.lastActivityAt > this.config.trajectoryTTL;
  }

  private evictLRU(): void {
    if (this.accessOrder.length === 0) return;

    // Evict least recently used
    const lruSessionId = this.accessOrder[0];
    this.trajectories.delete(lruSessionId);
    this.removeFromAccessOrder(lruSessionId);

    console.debug(`Evicted LRU trajectory: ${lruSessionId}`);
  }

  private updateAccessOrder(sessionId: string): void {
    this.removeFromAccessOrder(sessionId);
    this.accessOrder.push(sessionId);
  }

  private removeFromAccessOrder(sessionId: string): void {
    const index = this.accessOrder.indexOf(sessionId);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      const cleaned = this.cleanupExpired();
      if (cleaned > 0) {
        console.debug(`Cleaned up ${cleaned} expired trajectories`);
      }
    }, this.config.cleanupInterval);
  }
}
