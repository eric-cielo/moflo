/**
 * User-facing strings for the embeddings-upgrade UX.
 *
 * Every string the orchestrator or renderer prints to the user lives here.
 * Centralising them keeps the output consistent across TTY and non-TTY code
 * paths and lets the snapshot tests treat user-facing copy as a contract.
 *
 * Rules (per issue #530):
 *   - Plain English. Non-technical audience.
 *   - No `HNSW`, `ONNX`, `vector`, `embedding`, `384-dim`, or `fastembed` in
 *     default output. Those details belong behind `--verbose` in the caller.
 *
 * @module @moflo/embeddings/migration/upgrade-messages
 */

export interface AnnouncementStep {
  label: string;
  itemsTotal: number;
}

export interface AnnouncementInput {
  steps: AnnouncementStep[];
  estimatedMinutes: number;
  /** Present when at least one store has an in-flight migration cursor. */
  resumed?: { itemsDone: number; itemsTotal: number };
}

/**
 * Multi-line pre-flight announcement. Printed once, before step 1 begins.
 * Empty step-count sections are tolerated — the caller decides when to call.
 */
export function announcement(input: AnnouncementInput): string {
  const lines: string[] = [];

  lines.push('Upgrading moflo memory for better semantic search');
  lines.push('');
  lines.push("Your existing memory was built with older, lower-quality search data.");
  lines.push("We're rebuilding it so search finds what you mean, not just what you");
  lines.push('type.');

  if (input.resumed) {
    lines.push('');
    lines.push(
      `Resuming where we left off: ${input.resumed.itemsDone} of ${input.resumed.itemsTotal} items already done.`,
    );
  }

  lines.push('');
  lines.push('Steps:');
  input.steps.forEach((step, i) => {
    lines.push(`  ${i + 1}. ${step.label} (${step.itemsTotal} items)`);
  });

  lines.push('');
  lines.push(
    `Estimated time: ${formatEstimatedTime(input.estimatedMinutes)}. Safe to interrupt — we'll pick up next time.`,
  );

  return lines.join('\n');
}

/**
 * Back-of-napkin time estimate based on items and a throughput assumption.
 * Used when the caller doesn't supply an estimate of its own.
 *
 * Default 100 items/second is a conservative floor for MiniLM-L6-v2 on CPU.
 */
export function estimateMinutes(totalItems: number, itemsPerSecond = 100): number {
  if (totalItems <= 0 || itemsPerSecond <= 0) return 0;
  const seconds = totalItems / itemsPerSecond;
  return Math.max(0, Math.round(seconds / 60));
}

function formatEstimatedTime(minutes: number): string {
  if (minutes < 1) return 'less than a minute';
  if (minutes === 1) return 'about 1 minute';
  return `about ${minutes} minutes`;
}

export function stepCompleted(
  stepIndex: number,
  stepTotal: number,
  label: string,
  itemsMigrated: number,
): string {
  return `✓ Step ${stepIndex + 1}/${stepTotal} complete — ${label} (${itemsMigrated} items)`;
}

export function finalSuccess(totalItems: number, durationMs: number): string {
  return `✓ Memory upgrade complete — ${totalItems} items re-indexed in ${formatDuration(durationMs)}.`;
}

export function pauseOnInterrupt(itemsDone: number, itemsTotal: number): string {
  return `Paused. Will resume automatically next time moflo runs. (${itemsDone} of ${itemsTotal} items done.)`;
}

export function batchExhaustionFailure(stepLabel: string): string {
  return `Upgrade failed while re-indexing "${stepLabel}". Retry runs next time moflo starts. For details, set MOFLO_UPGRADE_VERBOSE=1.`;
}

export function retryingBatch(stepLabel: string, attempt: number): string {
  return `Retrying "${stepLabel}" (attempt ${attempt})...`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

/** List of terms never allowed in default-path output. Tests enforce this. */
export const BANNED_TECHNICAL_TERMS: readonly string[] = Object.freeze([
  'HNSW',
  'ONNX',
  'vector',
  'embedding',
  '384-dim',
  'fastembed',
  'MiniLM',
]);
