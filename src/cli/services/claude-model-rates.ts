/**
 * Claude model rate table for The Luminarium "Claude Stats" tab cost
 * estimation. Rates are USD per 1M tokens for the public list-price tier
 * sourced from https://www.anthropic.com/pricing.
 *
 * The cost number rendered in the UI is *clearly labelled an estimate* —
 * actual billing depends on the user's contract, plan, and any cache
 * discounts Anthropic adjusts behind the scenes. Drift is bounded user
 * impact: a stale rate just means the displayed dollar figure lags reality
 * by a small percentage until the next moflo release.
 *
 * Source: https://www.anthropic.com/pricing
 * Last verified: 2026-05-09
 */
export interface ClaudeRate {
  /** USD per 1M input tokens. */
  readonly input: number;
  /** USD per 1M output tokens. */
  readonly output: number;
  /** USD per 1M cache-creation tokens (5m or 1h ephemeral cache writes). */
  readonly cacheCreate: number;
  /** USD per 1M cache-read tokens (cheap re-reads). */
  readonly cacheRead: number;
}

/**
 * Per-model USD/1M rates. Lookup goes through {@link rateForModel}, which
 * normalises the transcript's loose model names ("opus", "claude-opus-4-7",
 * "haiku-4-5", etc.) onto a canonical key.
 */
export const CLAUDE_RATES: Record<string, ClaudeRate> = {
  // Opus 4.x family
  opus: { input: 15, output: 75, cacheCreate: 18.75, cacheRead: 1.5 },
  // Sonnet 4.x family
  sonnet: { input: 3, output: 15, cacheCreate: 3.75, cacheRead: 0.3 },
  // Haiku 4.x family
  haiku: { input: 0.8, output: 4, cacheCreate: 1, cacheRead: 0.08 },
  // Unknown — zeroed out so the cost UI shows $0 for unrecognised models
  // rather than guessing wrong. The model name still surfaces in the
  // distribution card so the user can see the gap.
  unknown: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
};

/** Canonical model keys, ordered most-expensive → cheapest for stable display. */
export const CANONICAL_MODELS: readonly string[] = ['opus', 'sonnet', 'haiku', 'unknown'];

/**
 * Map a transcript model name to a canonical rate key. Recognises:
 *   - bare family names: "opus", "sonnet", "haiku"
 *   - dated/dotted variants: "claude-opus-4-7", "claude-3-5-sonnet-20241022"
 *   - case-insensitive
 * Anything else falls through to `'unknown'`.
 */
export function canonicalModelKey(model: string | null | undefined): string {
  if (!model || typeof model !== 'string') return 'unknown';
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return 'unknown';
}

/** Resolve a `ClaudeRate` row for the given (possibly raw) model name. */
export function rateForModel(model: string | null | undefined): ClaudeRate {
  return CLAUDE_RATES[canonicalModelKey(model)] ?? CLAUDE_RATES.unknown;
}

/**
 * Compute USD cost for a single usage record.
 * Rates are per 1M tokens; divide by 1e6 once at the end.
 */
export function costFromUsage(
  rate: ClaudeRate,
  usage: { input?: number; output?: number; cacheCreate?: number; cacheRead?: number },
): number {
  const i = usage.input ?? 0;
  const o = usage.output ?? 0;
  const cc = usage.cacheCreate ?? 0;
  const cr = usage.cacheRead ?? 0;
  return (
    (i * rate.input + o * rate.output + cc * rate.cacheCreate + cr * rate.cacheRead) / 1_000_000
  );
}
