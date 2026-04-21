/**
 * LearningSystem — reward-tracking + algorithm recommender.
 *
 * Rolling-mean quality per (task-signature, algorithm) with a time-decayed
 * recency factor — deliberately simpler than agentdb's Q-learning. The
 * recommender has to be deterministic within a session for spell
 * reproducibility, which rules out anything stochastic.
 */

import { clamp01 } from './_shared.js';
import type { SqlJsDatabaseLike } from './types.js';

const FEEDBACK_TABLE = 'moflo_learning_feedback';
const ALGO_TABLE = 'moflo_learning_algorithms';

const DEFAULT_DECAY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ALGORITHMS = ['coder', 'researcher', 'tester', 'reviewer'];

export interface FeedbackInput {
  taskId: string;
  success: boolean;
  quality: number;
  agent?: string;
  algorithm?: string;
  duration?: number;
  timestamp?: number;
  taskSignature?: string;
  metadata?: Record<string, unknown>;
}

export interface AlgorithmStats {
  taskSignature: string;
  algorithm: string;
  samples: number;
  meanQuality: number;
  successes: number;
  failures: number;
  lastSeenAt: number;
}

export interface Recommendation {
  algorithm: string;
  confidence: number;
  agents: string[];
  samples: number;
}

export interface LearningSystemOptions {
  decayHalfLifeMs?: number;
  defaultAlgorithms?: string[];
}

export class LearningSystem {
  private db: SqlJsDatabaseLike;
  private decayHalfLifeMs: number;
  private defaults: string[];

  constructor(db: SqlJsDatabaseLike, options: LearningSystemOptions = {}) {
    if (!db) throw new Error('LearningSystem requires a sql.js Database');
    this.db = db;
    this.decayHalfLifeMs = options.decayHalfLifeMs ?? DEFAULT_DECAY_HALF_LIFE_MS;
    this.defaults = options.defaultAlgorithms ?? DEFAULT_ALGORITHMS;
    this.ensureSchema();
  }

  async initializeDatabase(): Promise<void> {
    this.ensureSchema();
  }

  async recordFeedback(input: FeedbackInput): Promise<void> {
    if (!input?.taskId) return;
    const quality = clamp01(input.quality);
    const success = input.success === true;
    const ts = typeof input.timestamp === 'number' ? input.timestamp : Date.now();
    const agent = typeof input.agent === 'string' ? input.agent : '';
    const algorithm = pickAlgorithm(input, agent);
    const taskSignature = pickSignature(input);
    const durationMs = typeof input.duration === 'number' ? Math.max(0, input.duration) : 0;
    const metaJson = JSON.stringify(input.metadata ?? {});

    this.db.run(
      `INSERT INTO ${FEEDBACK_TABLE}
         (task_id, task_signature, algorithm, agent, quality, success, duration_ms, ts, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.taskId, taskSignature, algorithm, agent, quality, success ? 1 : 0, durationMs, ts, metaJson],
    );
    this.upsertAlgorithmStats(taskSignature, algorithm, agent, quality, success, ts);
  }

  /** 3-arg fallback memory-bridge uses when `recordFeedback` is absent. */
  async record(taskId: string, quality: number, verdict: 'success' | 'failure' | string): Promise<void> {
    await this.recordFeedback({
      taskId,
      success: verdict === 'success',
      quality,
    });
  }

  async recommendAlgorithm(task: string): Promise<Recommendation> {
    const taskSignature = signatureFromTaskId(task);
    const rows = this.listAlgorithmStats(taskSignature);
    if (rows.length === 0) {
      const fallback = this.defaults[0] ?? 'coder';
      const agents = this.defaults.slice(0, 2);
      return {
        algorithm: fallback,
        confidence: 0.5,
        agents: agents.length > 0 ? agents : [fallback],
        samples: 0,
      };
    }
    const now = Date.now();
    const ranked = rows
      .map((r) => ({
        row: r,
        score: decayedScore(r.meanQuality, r.lastSeenAt, now, this.decayHalfLifeMs) * sampleBoost(r.samples),
      }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0].row;
    const totalSamples = rows.reduce((acc, r) => acc + r.samples, 0);
    return {
      algorithm: best.algorithm,
      confidence: clamp01(best.meanQuality),
      agents: [best.algorithm],
      samples: totalSamples,
    };
  }

  stats(taskSignature?: string): AlgorithmStats[] {
    return this.listAlgorithmStats(taskSignature ?? null);
  }

  count(): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) AS n FROM ${FEEDBACK_TABLE}`);
    try {
      stmt.step();
      return Number(stmt.getAsObject().n ?? 0);
    } finally {
      stmt.free();
    }
  }

  private upsertAlgorithmStats(
    taskSignature: string,
    algorithm: string,
    agent: string,
    quality: number,
    success: boolean,
    ts: number,
  ): void {
    const successDelta = success ? 1 : 0;
    const failureDelta = success ? 0 : 1;
    this.db.run(
      `INSERT INTO ${ALGO_TABLE}
         (task_signature, algorithm, samples, sum_quality, successes, failures, last_seen_at, agent)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(task_signature, algorithm) DO UPDATE SET
         samples = samples + 1,
         sum_quality = sum_quality + excluded.sum_quality,
         successes = successes + excluded.successes,
         failures = failures + excluded.failures,
         last_seen_at = excluded.last_seen_at,
         agent = excluded.agent`,
      [taskSignature, algorithm, quality, successDelta, failureDelta, ts, agent],
    );
  }

  private listAlgorithmStats(taskSignature: string | null): AlgorithmStats[] {
    const sql = taskSignature
      ? `SELECT task_signature, algorithm, samples, sum_quality, successes, failures, last_seen_at
         FROM ${ALGO_TABLE} WHERE task_signature = ? ORDER BY last_seen_at DESC`
      : `SELECT task_signature, algorithm, samples, sum_quality, successes, failures, last_seen_at
         FROM ${ALGO_TABLE} ORDER BY last_seen_at DESC LIMIT 500`;
    const stmt = this.db.prepare(sql);
    const out: AlgorithmStats[] = [];
    try {
      if (taskSignature && typeof stmt.bind === 'function') stmt.bind([taskSignature]);
      while (stmt.step()) {
        const r = stmt.getAsObject();
        const samples = Number(r.samples ?? 0);
        const sumQuality = Number(r.sum_quality ?? 0);
        out.push({
          taskSignature: String(r.task_signature),
          algorithm: String(r.algorithm),
          samples,
          meanQuality: samples > 0 ? sumQuality / samples : 0,
          successes: Number(r.successes ?? 0),
          failures: Number(r.failures ?? 0),
          lastSeenAt: Number(r.last_seen_at ?? 0),
        });
      }
    } finally {
      stmt.free();
    }
    return out;
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${FEEDBACK_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        task_signature TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        agent TEXT NOT NULL,
        quality REAL NOT NULL,
        success INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        metadata TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${FEEDBACK_TABLE}_sig ON ${FEEDBACK_TABLE}(task_signature);
      CREATE INDEX IF NOT EXISTS idx_${FEEDBACK_TABLE}_algo ON ${FEEDBACK_TABLE}(algorithm);
      CREATE TABLE IF NOT EXISTS ${ALGO_TABLE} (
        task_signature TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        samples INTEGER NOT NULL,
        sum_quality REAL NOT NULL,
        successes INTEGER NOT NULL,
        failures INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        agent TEXT NOT NULL,
        PRIMARY KEY(task_signature, algorithm)
      );
    `);
  }
}

function pickAlgorithm(input: FeedbackInput, agent: string): string {
  if (typeof input.algorithm === 'string' && input.algorithm.length > 0) return input.algorithm;
  if (agent) return agent;
  return 'default';
}

function pickSignature(input: FeedbackInput): string {
  if (typeof input.taskSignature === 'string' && input.taskSignature.length > 0) return input.taskSignature;
  return signatureFromTaskId(input.taskId);
}

function signatureFromTaskId(value: string): string {
  // First alphanumeric token collapses variants like "build:abc123" and
  // "build-42" into the same signature "build" so their stats aggregate.
  const token = String(value ?? '').trim().split(/[^a-z0-9]+/i)[0];
  return (token || 'default').toLowerCase();
}

function decayedScore(mean: number, lastSeenAt: number, now: number, halfLife: number): number {
  const age = Math.max(0, now - lastSeenAt);
  return mean * Math.pow(0.5, age / halfLife);
}

function sampleBoost(samples: number): number {
  // log2(n+2) maps samples=0→1, samples=1→1.58, samples=10→3.58 — a mild
  // boost that still lets a newer high-quality algorithm overtake an old one.
  return Math.log2(Math.max(0, samples) + 2);
}

export default LearningSystem;
