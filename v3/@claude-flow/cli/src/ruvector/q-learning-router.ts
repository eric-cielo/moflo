/**
 * Q-Learning Router for Task Routing
 *
 * Uses reinforcement learning to optimize task routing decisions
 * based on historical performance and context.
 *
 * @module q-learning-router
 */

/**
 * Q-Learning Router Configuration
 */
export interface QLearningRouterConfig {
  /** Learning rate (default: 0.1) */
  learningRate: number;
  /** Discount factor (default: 0.99) */
  gamma: number;
  /** Initial exploration rate (default: 1.0) */
  explorationInitial: number;
  /** Final exploration rate (default: 0.01) */
  explorationFinal: number;
  /** Exploration decay steps (default: 10000) */
  explorationDecay: number;
  /** Maximum states in Q-table (default: 10000) */
  maxStates: number;
  /** Number of actions/routes (default: 8) */
  numActions: number;
}

/**
 * Route decision result
 */
export interface RouteDecision {
  /** Selected route/action */
  route: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Q-values for all routes */
  qValues: number[];
  /** Was exploration used */
  explored: boolean;
  /** Route alternatives */
  alternatives: Array<{ route: string; score: number }>;
}

/**
 * Q-table entry
 */
interface QEntry {
  qValues: Float32Array;
  visits: number;
  lastUpdate: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: QLearningRouterConfig = {
  learningRate: 0.1,
  gamma: 0.99,
  explorationInitial: 1.0,
  explorationFinal: 0.01,
  explorationDecay: 10000,
  maxStates: 10000,
  numActions: 8,
};

/**
 * Route names mapping
 */
const ROUTE_NAMES = [
  'coder',
  'tester',
  'reviewer',
  'architect',
  'researcher',
  'optimizer',
  'debugger',
  'documenter',
];

/**
 * Q-Learning Router for intelligent task routing
 */
export class QLearningRouter {
  private config: QLearningRouterConfig;
  private qTable: Map<string, QEntry> = new Map();
  private epsilon: number;
  private stepCount = 0;
  private updateCount = 0;
  private avgTDError = 0;
  private ruvectorEngine: unknown = null;
  private useNative = false;

  constructor(config: Partial<QLearningRouterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.epsilon = this.config.explorationInitial;
  }

  /**
   * Initialize the router, attempting to load ruvector native module
   */
  async initialize(): Promise<void> {
    try {
      const ruvector = await import('@ruvector/core');
      this.ruvectorEngine = (ruvector as any).createQLearning?.(this.config);
      this.useNative = !!this.ruvectorEngine;
    } catch {
      // Fallback to JS implementation
      this.useNative = false;
    }
  }

  /**
   * Route a task based on its context
   */
  route(taskContext: string, explore: boolean = true): RouteDecision {
    const stateKey = this.hashState(taskContext);

    // Check if we should explore
    const shouldExplore = explore && Math.random() < this.epsilon;

    let actionIdx: number;
    let qValues: number[];

    if (shouldExplore) {
      // Random exploration
      actionIdx = Math.floor(Math.random() * this.config.numActions);
      qValues = this.getQValues(stateKey);
    } else {
      // Exploit - choose best action
      qValues = this.getQValues(stateKey);
      actionIdx = this.argmax(qValues);
    }

    // Calculate confidence from softmax of Q-values
    const confidence = this.softmaxConfidence(qValues, actionIdx);

    // Get alternatives sorted by Q-value
    const alternatives = ROUTE_NAMES
      .map((route, idx) => ({ route, score: qValues[idx] }))
      .sort((a, b) => b.score - a.score)
      .slice(1, 4); // Top 3 alternatives

    return {
      route: ROUTE_NAMES[actionIdx] || 'coder',
      confidence,
      qValues,
      explored: shouldExplore,
      alternatives,
    };
  }

  /**
   * Update Q-values based on feedback
   */
  update(taskContext: string, action: string, reward: number, nextContext?: string): number {
    const stateKey = this.hashState(taskContext);
    const actionIdx = ROUTE_NAMES.indexOf(action);

    if (actionIdx === -1) {
      return 0;
    }

    const entry = this.getOrCreateEntry(stateKey);
    const currentQ = entry.qValues[actionIdx];

    // Calculate target Q-value
    let targetQ: number;
    if (nextContext) {
      const nextStateKey = this.hashState(nextContext);
      const nextQValues = this.getQValues(nextStateKey);
      const maxNextQ = Math.max(...nextQValues);
      targetQ = reward + this.config.gamma * maxNextQ;
    } else {
      // Terminal state
      targetQ = reward;
    }

    // TD error
    const tdError = targetQ - currentQ;

    // Update Q-value
    entry.qValues[actionIdx] += this.config.learningRate * tdError;
    entry.visits++;
    entry.lastUpdate = Date.now();

    // Decay exploration
    this.stepCount++;
    this.epsilon = Math.max(
      this.config.explorationFinal,
      this.config.explorationInitial - this.stepCount / this.config.explorationDecay
    );

    // Prune Q-table if needed
    if (this.qTable.size > this.config.maxStates) {
      this.pruneQTable();
    }

    this.updateCount++;
    this.avgTDError = (this.avgTDError * (this.updateCount - 1) + Math.abs(tdError)) / this.updateCount;

    return tdError;
  }

  /**
   * Get statistics
   */
  getStats(): Record<string, number> {
    return {
      updateCount: this.updateCount,
      qTableSize: this.qTable.size,
      epsilon: this.epsilon,
      avgTDError: this.avgTDError,
      stepCount: this.stepCount,
      useNative: this.useNative ? 1 : 0,
    };
  }

  /**
   * Reset the router
   */
  reset(): void {
    this.qTable.clear();
    this.epsilon = this.config.explorationInitial;
    this.stepCount = 0;
    this.updateCount = 0;
    this.avgTDError = 0;
  }

  /**
   * Export Q-table for persistence
   */
  export(): Record<string, { qValues: number[]; visits: number }> {
    const result: Record<string, { qValues: number[]; visits: number }> = {};
    for (const [key, entry] of this.qTable) {
      result[key] = {
        qValues: Array.from(entry.qValues),
        visits: entry.visits,
      };
    }
    return result;
  }

  /**
   * Import Q-table from persistence
   */
  import(data: Record<string, { qValues: number[]; visits: number }>): void {
    this.qTable.clear();
    for (const [key, entry] of Object.entries(data)) {
      this.qTable.set(key, {
        qValues: new Float32Array(entry.qValues),
        visits: entry.visits,
        lastUpdate: Date.now(),
      });
    }
  }

  // Private methods

  private hashState(context: string): string {
    // Simple hash for context string
    let hash = 0;
    for (let i = 0; i < context.length; i++) {
      const char = context.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return `state_${hash}`;
  }

  private getQValues(stateKey: string): number[] {
    const entry = this.qTable.get(stateKey);
    if (!entry) {
      return new Array(this.config.numActions).fill(0);
    }
    return Array.from(entry.qValues);
  }

  private getOrCreateEntry(stateKey: string): QEntry {
    let entry = this.qTable.get(stateKey);
    if (!entry) {
      entry = {
        qValues: new Float32Array(this.config.numActions),
        visits: 0,
        lastUpdate: Date.now(),
      };
      this.qTable.set(stateKey, entry);
    }
    return entry;
  }

  private argmax(values: number[]): number {
    let maxIdx = 0;
    let maxVal = values[0];
    for (let i = 1; i < values.length; i++) {
      if (values[i] > maxVal) {
        maxVal = values[i];
        maxIdx = i;
      }
    }
    return maxIdx;
  }

  private softmaxConfidence(qValues: number[], actionIdx: number): number {
    const maxQ = Math.max(...qValues);
    const expValues = qValues.map(q => Math.exp(q - maxQ)); // Subtract max for numerical stability
    const sumExp = expValues.reduce((a, b) => a + b, 0);
    return expValues[actionIdx] / sumExp;
  }

  private pruneQTable(): void {
    const entries = Array.from(this.qTable.entries())
      .sort((a, b) => a[1].lastUpdate - b[1].lastUpdate);

    const toRemove = entries.length - Math.floor(this.config.maxStates * 0.8);
    for (let i = 0; i < toRemove; i++) {
      this.qTable.delete(entries[i][0]);
    }
  }
}

/**
 * Factory function
 */
export function createQLearningRouter(config?: Partial<QLearningRouterConfig>): QLearningRouter {
  return new QLearningRouter(config);
}
