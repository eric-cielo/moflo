/**
 * Unit coverage for the `PRAGMA journal_mode = WAL` retry (#1471).
 *
 * `openDaemonDatabase` sets `busy_timeout` before the WAL pragma so concurrent
 * openers survive the brief EXCLUSIVE lock the conversion takes. That ordering
 * is correct but insufficient: SQLite does not invoke the busy handler for a
 * journal-mode change, so the one statement the budget was put there for never
 * gets it, and the losers of a first-open race threw `SQLITE_BUSY` outright.
 *
 * The retry lives in two hand-maintained twins — the TS factory the daemon and
 * MCP server use, and the `.mjs` factory `bin/*` uses. Every case below runs
 * against BOTH, so a fix applied to one and forgotten in the other fails here
 * rather than in a consumer's CI. Behavioural lockstep, not a text-diff guard:
 * the twins are allowed to differ in style, never in what they do.
 *
 * Cross-platform: no filesystem, no subprocesses, no real SQLite — the fake
 * below drives the retry directly, so this file behaves identically on all
 * three platforms. The real cross-process proof is
 * `tests/system/daemon-open-concurrent-wal-1471.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { setWalWithRetry as setWalTs } from '../../memory/daemon-backend.js';
// @ts-expect-error — plain .mjs twin, no type declarations by design.
import { setWalWithRetry as setWalMjs } from '../../../../bin/lib/get-backend.mjs';

type SetWal = (db: unknown, dbPath: string, budgetMs?: number) => void;

const IMPLEMENTATIONS: Array<[string, SetWal]> = [
  ['daemon-backend.ts', setWalTs as unknown as SetWal],
  ['bin/lib/get-backend.mjs', setWalMjs as SetWal],
];

function busyError(withErrcode = true): Error {
  const err = new Error('database is locked');
  if (withErrcode) Object.assign(err, { errcode: 5, errstr: 'database is locked' });
  return err;
}

interface FakeOpts {
  busyCount: number;
  mode?: string;
  error?: Error;
  /** The `PRAGMA journal_mode` read itself fails — a busy probe, not a mode. */
  probeThrows?: boolean;
}

/**
 * Minimal stand-in for a node:sqlite handle. `busyCount` conversion failures,
 * then success; `mode` is what a `PRAGMA journal_mode` read reports.
 *
 * Only the conversion statement can fail: a `busy_timeout` pragma takes no
 * lock and never contends, and counting those as attempts would make the
 * retry assertions below measure the wrong thing.
 */
function fakeDb(opts: FakeOpts = { busyCount: 0 }) {
  const state = { execCalls: 0, probeCalls: 0, sqls: [] as string[] };
  return {
    state,
    exec(sql: string): void {
      state.sqls.push(sql);
      if (!/journal_mode\s*=/.test(sql)) return;
      state.execCalls++;
      if (state.execCalls <= opts.busyCount) throw opts.error ?? busyError();
    },
    prepare(_sql: string) {
      return {
        get() {
          state.probeCalls++;
          if (opts.probeThrows) throw busyError();
          return { journal_mode: opts.mode ?? 'delete' };
        },
      };
    },
  };
}

describe.each(IMPLEMENTATIONS)('setWalWithRetry — %s (#1471)', (_name, setWal) => {
  it('converts on the first attempt when nothing is contending', () => {
    // The common path — including every open of an already-WAL database, where
    // the pragma is a no-op that takes no exclusive lock. It must cost exactly
    // one statement and zero sleeps, or the fix would tax every process start.
    const db = fakeDb({ busyCount: 0, mode: 'wal' });
    const before = Date.now();
    setWal(db, '/tmp/moflo.db');
    expect(db.state.execCalls).toBe(1);
    expect(db.state.probeCalls).toBe(0);
    expect(Date.now() - before).toBeLessThan(200);
  });

  it('retries past a transient SQLITE_BUSY and succeeds', () => {
    const db = fakeDb({ busyCount: 2, mode: 'wal' });
    setWal(db, '/tmp/moflo.db');
    expect(db.state.execCalls).toBe(3);
  });

  it('recognises a busy error that carries no errcode', () => {
    // Some wrappers surface the sqlite message without the numeric code.
    const db = fakeDb({ busyCount: 1, mode: 'wal', error: busyError(false) });
    setWal(db, '/tmp/moflo.db');
    expect(db.state.execCalls).toBe(2);
  });

  it('treats "another process already converted it" as success, not failure', () => {
    // Losing every race is the expected outcome for the last of N openers.
    // The database being in WAL is what we wanted; who got it there is not
    // the caller's business.
    const db = fakeDb({ busyCount: Number.MAX_SAFE_INTEGER, mode: 'wal' });
    expect(() => setWal(db, '/tmp/moflo.db', 40)).not.toThrow();
    expect(db.state.probeCalls).toBe(1);
  });

  it('surfaces a diagnosable error when the budget is exhausted and WAL never took', () => {
    const db = fakeDb({ busyCount: Number.MAX_SAFE_INTEGER, mode: 'delete' });
    let thrown: Error | null = null;
    try {
      setWal(db, '/tmp/project/.moflo/moflo.db', 40);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    // Diagnosable means: which database, how long we waited, what mode it is
    // stuck in, and the original engine error — not a bare "failed".
    expect(thrown!.message).toContain('/tmp/project/.moflo/moflo.db');
    expect(thrown!.message).toContain('journal_mode');
    expect(thrown!.message).toContain('delete');
    expect(thrown!.message).toContain('database is locked');
    expect(thrown!.cause).toBeInstanceOf(Error);
  });

  it('bounds the wait at the budget rather than retrying forever', () => {
    const db = fakeDb({ busyCount: Number.MAX_SAFE_INTEGER, mode: 'delete' });
    const before = Date.now();
    expect(() => setWal(db, '/tmp/moflo.db', 60)).toThrow();
    // Generous upper bound: the assertion under test is termination, not
    // timer precision — a CI runner's scheduler can oversleep every nap.
    expect(Date.now() - before).toBeLessThan(5000);
  });

  it('narrows the busy budget for the post-exhaustion probe and restores it', () => {
    // The query form of `PRAGMA journal_mode` takes a shared lock and IS
    // covered by the busy handler, so left alone it would inherit the open
    // path's 15s budget and double the worst-case wait — on the one path
    // where we have already decided to give up. Narrow it, then put it back:
    // a caller that survives the probe keeps the connection it asked for.
    const db = fakeDb({ busyCount: Number.MAX_SAFE_INTEGER, mode: 'wal' });
    setWal(db, '/tmp/moflo.db', 40);
    const budgets = db.state.sqls.filter((sql) => /busy_timeout/.test(sql));
    expect(budgets[0]).toContain('500');
    expect(budgets[budgets.length - 1]).toContain('15000');
  });

  it('retries the probe before declaring the mode unreadable', () => {
    // A probe that loses one more race is not evidence the conversion failed.
    const db = fakeDb({ busyCount: Number.MAX_SAFE_INTEGER, probeThrows: true });
    expect(() => setWal(db, '/tmp/moflo.db', 40)).toThrow(/unreadable/);
    expect(db.state.probeCalls).toBe(3);
  });

  it('rethrows a non-contention error immediately without spending the budget', () => {
    // A corrupt file or a read-only mount will not clear by waiting. Burning
    // 15s before reporting it would turn a clear failure into a hang.
    const corrupt = Object.assign(new Error('file is not a database'), { errcode: 26 });
    const db = fakeDb({ busyCount: Number.MAX_SAFE_INTEGER, error: corrupt });
    expect(() => setWal(db, '/tmp/moflo.db')).toThrow('file is not a database');
    expect(db.state.execCalls).toBe(1);
  });
});
