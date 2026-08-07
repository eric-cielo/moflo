/**
 * End-to-end: the launcher never reports a still-shipped path as a retained
 * customized retired file (#1414).
 *
 * `tests/bin/launcher-948-retired-prune.test.ts` covers the helper in isolation.
 * That is not enough here — the defect being fixed was never in the helper's
 * logic, it was in what the launcher *hands* the helper. Passing the package
 * root is a call-site change, and a call-site change is only verifiable by
 * running the call site. So this spawns `bin/session-start-launcher.mjs` against
 * a staged consumer project, exactly as Claude Code's SessionStart hook does.
 *
 * The staged project reproduces the reported state: `retired-files.json` names
 * `.claude/agents/core/coder.md`, whose recorded hashes are the pre-deletion
 * content, while both the package and the consumer hold the restored content.
 *
 * Every assertion here is paired with a **negative control** — a genuinely
 * retired path that must still be pruned in the same run. Without it, a session
 * where Mechanism B never executed at all would satisfy "no retention banner"
 * and the test would be worthless.
 *
 * The temp-root / spawn helpers below are deliberately local rather than shared.
 * Seven launcher test files already carry their own copies; extracting a common
 * harness is worth doing, but as its own change — not folded into a fix that
 * touches the session-start hot path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import { resolve, join, dirname } from 'path';

const LAUNCHER = resolve(__dirname, '../../bin/session-start-launcher.mjs');

/** Restored under the same name after an alpha-era retirement — the #1414 shape. */
const RESTORED = join('.claude', 'agents', 'core', 'coder.md');
/** Deleted and never brought back — the control that proves Mechanism B ran. */
const RETIRED = join('.claude', 'agents', 'v3', 'genuinely-retired.md');

const PRE_DELETION_CONTENT = '# coder\n\nthe content that shipped before the alpha-era deletion\n';
const RESTORED_CONTENT = '# coder\n\nthe content moflo ships today\n';
const RETIRED_CONTENT = '# a real retirement\n';

function sha256Of(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

function makeTempRoot(): string {
  const root = resolve(
    __dirname,
    '../../.testoutput/.test-1414-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(root, { recursive: true });
  // package.json is the project-root marker the launcher walks up to find.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'launcher-1414-test', version: '0.0.0' }));
  return root;
}

function cleanTempRoot(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold handles */ }
}

function writeAt(root: string, rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function runLauncher(cwd: string): { stdout: string; stderr: string; status: number | null } {
  // CLAUDE_PROJECT_DIR anchors the unified findProjectRoot (#1057); without it
  // the walk-up skips the temp root's bare package.json and lands on moflo's
  // own repo. Production Claude Code always sets it.
  const result = spawnSync('node', [LAUNCHER], {
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

/**
 * Stage a consumer mid-upgrade (stamp 9.9.8 → package 9.9.9) so the launcher
 * enters the branch that owns Mechanism B.
 *
 * `packageShipsRestored` is the single variable under test: when true the
 * package still carries `RESTORED`, which is the contradiction; when false the
 * same manifest entry describes a real retirement and must behave as it always
 * has. Holding everything else fixed is what makes the pair a controlled
 * comparison rather than two unrelated scenarios.
 */
function stageProject(root: string, packageShipsRestored: boolean) {
  const pkgRoot = join(root, 'node_modules', 'moflo');
  mkdirSync(pkgRoot, { recursive: true });
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'moflo', version: '9.9.9' }));
  mkdirSync(join(root, '.moflo'), { recursive: true });
  writeFileSync(join(root, '.moflo', 'moflo-version'), '9.9.8');

  writeFileSync(join(pkgRoot, 'retired-files.json'), JSON.stringify({
    version: 1,
    retired: [
      // Hashes predate the restoration — the state that produced the false
      // "customized" verdict on every consumer.
      { path: RESTORED.replace(/\\/g, '/'), retiredIn: '2.0.0-alpha.121', knownContentHashes: [sha256Of(PRE_DELETION_CONTENT)] },
      { path: RETIRED.replace(/\\/g, '/'), retiredIn: '4.9.22', knownContentHashes: [sha256Of(RETIRED_CONTENT)] },
    ],
  }));

  if (packageShipsRestored) writeAt(pkgRoot, RESTORED, RESTORED_CONTENT);

  // Consumer-side copies. `RESTORED` holds today's shipped content, so it
  // matches no recorded hash; `RETIRED` matches its recorded hash exactly.
  writeAt(root, RESTORED, RESTORED_CONTENT);
  writeAt(root, RETIRED, RETIRED_CONTENT);
}

const RETENTION_BANNER = /retained \d+ customized retired file/;

describe('session-start launcher — still-shipped retirement entries (#1414)', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('leaves a still-shipped path alone and prints no retention banner', () => {
    stageProject(root, true);

    // An affected consumer does not arrive clean — a previous session already
    // wrote a record naming these files under a reason that was never true.
    // Asserting only "no record is created" would miss the case that actually
    // matters: the stale one has to go.
    const recordPath = join(root, '.moflo', 'retired-retained.json');
    writeFileSync(recordPath, JSON.stringify({
      version: 1,
      mofloVersion: '9.9.8',
      retained: [{ path: RESTORED.replace(/\\/g, '/'), retiredIn: '2.0.0-alpha.121' }],
    }));
    expect(existsSync(recordPath), 'precondition: the stale record must exist before the run').toBe(true);

    const { stdout, status } = runLauncher(root);
    expect(status, `launcher exited non-zero:\n${stdout}`).toBe(0);

    // Negative control first: if this fails, Mechanism B did not run and every
    // other assertion below is vacuous.
    expect(
      existsSync(join(root, RETIRED)),
      'genuinely-retired file survived — Mechanism B never executed, so this test proves nothing',
    ).toBe(false);

    expect(existsSync(join(root, RESTORED)), 'still-shipped agent was deleted').toBe(true);
    expect(stdout).not.toMatch(RETENTION_BANNER);
    expect(
      existsSync(recordPath),
      'the stale retained record survived — a consumer would keep being told these files are customized',
    ).toBe(false);
  });

  it('still reports a genuine retention when the package really dropped the path', () => {
    // Same manifest, same consumer files — only the package copy is withheld.
    // Proves the fix discriminates on what the package ships rather than
    // suppressing the retention path wholesale.
    stageProject(root, false);

    const { stdout, status } = runLauncher(root);
    expect(status, `launcher exited non-zero:\n${stdout}`).toBe(0);

    expect(existsSync(join(root, RETIRED))).toBe(false);
    expect(existsSync(join(root, RESTORED)), 'customized retired file must be preserved').toBe(true);
    expect(stdout).toMatch(RETENTION_BANNER);
    expect(existsSync(join(root, '.moflo', 'retired-retained.json'))).toBe(true);
  });
});
