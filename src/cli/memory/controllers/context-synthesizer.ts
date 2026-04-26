/**
 * ContextSynthesizer — moflo-owned memory-pattern summarizer (epic #464 Phase C2).
 *
 * Replaces `agentdb.ContextSynthesizer`. Deterministic extractive summary
 * over a set of memory patterns — no LLM call; callers that want an LLM
 * summary compose one on top.
 *
 * Consumer surface (from src/cli/memory/memory-bridge.ts):
 *   ContextSynthesizer.synthesize(memories, { includeRecommendations }): SynthesisResult
 *
 * memories come from hierarchicalMemory.recall() as
 *   { content, key, reward, verdict }[]
 */

import { clampInt } from './_shared.js';
import type { MemoryPattern } from './types.js';
import type { ControllerSpec } from '../controller-spec.js';

export interface SynthesisOptions {
  includeRecommendations?: boolean;
  maxContent?: number;
}

export interface SynthesisResult {
  summary: string;
  count: number;
  successCount: number;
  failureCount: number;
  topKeys: string[];
  recommendations?: string[];
}

const DEFAULT_MAX_CONTENT = 2000;

export class ContextSynthesizer {
  /**
   * Static by contract — `memory-bridge.ts` treats the registry entry as a
   * class and calls `CS.synthesize(...)`.
   */
  static synthesize(
    memories: MemoryPattern[] | null | undefined,
    options: SynthesisOptions = {},
  ): SynthesisResult {
    const list = Array.isArray(memories) ? memories.filter(isUsable) : [];
    const maxContent = Math.max(200, options.maxContent ?? DEFAULT_MAX_CONTENT);
    const includeRec = options.includeRecommendations !== false;

    if (list.length === 0) {
      return {
        summary: 'No memories available for synthesis.',
        count: 0,
        successCount: 0,
        failureCount: 0,
        topKeys: [],
        ...(includeRec ? { recommendations: [] } : {}),
      };
    }

    // Sort by reward desc (nullish last), stable.
    const ranked = [...list].sort((a, b) => {
      const ra = typeof a.reward === 'number' ? a.reward : -Infinity;
      const rb = typeof b.reward === 'number' ? b.reward : -Infinity;
      return rb - ra;
    });

    const successCount = ranked.filter((m) => isSuccess(m.verdict)).length;
    const failureCount = ranked.filter((m) => isFailure(m.verdict)).length;
    const topKeys = ranked.slice(0, 5).map((m) => m.key).filter(Boolean);

    const summary = buildSummary(ranked, maxContent);
    const result: SynthesisResult = {
      summary,
      count: ranked.length,
      successCount,
      failureCount,
      topKeys,
    };

    if (includeRec) {
      result.recommendations = buildRecommendations(ranked, successCount, failureCount);
    }

    return result;
  }
}

function isUsable(m: MemoryPattern | null | undefined): m is MemoryPattern {
  return !!m && typeof m.content === 'string' && m.content.trim().length > 0;
}

function isSuccess(verdict: unknown): boolean {
  if (typeof verdict !== 'string') return false;
  const v = verdict.toLowerCase();
  return v === 'success' || v === 'positive' || v === 'pass';
}

function isFailure(verdict: unknown): boolean {
  if (typeof verdict !== 'string') return false;
  const v = verdict.toLowerCase();
  return v === 'failure' || v === 'negative' || v === 'fail' || v === 'error';
}

function buildSummary(memories: MemoryPattern[], maxContent: number): string {
  const parts: string[] = [];
  parts.push(`${memories.length} memor${memories.length === 1 ? 'y' : 'ies'} synthesized.`);

  let budget = maxContent;
  const excerpts: string[] = [];
  for (const m of memories) {
    if (budget <= 0) break;
    const label = m.key ? `[${m.key}] ` : '';
    const trimmed = m.content.trim().replace(/\s+/g, ' ');
    const room = clampInt(budget, 60, 400, 60);
    const excerpt = trimmed.length > room ? trimmed.slice(0, room - 1) + '…' : trimmed;
    excerpts.push(`${label}${excerpt}`);
    budget -= excerpt.length + label.length + 2;
  }
  if (excerpts.length > 0) {
    parts.push(excerpts.join('\n'));
  }
  return parts.join('\n');
}

function buildRecommendations(
  memories: MemoryPattern[],
  successCount: number,
  failureCount: number,
): string[] {
  const recs: string[] = [];
  if (successCount > 0) {
    recs.push(`${successCount} successful pattern${successCount === 1 ? '' : 's'} available for reuse.`);
  }
  if (failureCount > 0) {
    recs.push(`${failureCount} failure pattern${failureCount === 1 ? '' : 's'} — review to avoid repeating mistakes.`);
  }
  const topRewarded = memories.find((m) => typeof m.reward === 'number' && m.reward > 0);
  if (topRewarded?.key) {
    recs.push(`Highest-reward memory: ${topRewarded.key}.`);
  }
  if (recs.length === 0) {
    recs.push('No actionable recommendations from the available memories.');
  }
  return recs;
}

export const contextSynthesizerSpec: ControllerSpec = {
  name: 'contextSynthesizer',
  level: 5,
  enabledByDefault: true,
  // ContextSynthesizer.synthesize is static — expose the class itself.
  create: () => ContextSynthesizer,
};

export default ContextSynthesizer;
