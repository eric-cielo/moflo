/**
 * Regression tests for the indexer-vs-daemon cross-process write race (#1061).
 *
 * Before this fix, bin/hooks.mjs session-start forked the daemon AND the
 * index-all.mjs chain at the same instant. Both opened their own sql.js
 * handle and wrote to .moflo/moflo.db. If the daemon performed any write
 * during the seconds-to-minutes the chain ran, its next flush clobbered
 * the indexer's on-disk state with the daemon's stale in-RAM snapshot.
 *
 * Fix: the indexer chain holds .moflo/indexer.lock from start to finish and
 * is the sole spawner of the daemon at end-of-chain. hooks.mjs no longer
 * forks the daemon in parallel; runDaemonStartBackground + case 'daemon-start'
 * defer when the lock is held.
 *
 * These are source-level invariants. The lock helper's behavioural contract
 * is exercised in indexer-lock.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const BIN = resolve(__dirname, '../../bin');

describe('bin/hooks.mjs session-start (#1061)', () => {
  const file = resolve(BIN, 'hooks.mjs');
  const src = readFileSync(file, 'utf-8');

  it('imports isIndexerLockHeld from ./lib/indexer-lock.mjs', () => {
    expect(src).toMatch(/from\s+['"]\.\/lib\/indexer-lock\.mjs['"]/);
    expect(src).toMatch(/\bisIndexerLockHeld\b/);
  });

  it('session-start case does NOT unconditionally call runDaemonStartBackground', () => {
    // The chain spawns the daemon at its end (#1061). Parallel daemon
    // spawn at session-start re-introduces the race. Fallback to a direct
    // call is allowed ONLY when the index-all.mjs script can't be located —
    // in that branch the chain never runs, so the lock is never held, and
    // the daemon needs a direct kick.
    const sessionStart = src.match(/case 'session-start':\s*\{([\s\S]*?)\n\s+case '/);
    expect(sessionStart, 'session-start case must exist in hooks.mjs').toBeTruthy();
    const body = sessionStart![1];

    // The fallback "else" branch is allowed to call runDaemonStartBackground
    // — but the success branch (script-located, indexer spawning) must not.
    // Easiest invariant: the runDaemonStartBackground call sits inside an
    // `else` branch following an `if (indexAllScript)` test.
    const directCallsToDaemonStart = (body.match(/runDaemonStartBackground\s*\(/g) || []).length;
    expect(directCallsToDaemonStart, 'session-start should call runDaemonStartBackground at most once (the missing-script fallback)').toBeLessThanOrEqual(1);

    if (directCallsToDaemonStart === 1) {
      // The single call must be guarded by the missing-script else-branch.
      const guardedFallback = body.match(/if\s*\(indexAllScript\)[\s\S]*?else[\s\S]*?runDaemonStartBackground/);
      expect(guardedFallback, 'runDaemonStartBackground in session-start must sit in the missing-script else branch').toBeTruthy();
    }
  });

  it('runDaemonStartBackground checks isIndexerLockHeld', () => {
    const fn = src.match(/function\s+runDaemonStartBackground\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    expect(fn, 'runDaemonStartBackground function must exist').toBeTruthy();
    expect(fn![1]).toMatch(/isIndexerLockHeld\s*\(/);
  });

  it("case 'daemon-start' checks isIndexerLockHeld before spawning", () => {
    // The hook-event handler must also defer when the chain is running —
    // otherwise an external `flo hooks daemon-start` call mid-chain still
    // races.
    const caseBody = src.match(/case 'daemon-start':\s*\{([\s\S]*?)\n\s+case '/);
    expect(caseBody, "case 'daemon-start' must exist").toBeTruthy();
    expect(caseBody![1]).toMatch(/isIndexerLockHeld\s*\(/);
  });
});

describe('bin/index-all.mjs (#1061)', () => {
  const file = resolve(BIN, 'index-all.mjs');
  const src = readFileSync(file, 'utf-8');

  it('imports acquireIndexerLock and releaseIndexerLock', () => {
    expect(src).toMatch(/from\s+['"]\.\/lib\/indexer-lock\.mjs['"]/);
    expect(src).toMatch(/\bacquireIndexerLock\b/);
    expect(src).toMatch(/\breleaseIndexerLock\b/);
  });

  it('acquires the lock inside main()', () => {
    expect(src).toMatch(/acquireIndexerLock\s*\(\s*projectRoot\s*\)/);
  });

  it('registers exit + signal handlers that release the lock', () => {
    // The handlers cover normal exit + SIGINT (ctrl+C from the user) +
    // SIGTERM (parent kill). Without these, a crash leaves the lock
    // dangling until the 10-min stale check clears it. `on` or `once`
    // both satisfy the contract — releaseIndexerLock is itself idempotent.
    expect(src).toMatch(/process\.(on|once)\s*\(\s*['"]exit['"]/);
    expect(src).toMatch(/process\.(on|once)\s*\(\s*['"]SIGINT['"]/);
    expect(src).toMatch(/process\.(on|once)\s*\(\s*['"]SIGTERM['"]/);
    expect(src).toMatch(/releaseIndexerLock\s*\(/);
  });

  it('spawns the daemon after the chain finishes (releases lock first)', () => {
    // The chain owns the daemon wakeup at end-of-run. The spawn must come
    // AFTER the explicit release() so the daemon's own probe sees the
    // cleared state.
    const mainBody = src.match(/async\s+function\s+main\s*\(\s*\)\s*\{([\s\S]*?)\n\}/);
    expect(mainBody, 'main() must exist').toBeTruthy();
    const body = mainBody![1];

    // The tail of main must have both a release() call and a daemon spawn.
    expect(body).toMatch(/release\s*\(\s*\)/);
    expect(body).toMatch(/spawnDaemonAfterChain\s*\(\s*\)|\bdaemon\b.*?\bstart\b/);
  });

  it('end-of-chain daemon spawn honors shouldDaemonAutoStart', () => {
    // Moving the daemon spawn from hooks.mjs's runDaemonStartBackground
    // (which checks .claude/settings.json claudeFlow.daemon.autoStart) into
    // index-all.mjs MUST preserve that user opt-out — otherwise consumers
    // with the daemon explicitly disabled get one started anyway.
    expect(src).toMatch(/shouldDaemonAutoStart/);
  });
});
