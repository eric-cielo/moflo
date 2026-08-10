/**
 * Guard: running the test suite must not rewrite the developer's own
 * `.claude/workflow-state.json`.
 *
 * `bin/session-start-launcher.mjs` §2 resets workflow state on every start,
 * writing the 4-field session-reset shape over whatever `resolveStateRoot()`
 * picks. That resolver treats an inherited `CLAUDE_PROJECT_DIR` as
 * authoritative, and Claude Code sets that variable to the developer's real
 * project root — which every `spawnSync(..., { env: { ...process.env } })` in
 * this suite then hands to the child. A launcher spawn that forgets its own
 * anchor therefore resets the LIVE session: `memorySearched`, `sessionId`,
 * `testsRun`, `simplifyRun` and the rest all revert mid-run, and the gates
 * start blocking work that was already credited.
 *
 * Reproduced before the fix: `launcher-visibility` + `launcher-854-fixes` were
 * enough to truncate this repo's state file to `{tasksCreated, taskCount,
 * memorySearched, sessionStart}`.
 *
 * Two things keep it shut, and this file proves the pair end to end:
 *   1. `vitest.setup.ts` deletes the ambient `CLAUDE_PROJECT_DIR`, so an
 *      un-anchored child cannot inherit a pointer to the real repo (CI never
 *      sets the variable, so this makes local runs match CI).
 *   2. Fixtures live under `os.tmpdir()`, so the fallback walk-up from the
 *      child's cwd cannot climb into the repo either. A fixture staged inside
 *      the repo (e.g. under `.testoutput/`) defeats (1) on its own — the walk
 *      finds the repo's `.moflo/moflo.db` above it.
 *
 * If this goes red, do NOT relax the assertion: find the spawn that lost its
 * anchor. The failure mode it catches is silent, and it corrupts state the
 * developer is actively relying on.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(__dirname, '../..');
const LAUNCHER = join(REPO_ROOT, 'bin', 'session-start-launcher.mjs');
const REPO_STATE = join(REPO_ROOT, '.claude', 'workflow-state.json');

/** Contents of the repo's own state file, or null when it has none. */
function snapshotRepoState(): string | null {
  try {
    return readFileSync(REPO_STATE, 'utf-8');
  } catch {
    return null;
  }
}

function restoreRepoState(snapshot: string | null): void {
  try {
    if (snapshot === null) {
      rmSync(REPO_STATE, { force: true });
    } else {
      mkdirSync(join(REPO_ROOT, '.claude'), { recursive: true });
      writeFileSync(REPO_STATE, snapshot);
    }
  } catch {
    /* best effort — the assertion below is what reports the leak */
  }
}

describe('session-start launcher: test spawns stay inside their fixture', () => {
  it('leaves the repo workflow-state.json untouched when spawned with no CLAUDE_PROJECT_DIR', () => {
    // Outside the repo on purpose — see (2) in the header.
    const fixture = mkdtempSync(join(tmpdir(), 'moflo-launcher-leak-'));
    writeFileSync(
      join(fixture, 'package.json'),
      JSON.stringify({ name: 'launcher-leak-fixture', version: '0.0.0' }),
    );

    const before = snapshotRepoState();
    let after: string | null;
    let fixtureWroteState: boolean;
    let stderr: string;

    try {
      // Deliberately un-anchored: `{ ...process.env }` and a cwd, exactly what
      // a call site that forgot its override looks like. The env must NOT gain
      // a CLAUDE_PROJECT_DIR here — that is the condition under test.
      const result = spawnSync(process.execPath, [LAUNCHER], {
        cwd: fixture,
        encoding: 'utf-8',
        timeout: 30_000,
        env: { ...process.env, CI: '1' },
        input: '',
      });
      after = snapshotRepoState();
      fixtureWroteState = existsSync(join(fixture, '.claude', 'workflow-state.json'));
      stderr = result.stderr || '';
    } finally {
      // Runs before either assertion below, so a red result still hands the
      // developer their session state back.
      restoreRepoState(before);
      rmSync(fixture, { recursive: true, force: true });
    }

    // The leak assertion comes FIRST. When the anchor is lost the launcher
    // resets the repo AND writes nothing to the fixture, so a vacuity check
    // ahead of it would fire first and blame an early exit for a leak.
    expect(
      after,
      `The launcher reset THIS repo's ${REPO_STATE} instead of its fixture. Some ` +
        `spawn is inheriting a CLAUDE_PROJECT_DIR that points at the real project — ` +
        `check that vitest.setup.ts still deletes it and that the spawn passes its ` +
        `own anchor. (The original contents have been restored.)`,
    ).toBe(before);

    // Not vacuous: the launcher has to have actually reached §2 and written a
    // state file somewhere, or "the repo file is unchanged" proves nothing.
    expect(
      fixtureWroteState,
      `Launcher wrote no state file in its fixture and left the repo alone — it ` +
        `probably exited early, which makes the leak assertion above vacuous. ` +
        `stderr: ${stderr}`,
    ).toBe(true);
  });
});
