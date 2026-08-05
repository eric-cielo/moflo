/**
 * Single-writer lock for the HNSW sidecar pair (#1388).
 *
 * `.moflo/hnsw.index` and `.moflo/hnsw.manifest.json` are each written
 * atomically, but they are two independent writes with nothing tying them
 * together — and, more importantly, a writer decides *what* to write by
 * loading the sidecar and diffing it against the DB long before it writes.
 * Two writers therefore clobber each other even though neither write is torn:
 * both load the same starting graph, both compute a diff against it, and the
 * loser's result is simply overwritten. Observed on 4.12.4-rc.6, where the
 * sidecar ended a run holding 5199 vectors while the DB had 5219.
 *
 * The concurrency is not accidental. `index-all.mjs` runs its steps in
 * sequence, but `index-patterns`/`index-reference`/`index-guidance` each
 * fire-and-forget their own namespace-scoped `build-embeddings`, and
 * `pm.spawn` dedups on exact label equality — so `build-embeddings-patterns`,
 * `build-embeddings-reference`, `build-embeddings-guidance` and index-all's
 * own `build-embeddings` are four distinct labels that never dedup against
 * each other. `flo memory rebuild-index` can join them at any moment.
 *
 * So the lock has to span **load → diff → write**, not just the write. Held
 * only around the write, the second writer would still be acting on a graph
 * it read before the first writer's result existed, and last-writer-wins
 * would survive untouched. Held across the whole operation, the second writer
 * blocks, then loads the first writer's freshly written sidecar and adds only
 * its own new rows — which is exactly the incremental path #1384 built.
 *
 * ## Why this shape
 *
 * `writeFileSync(..., { flag: 'wx' })` is `O_CREAT | O_EXCL`: the write fails
 * with EEXIST if the file exists, atomically, on Linux, macOS and Windows
 * alike. It is the same primitive `services/daemon-lock.ts` uses, for the same
 * reason — no `flock`, no advisory-lock assumptions, no platform branch.
 *
 * This lock differs from the daemon's in one way that matters: the daemon's is
 * fail-fast (the loser must not run), this one **waits** (the loser must run,
 * just afterwards). Losing an embedding run would leave rows unsearchable
 * until the next session, which is the class of bug #1383 exists to prevent.
 *
 * @module memory/hnsw-sidecar-lock
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { hnswIndexPath } from '../services/moflo-paths.js';

const LOCK_FILENAME = 'hnsw.lock';

/** How often to retry acquiring while another process holds the lock. */
const POLL_INTERVAL_MS = 50;

/**
 * How long to wait for a live holder before giving up — and **throwing**.
 *
 * The tempting alternative, breaking the lock and proceeding, is wrong: by
 * this point the holder has been confirmed alive and non-stale on every poll,
 * so taking the lock means running concurrently with it. That is precisely the
 * load→diff→write race this module exists to close, reintroduced silently
 * under a `console.warn`.
 *
 * Throwing is contained. Embedding happens before the sidecar step, so the
 * rows are already committed to the DB; `build-embeddings.mjs` logs the error
 * to `background.log` and exits non-zero, and the next indexing pass
 * reconciles. A wedged lock costs one deferred reconcile, not a corrupt graph.
 *
 * A full rebuild of a large consumer store is seconds, so 120s of contention
 * already means something is wrong and should say so.
 */
const ACQUIRE_TIMEOUT_MS = 120_000;

/**
 * Age past which a lock is presumed abandoned even if a live process claims it.
 *
 * The liveness probe below already reclaims a lock whose holder has exited.
 * This is the backstop for the case it cannot see: a recycled PID on Windows
 * now belonging to an unrelated process, which would otherwise read as "the
 * holder is alive" forever.
 */
const STALE_LOCK_MS = 10 * 60_000;

interface LockPayload {
  pid: number;
  startedAt: number;
}

/** `<projectRoot>/.moflo/hnsw.lock`, beside the sidecar it guards. */
export function hnswLockPath(projectRoot: string): string {
  return path.join(path.dirname(hnswIndexPath(projectRoot)), LOCK_FILENAME);
}

/**
 * In-process serialisation, keyed by lock path.
 *
 * The file lock is cross-process; this covers the same-process case, where two
 * concurrent `await syncHnswSidecar(...)` calls in one runtime (the daemon
 * servicing two requests, a test driving both entry points) would otherwise
 * each see no lock file and both proceed. Chaining their promises means the
 * file lock only ever arbitrates between distinct processes, which is what it
 * is good at.
 */
const inProcessChain = new Map<string, Promise<unknown>>();

/**
 * How many lock paths the in-process chain is currently tracking.
 *
 * Exported for tests. The map must drain back to zero once every caller has
 * settled — an earlier revision compared the wrong promise reference in its
 * cleanup, so the entry was never removed and the map grew one slot per lock
 * path for the life of the process. That leak is invisible from the outside,
 * which is exactly why it needs an assertion of its own.
 */
export function pendingLockChainCount(): number {
  return inProcessChain.size;
}

/**
 * Is `pid` a process that could still be holding the lock?
 *
 * The zombie branch is not optional here. `kill(pid, 0)` succeeds for a
 * process that has exited but not been reaped, and `build-embeddings` is
 * spawned by an indexer that often outlives it — so its corpse can sit
 * unreaped, and treating it as a live holder would make every waiter poll a
 * dead process until the staleness cap. `services/daemon-lock.ts` learned this
 * the same way; the logic below is deliberately kept in step with it.
 *
 * Not shared with that copy on purpose: daemon-lock treats EPERM as *dead*,
 * which is right for it (it pairs the probe with a command-line check and
 * wants to reclaim locks left by unrelated processes) and wrong here, where
 * treating another user's live process as dead would mean writing alongside
 * it. Unifying them means changing daemon-lock's semantics, which is not this
 * fix's blast radius.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM means the process exists but belongs to another user — alive for
    // our purposes. Only ESRCH is proof of absence.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      // The comm field can contain spaces and parens, so index from the last
      // ')' — state is the character two positions after it.
      const lastParen = stat.lastIndexOf(')');
      if (lastParen !== -1 && stat.charAt(lastParen + 2) === 'Z') return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      // /proc unavailable (a container without it) — keep the kill(0) verdict.
    }
  }
  return true;
}

function readLock(lockFile: string): LockPayload | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile, 'utf-8')) as Partial<LockPayload>;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'number') return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    // Missing (released between EEXIST and this read) or unparseable (a
    // half-written lock from a process killed mid-write). Both mean "nothing
    // trustworthy is holding this".
    return null;
  }
}

/** Remove a lock we have judged abandoned. Losing the race to do so is fine. */
function breakLock(lockFile: string): void {
  try {
    fs.unlinkSync(lockFile);
  } catch {
    /* already gone, or another waiter broke it first */
  }
}

/**
 * True when the on-disk lock should not stop us: absent, unparseable, held by
 * a process that has exited, or older than {@link STALE_LOCK_MS}.
 */
function isReclaimable(lockFile: string, now: number): boolean {
  const held = readLock(lockFile);
  if (!held) return true;
  if (!isProcessAlive(held.pid)) return true;
  return now - held.startedAt > STALE_LOCK_MS;
}

/**
 * Run `fn` with exclusive access to the sidecar pair at `projectRoot`.
 *
 * Serialises against other processes via the lock file and against other
 * callers in this process via a promise chain. Always releases, including when
 * `fn` throws — the caller's error propagates unchanged.
 *
 * Not re-entrant, deliberately: nesting two calls would deadlock on the
 * in-process chain. Callers compose by keeping an unlocked core function and
 * wrapping only at the public entry points.
 */
export async function withHnswSidecarLock<T>(
  projectRoot: string,
  fn: () => Promise<T>,
  /**
   * `acquireTimeoutMs` overrides {@link ACQUIRE_TIMEOUT_MS}. A seam for tests:
   * the give-up branch is the one place this module refuses to write, and at
   * the production value it would take two minutes of held contention to
   * reach. Production callers pass nothing.
   */
  options: { acquireTimeoutMs?: number } = {},
): Promise<T> {
  const lockFile = hnswLockPath(projectRoot);
  const previous = inProcessChain.get(lockFile) ?? Promise.resolve();

  // Chain regardless of how the previous holder finished — a rejection there
  // is that caller's problem, not a reason to stop serialising.
  const run = previous
    .catch(() => undefined)
    .then(() => acquireThenRun(lockFile, fn, options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS));
  // Track the settled-swallowing wrapper, not `run` itself, and compare against
  // that same reference below — comparing against `run` never matches, which
  // silently turned the cleanup into a no-op and leaked one entry per lock path.
  const tracked = run.catch(() => undefined);
  inProcessChain.set(lockFile, tracked);

  try {
    return await run;
  } finally {
    // Drop the entry only while we are still the tail. A later caller that has
    // already chained onto us owns the slot, and must keep it.
    if (inProcessChain.get(lockFile) === tracked) {
      inProcessChain.delete(lockFile);
    }
  }
}

async function acquireThenRun<T>(
  lockFile: string,
  fn: () => Promise<T>,
  acquireTimeoutMs: number,
): Promise<T> {
  const payload: LockPayload = { pid: process.pid, startedAt: Date.now() };
  const deadline = payload.startedAt + acquireTimeoutMs;

  for (;;) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify(payload), { flag: 'wx' });
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;

      // `.moflo/` exists for any project with a database to index, so this is
      // the cold path, not a per-acquire `mkdirSync` on the common one.
      if (code === 'ENOENT') {
        fs.mkdirSync(path.dirname(lockFile), { recursive: true });
        continue;
      }
      if (code !== 'EEXIST') throw err;

      const now = Date.now();
      if (isReclaimable(lockFile, now)) {
        breakLock(lockFile);
        continue;
      }
      if (now >= deadline) {
        // Deliberately not `breakLock` + proceed: every poll to here confirmed
        // the holder alive and non-stale, so taking the lock now would run
        // concurrently with it — the exact race this module closes.
        const holder = readLock(lockFile);
        throw new Error(
          `hnsw sidecar lock at ${lockFile} still held by pid ${holder?.pid ?? 'unknown'} ` +
          `after ${acquireTimeoutMs}ms; skipping this reconcile rather than writing alongside it`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  try {
    return await fn();
  } finally {
    // Only remove a lock still carrying our payload. A hold that outlives
    // STALE_LOCK_MS can be reclaimed out from under us, and by then the file
    // belongs to whoever took it — deleting theirs would hand a third writer a
    // lock nobody holds.
    const current = readLock(lockFile);
    if (current && current.pid === payload.pid && current.startedAt === payload.startedAt) {
      breakLock(lockFile);
    }
  }
}
