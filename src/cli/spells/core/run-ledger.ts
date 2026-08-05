/**
 * Rolling-window invocation ledger — the cross-run half of the spend ceiling.
 *
 * #1335 bounded a single spell run. That bounds the blast radius of one bad
 * run and nothing else: the daemon's defining property is that it fires
 * repeatedly with nobody watching, so a 5-minute schedule with a 30-invocation
 * per-run ceiling still permits 8,640 invocations a day, every one of which
 * passes the per-run check. The per-run ceiling catches a runaway loop; this
 * catches a runaway *schedule*.
 *
 * Storage is a small JSON file under `.moflo/`, bucketed by clock hour rather
 * than one entry per invocation. Two reasons:
 *
 *   - The file stays bounded at <= 24 entries no matter the volume, so a
 *     misconfigured cron cannot grow it without limit — which would be an
 *     amusing way for a spend guard to become the incident.
 *   - Read-modify-write per invocation stays cheap.
 *
 * The cost is granularity: the window covers between 23 and 24 hours of real
 * time depending on where "now" sits inside the current hour. That is well
 * within tolerance for a backstop whose job is catching an order-of-magnitude
 * overrun, and it is documented rather than papered over.
 *
 * Concurrency: one daemon owns a project root (enforced by daemon-lock), so
 * the read-modify-write here is effectively single-writer. State is re-read
 * immediately before each write to keep the lost-update window as small as
 * possible without taking a file lock — a dropped increment under-counts a
 * safety ceiling slightly, which is the correct direction to fail.
 *
 * Cross-platform (Rule #1): `path.join` throughout, no shell, and writes go
 * through the shared `atomicWriteFileSync` helper (fsync + rename, with the
 * Windows AV-settle verify).
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { atomicWriteFileSync } from '../../shared/utils/atomic-file-write.js';

/** Trailing window the ledger counts over. */
export const LEDGER_WINDOW_MS = 24 * 60 * 60 * 1000;

const BUCKET_MS = 60 * 60 * 1000;
const LEDGER_VERSION = 1;

/** Persisted shape. Bucket keys are epoch-hour indices, stringified. */
interface LedgerFile {
  version: number;
  buckets: Record<string, number>;
}

/**
 * Path of the ledger for a project. Exported so tests and diagnostics can
 * find it without rebuilding the path by hand (Rule #1: never hand-assemble
 * a path with a literal separator).
 */
export function ledgerPathFor(projectRoot: string): string {
  return join(projectRoot, '.moflo', 'spell-invocation-ledger.json');
}

export interface LedgerOptions {
  /** Clock injection point for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Trailing window length. Defaults to {@link LEDGER_WINDOW_MS}. */
  readonly windowMs?: number;
}

/**
 * A rolling count of model invocations across every run that shares a project
 * root. Constructed per run; state lives on disk, so it survives daemon
 * restarts and spans runs that never see each other.
 */
export class InvocationLedger {
  private readonly now: () => number;
  private readonly windowMs: number;

  constructor(
    private readonly filePath: string,
    options: LedgerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? LEDGER_WINDOW_MS;
  }

  /** Invocations recorded in the trailing window. */
  count(): number {
    const buckets = this.live(this.read().buckets);
    let total = 0;
    for (const n of Object.values(buckets)) total += n;
    return total;
  }

  /**
   * Record one invocation. Best-effort: a ledger that cannot be written must
   * not fail a run that would otherwise work, for the same reason
   * `loadSpellBudgetFromProject` swallows its errors — this is a safety
   * ceiling, not a correctness requirement.
   */
  record(): void {
    try {
      const state = this.read();
      const buckets = this.live(state.buckets);
      const key = String(Math.floor(this.now() / BUCKET_MS));
      buckets[key] = (buckets[key] ?? 0) + 1;
      this.write({ version: LEDGER_VERSION, buckets });
    } catch {
      /* see doc — under-counting a backstop beats failing a working run */
    }
  }

  /** How many invocations remain before `limit` is reached in this window. */
  remaining(limit: number): number {
    return Math.max(0, limit - this.count());
  }

  // --------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------

  private read(): LedgerFile {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as unknown;
      if (!parsed || typeof parsed !== 'object') return emptyLedger();
      const rec = parsed as Partial<LedgerFile>;
      if (rec.version !== LEDGER_VERSION || !rec.buckets || typeof rec.buckets !== 'object') {
        // A future or corrupt version reads as empty rather than throwing.
        // Failing open is right for a ceiling: an unreadable ledger must not
        // block every scheduled run in the project.
        return emptyLedger();
      }
      return { version: LEDGER_VERSION, buckets: { ...rec.buckets } };
    } catch {
      return emptyLedger();
    }
  }

  private write(state: LedgerFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    atomicWriteFileSync(this.filePath, JSON.stringify(state));
  }

  /**
   * Drop buckets that have fallen out of the trailing window. Pruning on every
   * read is what keeps the file bounded — there is no separate cleanup pass to
   * forget to schedule.
   */
  private live(buckets: Record<string, number>): Record<string, number> {
    const oldest = Math.floor((this.now() - this.windowMs) / BUCKET_MS);
    const kept: Record<string, number> = {};
    for (const [key, n] of Object.entries(buckets)) {
      const bucket = Number(key);
      if (!Number.isFinite(bucket) || typeof n !== 'number' || !Number.isFinite(n)) continue;
      if (bucket >= oldest) kept[key] = n;
    }
    return kept;
  }
}

function emptyLedger(): LedgerFile {
  return { version: LEDGER_VERSION, buckets: {} };
}
