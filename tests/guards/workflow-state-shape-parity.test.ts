/**
 * Guard: every declaration of the `.claude/workflow-state.json` shape agrees
 * with the one that owns it (#1441).
 *
 * `bin/gate.cjs`'s `STATE_DEFAULTS` is canonical — it is the file consumers
 * actually run (pinned to the dogfood copy by gate-hook-parity-guard), and
 * `readState()` merges it over whatever it parses, which is what makes every
 * other reader's missing key invisible at runtime. That invisibility is the
 * problem: a second declaration can fall behind for months and nothing fails.
 *
 * It already had. The session-start launcher wrote a FOUR-field literal
 * (`tasksCreated`, `taskCount`, `memorySearched`, `sessionStart`) that had not
 * been touched as gate fields accumulated — #1441 replaced it, and this guard
 * is what stops the replacement rotting the same way.
 *
 * Keys AND values. A key-only check would pass while `memoryRequired` flipped
 * from `true` to `false` on one side — i.e. while a fresh session silently
 * stopped arming the memory gate, which is the exact class of bug #1441 was.
 *
 * NOT covered here, deliberately: `generateGateScript()` in
 * src/cli/init/helpers-generator.ts carries its own `STATE_DEFAULTS` for the
 * broken-npx-path fallback, and it is four keys behind. Those four keys are
 * #1348's credit fingerprints, and the fallback has none of #1348's logic
 * either — so pinning its key list here would turn this guard green over a gate
 * that still cannot invalidate a stale test credit. Tracked as #1443; fold it
 * in once the fallback carries the behaviour, not before.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(__dirname, '../..');
const BIN_GATE = join(REPO_ROOT, 'bin', 'gate.cjs');
const LAUNCHER = join(REPO_ROOT, 'bin', 'session-start-launcher.mjs');
const DOCTOR = join(REPO_ROOT, 'src', 'cli', 'commands', 'doctor-checks-deep.ts');

/**
 * The canonical defaults, read out of the artifact consumers run rather than
 * re-declared here — a third copy in the guard would be the very thing it
 * exists to prevent.
 */
function canonicalDefaults(): Record<string, unknown> {
  const source = readFileSync(BIN_GATE, 'utf-8');
  const match = source.match(/var STATE_DEFAULTS = (\{[\s\S]*?\});/);
  expect(match, 'STATE_DEFAULTS not found in bin/gate.cjs — update this guard').toBeTruthy();
  // Evaluating our own committed source, not input: the literal holds only
  // primitives, `{}` and `null`, and JSON.parse cannot read unquoted keys.
  return new Function(`return ${match![1]}`)() as Record<string, unknown>;
}

/** What the launcher actually writes for a fresh session, via a real spawn. */
function launcherFreshState(): Record<string, unknown> {
  // Fixture under os.tmpdir() and an explicit CLAUDE_PROJECT_DIR — see
  // tests/bin/launcher-state-leak.test.ts for why an un-anchored spawn resets
  // the developer's live session.
  const fixture = mkdtempSync(join(tmpdir(), 'moflo-state-shape-'));
  try {
    mkdirSync(join(fixture, '.claude'), { recursive: true });
    writeFileSync(
      join(fixture, 'package.json'),
      JSON.stringify({ name: 'state-shape-fixture', version: '0.0.0' }),
    );
    spawnSync('node', [LAUNCHER], {
      cwd: fixture,
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: fixture, CI: '1' },
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
    });
    return JSON.parse(readFileSync(join(fixture, '.claude', 'workflow-state.json'), 'utf-8'));
  } finally {
    try {
      rmSync(fixture, { recursive: true, force: true });
    } catch {
      /* Windows occasionally holds handles — non-fatal */
    }
  }
}

describe('#1441 workflow-state shape parity', () => {
  it('the launcher writes exactly gate.cjs STATE_DEFAULTS, keys and values', () => {
    const canonical = canonicalDefaults();
    const written = launcherFreshState();

    expect(
      Object.keys(written).sort(),
      'The launcher\'s fresh-session shape has drifted from gate.cjs STATE_DEFAULTS. ' +
        'Update freshWorkflowState() in bin/session-start-launcher.mjs §2 and re-sync ' +
        '.claude/scripts/session-start-launcher.mjs.',
    ).toEqual(Object.keys(canonical).sort());

    for (const [key, value] of Object.entries(canonical)) {
      // sessionStart is the one field a fresh session stamps rather than
      // defaults: null in STATE_DEFAULTS, an ISO timestamp on disk.
      if (key === 'sessionStart') {
        expect(typeof written[key], 'sessionStart must be stamped, not left null').toBe('string');
        continue;
      }
      expect(
        written[key],
        `Default for "${key}" differs between gate.cjs and the launcher. A fresh ` +
          'session must start in exactly the state the gates expect.',
      ).toEqual(value);
    }
  });

  it('the doctor gate-health check only asserts keys that exist', () => {
    // A stale key here reports "workflow-state.json missing keys" against a
    // perfectly healthy file, sending the user to fix nothing.
    const source = readFileSync(DOCTOR, 'utf-8');
    const match = source.match(/const expectedKeys = \[([^\]]*)\]/);
    expect(match, 'expectedKeys not found in doctor-checks-deep.ts — update this guard').toBeTruthy();
    const expectedKeys = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(expectedKeys.length).toBeGreaterThan(0);

    const canonicalKeys = Object.keys(canonicalDefaults());
    expect(
      expectedKeys.filter((k) => !canonicalKeys.includes(k)),
      'The doctor check requires keys gate.cjs no longer declares.',
    ).toEqual([]);
  });
});
