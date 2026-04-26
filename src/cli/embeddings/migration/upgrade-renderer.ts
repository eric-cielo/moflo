/**
 * Progress renderer for the embeddings-upgrade UX.
 *
 * Two rendering modes share the same public surface:
 *
 *   - **TTY**: rewrites a single line with `\r` as items progress. Shows a bar,
 *     percent, throughput, and ETA once the first batch has committed.
 *   - **Non-TTY** (pipe, CI, Docker logs): emits a fresh newline-terminated
 *     status line, throttled to at most one every `nonTtyThrottleMs`
 *     milliseconds (default: 3s).
 *
 * The renderer is framework-free — it writes to a caller-supplied
 * `NodeJS.WritableStream` (typically `process.stderr`) so it works from any
 * entry point without the `@moflo/cli` output singleton, which lives above
 * this package in the dependency graph.
 *
 * @module cli/embeddings/migration/upgrade-renderer
 */

import {
  batchExhaustionFailure,
  finalSuccess,
  pauseOnInterrupt,
  retryingBatch,
  stepCompleted,
} from './upgrade-messages.js';

export interface UpgradeRendererOptions {
  out: NodeJS.WritableStream;
  isTTY: boolean;
  /** Clock — injectable for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Minimum ms between non-TTY status lines. Default 3000 (3 seconds). */
  nonTtyThrottleMs?: number;
  /** TTY bar width in characters. Default 30. */
  barWidth?: number;
}

const DEFAULT_NON_TTY_THROTTLE_MS = 3000;
const DEFAULT_BAR_WIDTH = 30;

/**
 * Small state machine: everything printable goes through one of the public
 * methods, which handles whether an in-place TTY line needs clearing first.
 */
export class UpgradeRenderer {
  private readonly out: NodeJS.WritableStream;
  private readonly isTTY: boolean;
  private readonly now: () => number;
  private readonly nonTtyThrottleMs: number;
  private readonly barWidth: number;

  /** Length of the last in-place TTY line, so we can clear it precisely. */
  private inPlaceLength = 0;
  /** Wall-clock ms when the current step began; used for rate + ETA. */
  private stepStartMs = 0;
  /** Last time we emitted a non-TTY status line for this step. */
  private lastNonTtyAt = 0;

  constructor(options: UpgradeRendererOptions) {
    this.out = options.out;
    this.isTTY = options.isTTY;
    this.now = options.now ?? Date.now;
    this.nonTtyThrottleMs = options.nonTtyThrottleMs ?? DEFAULT_NON_TTY_THROTTLE_MS;
    this.barWidth = options.barWidth ?? DEFAULT_BAR_WIDTH;
  }

  /** Print the multi-line pre-flight announcement. Always terminates with a blank line. */
  announce(text: string): void {
    this.writeln();
    this.writeln(text);
    this.writeln();
  }

  stepStart(
    stepIndex: number,
    stepTotal: number,
    label: string,
    itemsTotal: number,
  ): void {
    this.stepStartMs = this.now();
    this.lastNonTtyAt = 0;

    if (this.isTTY) {
      this.renderBar(stepIndex, stepTotal, label, 0, itemsTotal);
    } else {
      this.writeln(this.nonTtyLine(stepIndex, stepTotal, label, 0, itemsTotal));
      this.lastNonTtyAt = this.now();
    }
  }

  stepProgress(
    stepIndex: number,
    stepTotal: number,
    label: string,
    itemsDone: number,
    itemsTotal: number,
  ): void {
    if (this.isTTY) {
      this.renderBar(stepIndex, stepTotal, label, itemsDone, itemsTotal);
      return;
    }

    const now = this.now();
    if (now - this.lastNonTtyAt < this.nonTtyThrottleMs) return;
    this.lastNonTtyAt = now;
    this.writeln(this.nonTtyLine(stepIndex, stepTotal, label, itemsDone, itemsTotal));
  }

  stepComplete(
    stepIndex: number,
    stepTotal: number,
    label: string,
    itemsMigrated: number,
  ): void {
    this.clearInPlace();
    this.writeln(stepCompleted(stepIndex, stepTotal, label, itemsMigrated));
  }

  stepRetry(label: string, attempt: number): void {
    this.clearInPlace();
    this.writeln(retryingBatch(label, attempt));
  }

  complete(totalItems: number, durationMs: number): void {
    this.clearInPlace();
    this.writeln();
    this.writeln(finalSuccess(totalItems, durationMs));
  }

  paused(itemsDone: number, itemsTotal: number): void {
    this.clearInPlace();
    this.writeln();
    this.writeln(pauseOnInterrupt(itemsDone, itemsTotal));
  }

  failed(stepLabel: string): void {
    this.clearInPlace();
    this.writeln();
    this.writeln(batchExhaustionFailure(stepLabel));
  }

  /**
   * Convenience for callers that want to forward a single verbose error line
   * (already formatted). Always on its own newline, never rewritten.
   */
  writeVerbose(line: string): void {
    this.clearInPlace();
    this.writeln(line);
  }

  private renderBar(
    stepIndex: number,
    stepTotal: number,
    label: string,
    itemsDone: number,
    itemsTotal: number,
  ): void {
    const pct = percent(itemsDone, itemsTotal);
    const filled = Math.round((this.barWidth * pct) / 100);
    const empty = Math.max(0, this.barWidth - filled);
    const bar = `[${'#'.repeat(filled)}${'-'.repeat(empty)}]`;

    const elapsedMs = Math.max(0, this.now() - this.stepStartMs);
    const rate = itemsDone > 0 && elapsedMs > 0 ? (itemsDone / elapsedMs) * 1000 : 0;

    let tail = ` ${pct}%`;
    if (rate > 0) {
      tail += ` | ${Math.round(rate)}/s`;
      if (itemsDone < itemsTotal) {
        const remainingSec = (itemsTotal - itemsDone) / rate;
        tail += ` | ETA ${formatShortSeconds(remainingSec)}`;
      }
    }

    const prefix = `Step ${stepIndex + 1}/${stepTotal}: ${label} `;
    const line = `${prefix}${bar}${tail}`;
    this.writeInPlace(line);
  }

  private nonTtyLine(
    stepIndex: number,
    stepTotal: number,
    label: string,
    itemsDone: number,
    itemsTotal: number,
  ): string {
    const pct = percent(itemsDone, itemsTotal);
    return `Step ${stepIndex + 1}/${stepTotal}: ${label} — ${itemsDone}/${itemsTotal} items (${pct}%)`;
  }

  /** TTY-only. Callers must check `isTTY` before invoking. */
  private writeInPlace(text: string): void {
    this.clearInPlace();
    this.out.write(text);
    this.inPlaceLength = text.length;
  }

  private clearInPlace(): void {
    if (this.inPlaceLength === 0) return;
    this.out.write(`\r${' '.repeat(this.inPlaceLength)}\r`);
    this.inPlaceLength = 0;
  }

  private writeln(text = ''): void {
    this.clearInPlace();
    this.out.write(`${text}\n`);
  }
}

function percent(done: number, total: number): number {
  if (total <= 0) return 0;
  const pct = (done / total) * 100;
  if (pct >= 100) return 100;
  if (pct <= 0) return 0;
  return Math.floor(pct);
}

function formatShortSeconds(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  const remainder = s % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}
