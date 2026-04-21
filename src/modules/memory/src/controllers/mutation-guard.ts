/**
 * MutationGuard — pre-write anomaly detector. Three deterministic
 * checks instead of agentdb's WASM-backed ZK proofs; cryptographic
 * provenance belongs to AttestationLog.
 */

import { createHash } from 'node:crypto';

export interface ValidateInput {
  operation: string;
  params?: Record<string, unknown>;
  timestamp?: number;
}

export interface ValidateResult {
  allowed: boolean;
  reason?: string;
}

export interface MutationGuardOptions {
  dedupeWindowMs?: number;
  maxOpsPerSecond?: number;
  minValueLength?: number;
  watchedOperations?: string[];
}

const DEFAULT_OPTIONS: Required<MutationGuardOptions> = {
  dedupeWindowMs: 2_000,
  maxOpsPerSecond: 50,
  minValueLength: 0,
  watchedOperations: ['store', 'update', 'delete', 'bulk-store', 'hierarchical-store'],
};

interface RecentEntry {
  hash: string;
  ts: number;
}

export class MutationGuard {
  private opts: Required<MutationGuardOptions>;
  private recent: Map<string, RecentEntry[]> = new Map();

  constructor(options: MutationGuardOptions = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  validate(input: ValidateInput): ValidateResult {
    if (!input || typeof input.operation !== 'string' || input.operation.length === 0) {
      return { allowed: false, reason: 'operation is required' };
    }
    const op = input.operation;
    const ts = typeof input.timestamp === 'number' ? input.timestamp : Date.now();

    if (!this.isWatched(op)) return { allowed: true };

    const value = extractValueString(input.params);
    if (value !== null && value.length < this.opts.minValueLength) {
      return {
        allowed: false,
        reason: `value too short (${value.length} < ${this.opts.minValueLength})`,
      };
    }

    const entries = this.pruneAndFetch(op, ts);

    if (entries.length >= this.opts.maxOpsPerSecond) {
      // Rate limit and dedupe share the same recent-window buffer; we
      // count any entry within the last second for rate, not just those
      // in the (wider) dedupe window.
      const rateWindowStart = ts - 1000;
      const inLastSecond = entries.reduce((acc, e) => (e.ts >= rateWindowStart ? acc + 1 : acc), 0);
      if (inLastSecond >= this.opts.maxOpsPerSecond) {
        return {
          allowed: false,
          reason: `rate limit exceeded for ${op} (${this.opts.maxOpsPerSecond}/s)`,
        };
      }
    }

    const hash = hashParams(op, input.params);
    if (entries.some((e) => e.hash === hash)) {
      return { allowed: false, reason: 'duplicate mutation within dedupe window' };
    }

    this.record(op, entries, hash, ts);
    return { allowed: true };
  }

  reset(): void {
    this.recent.clear();
  }

  private isWatched(op: string): boolean {
    return this.opts.watchedOperations.includes(op);
  }

  /**
   * Drop entries older than the dedupe window and delete the op's key
   * entirely if nothing recent remains — prevents operations that fire
   * once and never again from keeping their buffer alive forever.
   */
  private pruneAndFetch(op: string, ts: number): RecentEntry[] {
    const stored = this.recent.get(op);
    if (!stored) return [];
    const windowStart = ts - this.opts.dedupeWindowMs;
    const pruned = stored.filter((e) => e.ts >= windowStart);
    if (pruned.length === 0) {
      this.recent.delete(op);
    } else if (pruned.length !== stored.length) {
      this.recent.set(op, pruned);
    }
    return pruned;
  }

  private record(op: string, entries: RecentEntry[], hash: string, ts: number): void {
    entries.push({ hash, ts });
    const cap = Math.max(10, this.opts.maxOpsPerSecond * 4);
    if (entries.length > cap) entries.splice(0, entries.length - cap);
    this.recent.set(op, entries);
  }
}

function extractValueString(params: Record<string, unknown> | undefined): string | null {
  if (!params) return null;
  const v = params.value ?? params.content ?? params.data;
  return typeof v === 'string' ? v : null;
}

function hashParams(op: string, params: Record<string, unknown> | undefined): string {
  const canonical = JSON.stringify({ op, p: canonicalize(params ?? {}) });
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = canonicalize((value as Record<string, unknown>)[k]);
  }
  return sorted;
}

export default MutationGuard;
