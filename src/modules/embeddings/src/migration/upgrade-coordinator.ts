/**
 * Multi-step coordinator for the embeddings-upgrade UX.
 *
 * Sits on top of {@link migrateStore} (story 2, #529) and wires:
 *
 *   - A pre-flight announcement built from per-step item counts.
 *   - A TTY / non-TTY progress renderer subscribed to driver events.
 *   - A SIGINT-to-AbortSignal bridge that lets the in-flight batch flush
 *     cleanly before the coordinator returns with status `'aborted'`.
 *   - Consistent final-state messaging (success, paused, failed).
 *
 * The coordinator is a pure library function — it returns a summary and
 * never calls `process.exit`. Whoever wires it into session-start decides
 * whether to exit 0 on abort or continue.
 *
 * @module @moflo/embeddings/migration/upgrade-coordinator
 */

import { migrateStore } from './migrate-store.js';
import type {
  MigrationEmbedder,
  MigrationProgress,
  MigrationResult,
  MigrationStore,
} from './types.js';
import {
  announcement,
  estimateMinutes,
  type AnnouncementInput,
  type AnnouncementStep,
} from './upgrade-messages.js';
import { UpgradeRenderer } from './upgrade-renderer.js';

export interface UpgradeStep {
  /** User-facing label, e.g. "Re-index memory database". Must not contain banned technical terms. */
  label: string;
  store: MigrationStore;
  embedder: MigrationEmbedder;
}

export interface UpgradePlan {
  steps: UpgradeStep[];
}

export type UpgradeStatus = 'completed' | 'aborted' | 'failed';

export interface UpgradeStepSummary {
  label: string;
  itemsTotal: number;
  itemsMigrated: number;
  durationMs: number;
  versionBumped: boolean;
  aborted: boolean;
  resumed: boolean;
  errors: readonly string[];
}

export interface UpgradeSummary {
  status: UpgradeStatus;
  durationMs: number;
  totalItemsMigrated: number;
  steps: readonly UpgradeStepSummary[];
  errors: readonly string[];
}

export interface UpgradeCoordinatorOptions {
  plan: UpgradePlan;
  /** Output stream for progress + messages. Default `process.stderr`. */
  out?: NodeJS.WritableStream & { isTTY?: boolean };
  /** Override TTY detection. Default: `out.isTTY ?? false`. */
  isTTY?: boolean;
  /** External abort signal (e.g. wrapper process cancelling). */
  signal?: AbortSignal;
  /** Install a SIGINT handler that aborts the run cleanly. Default `true`. */
  installSigintHandler?: boolean;
  /** Clock — injectable for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /** Per-driver-call options. */
  batchSize?: number;
  maxRetries?: number;
  backoffMs?: number;
  /** Minimum ms between non-TTY progress lines. Default 3000. */
  nonTtyThrottleMs?: number;
  /** Items/sec used for the pre-flight estimate. Default 100. */
  estimateItemsPerSecond?: number;
  /** Pre-built renderer (tests inject; production code never passes this). */
  renderer?: UpgradeRenderer;
}

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 50;

export async function runUpgrade(options: UpgradeCoordinatorOptions): Promise<UpgradeSummary> {
  const out = options.out ?? process.stderr;
  const isTTY = options.isTTY ?? (out as { isTTY?: boolean }).isTTY ?? false;
  const now = options.now ?? Date.now;

  const renderer =
    options.renderer ??
    new UpgradeRenderer({
      out,
      isTTY,
      now,
      ...(options.nonTtyThrottleMs !== undefined
        ? { nonTtyThrottleMs: options.nonTtyThrottleMs }
        : {}),
    });

  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const estimateItemsPerSecond = options.estimateItemsPerSecond ?? 100;

  const controller = new AbortController();
  const abortAll = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  // Wire SIGINT + an external signal through a single controller we own. Both
  // listeners are captured so `finally` can remove them — otherwise a long-
  // lived external signal reused across runs accumulates one listener each.
  const externalSignal = options.signal;
  let externalAbortListener: (() => void) | null = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      abortAll(signalReason(externalSignal));
    } else {
      externalAbortListener = () => abortAll(signalReason(externalSignal));
      externalSignal.addEventListener('abort', externalAbortListener, { once: true });
    }
  }

  let sigintListener: (() => void) | null = null;
  if (options.installSigintHandler !== false) {
    sigintListener = () => abortAll('SIGINT');
    process.on('SIGINT', sigintListener);
  }

  const startedAt = now();
  const stepSummaries: UpgradeStepSummary[] = [];
  const allErrors: string[] = [];
  let status: UpgradeStatus = 'completed';
  let totalMigrated = 0;

  try {
    const { input: announcementInput, counts } = await buildAnnouncement(
      options.plan,
      estimateItemsPerSecond,
    );
    renderer.announce(announcement(announcementInput));

    const stepTotal = options.plan.steps.length;
    for (let i = 0; i < stepTotal; i++) {
      const step = options.plan.steps[i]!;

      renderer.stepStart(i, stepTotal, step.label, counts[i]!);

      const result = await migrateStore({
        store: step.store,
        embedder: step.embedder,
        batchSize,
        maxRetries,
        backoffMs,
        signal: controller.signal,
        onProgress: (progress) =>
          forwardProgress(renderer, progress, i, stepTotal, step.label),
      });

      stepSummaries.push(toStepSummary(step.label, result));
      allErrors.push(...result.errors);
      totalMigrated += result.itemsMigrated;

      if (result.aborted) {
        renderer.paused(result.itemsMigrated, result.itemsTotal);
        status = 'aborted';
        break;
      }

      if (!result.success) {
        renderer.failed(step.label);
        status = 'failed';
        break;
      }

      renderer.stepComplete(i, stepTotal, step.label, result.itemsMigrated);
    }

    if (status === 'completed') {
      renderer.complete(totalMigrated, now() - startedAt);
    }
  } finally {
    if (sigintListener) process.off('SIGINT', sigintListener);
    if (externalAbortListener && externalSignal) {
      externalSignal.removeEventListener('abort', externalAbortListener);
    }
  }

  return {
    status,
    durationMs: now() - startedAt,
    totalItemsMigrated: totalMigrated,
    steps: stepSummaries,
    errors: allErrors,
  };
}

async function buildAnnouncement(
  plan: UpgradePlan,
  itemsPerSecond: number,
): Promise<{ input: AnnouncementInput; counts: readonly number[] }> {
  const [counts, cursors] = await Promise.all([
    Promise.all(plan.steps.map((s) => s.store.countItems())),
    Promise.all(plan.steps.map((s) => s.store.loadCursor())),
  ]);

  const steps: AnnouncementStep[] = plan.steps.map((s, i) => ({
    label: s.label,
    itemsTotal: counts[i]!,
  }));

  const totalItems = counts.reduce((sum, c) => sum + c, 0);
  const estimatedMinutes = estimateMinutes(totalItems, itemsPerSecond);

  let itemsDoneSoFar = 0;
  let itemsTotalSoFar = 0;
  for (const cursor of cursors) {
    if (cursor) {
      itemsDoneSoFar += cursor.itemsDone;
      itemsTotalSoFar += cursor.itemsTotal;
    }
  }

  const input: AnnouncementInput = { steps, estimatedMinutes };
  if (itemsTotalSoFar > 0) {
    input.resumed = { itemsDone: itemsDoneSoFar, itemsTotal: itemsTotalSoFar };
  }
  return { input, counts };
}

function forwardProgress(
  renderer: UpgradeRenderer,
  progress: MigrationProgress,
  stepIndex: number,
  stepTotal: number,
  label: string,
): void {
  switch (progress.step) {
    case 'start':
      // `stepStart` already handled the initial render from runUpgrade.
      return;
    case 'batch':
      renderer.stepProgress(stepIndex, stepTotal, label, progress.itemsDone, progress.itemsTotal);
      return;
    case 'retry':
      if (typeof progress.attempt === 'number') {
        renderer.stepRetry(label, progress.attempt);
      }
      return;
    case 'finish':
    case 'aborted':
      // `stepComplete` / `paused` are driven from runUpgrade using the final
      // MigrationResult, which carries the authoritative item counts.
      return;
  }
}

function toStepSummary(label: string, result: MigrationResult): UpgradeStepSummary {
  return {
    label,
    itemsTotal: result.itemsTotal,
    itemsMigrated: result.itemsMigrated,
    durationMs: result.durationMs,
    versionBumped: result.versionBumped,
    aborted: result.aborted,
    resumed: result.resumed,
    errors: result.errors,
  };
}

function signalReason(signal: AbortSignal): unknown {
  return (signal as AbortSignal & { reason?: unknown }).reason ?? 'aborted';
}
