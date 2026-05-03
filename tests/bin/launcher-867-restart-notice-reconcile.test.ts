/**
 * Regression tests for issue #867 — post-install restart notice files were
 * written by `scripts/post-install-notice.mjs` but never reconciled by the
 * SessionStart launcher, so `.moflo/restart-pending.json` and
 * `.moflo/last-install-banner.json` accumulated across upgrades and the
 * restart-required message was invisible to users who didn't have an
 * assistant remembering to surface it manually.
 *
 * Fix: section 0d of `bin/session-start-launcher.mjs` reads each file,
 * compares its `version` against the installed moflo version, and either
 * unlinks (already applied / stale) or re-emits the message (running bits
 * still older than the file → next restart still required).
 *
 * Source-invariant tests pin the structural fix into the launcher so a
 * future "simplification" can't silently regress it. Behavioural tests
 * spawn the actual launcher in an isolated temp project to verify the
 * file state end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve, join } from 'path';

const LAUNCHER = resolve(__dirname, '../../bin/session-start-launcher.mjs');

describe('bin/session-start-launcher.mjs §0d — reconcile post-install notice files (#867)', () => {
  const file = resolve(__dirname, '../../bin/session-start-launcher.mjs');
  const src = readFileSync(file, 'utf-8');

  it('declares section 0d with the #867 reference', () => {
    expect(src).toMatch(/0d\.\s*Reconcile post-install notice files\s*\(#867\)/);
  });

  it('reads restart-pending.json and last-install-banner.json from .moflo/', () => {
    expect(src).toMatch(/['"]restart-pending\.json['"]/);
    expect(src).toMatch(/['"]last-install-banner\.json['"]/);
  });

  it('compares the file version against installed moflo version (not literal equality on the string field)', () => {
    expect(src).toMatch(/compareSemverParts\s*\(/);
  });

  it('unlinks the notice on version match (cmp === 0 path)', () => {
    expect(src).toMatch(/cleared post-install restart notice/);
  });

  it('re-emits the message when running bits are older than the notice (cmp > 0 path)', () => {
    // The branch must write to stdout per-line so Claude additionalContext
    // shows it. A regression that quietly dropped this branch would leave
    // the file orphaned with no user-visible signal.
    expect(src).toMatch(/process\.stdout\.write\(`moflo:\s*\$\{line\}\\n`\)/);
  });

  it('runs BEFORE the section 4 hooks.mjs spawn so additionalContext reaches the user', () => {
    const idxSection0d = src.indexOf('Reconcile post-install notice files');
    const idxSection4 = src.indexOf('// ── 4. Spawn background tasks');
    expect(idxSection0d).toBeGreaterThan(-1);
    expect(idxSection4).toBeGreaterThan(-1);
    expect(idxSection0d).toBeLessThan(idxSection4);
  });

  it('routes failures through emitWarning, not bare catch (#854 posture)', () => {
    expect(src).toMatch(/emitWarning\(`post-install notice reconciliation failed/);
  });
});

describe('compareSemverParts — semver ordering (#867)', () => {
  // The helper is small enough to inline-extract via Function() for direct
  // unit coverage. Avoids spawning the full launcher just to test arithmetic.
  const file = resolve(__dirname, '../../bin/session-start-launcher.mjs');
  const src = readFileSync(file, 'utf-8');
  const fnMatch = src.match(/function\s+compareSemverParts\s*\([\s\S]*?\n\}/);
  if (!fnMatch) throw new Error('compareSemverParts not found in launcher source');
  // eslint-disable-next-line no-new-func
  const compareSemverParts = new Function(`${fnMatch[0]}; return compareSemverParts;`)() as (a: string, b: string) => number;

  it('returns 0 for equal versions', () => {
    expect(compareSemverParts('4.9.8', '4.9.8')).toBe(0);
  });

  it('returns -1 when first version is older', () => {
    expect(compareSemverParts('4.9.7', '4.9.8')).toBe(-1);
    expect(compareSemverParts('4.8.99', '4.9.0')).toBe(-1);
    expect(compareSemverParts('3.0.0', '4.0.0')).toBe(-1);
  });

  it('returns 1 when first version is newer', () => {
    expect(compareSemverParts('4.9.8', '4.9.7')).toBe(1);
    expect(compareSemverParts('4.10.0', '4.9.99')).toBe(1);
  });

  it('handles different segment counts (4.9 < 4.9.1)', () => {
    expect(compareSemverParts('4.9', '4.9.1')).toBe(-1);
    expect(compareSemverParts('4.9.1', '4.9')).toBe(1);
  });
});

describe('session-start-launcher behavioural — notice file reconciliation (#867)', () => {
  let root: string;

  beforeEach(() => {
    root = resolve(
      __dirname,
      '../../.testoutput/.test-launcher-867-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    );
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'launcher-867-test', version: '0.0.0' }));
    // Stage a node_modules/moflo/package.json so the launcher has an
    // installed version to compare against.
    mkdirSync(join(root, 'node_modules', 'moflo'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'moflo', 'package.json'),
      JSON.stringify({ name: 'moflo', version: '4.9.8' }),
    );
    mkdirSync(join(root, '.moflo'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows handle holds — non-fatal */ }
  });

  function runLauncher(): { stdout: string; stderr: string } {
    const result = spawnSync('node', [LAUNCHER], { cwd: root, encoding: 'utf-8', timeout: 30_000 });
    return { stdout: result.stdout || '', stderr: result.stderr || '' };
  }

  it('deletes restart-pending.json when its version matches installed moflo', () => {
    const noticePath = join(root, '.moflo', 'restart-pending.json');
    const trackerPath = join(root, '.moflo', 'last-install-banner.json');
    writeFileSync(noticePath, JSON.stringify({
      version: '4.9.8',
      writtenAt: new Date().toISOString(),
      message: 'MoFlo 4.9.8 installed.\n\nPlease restart Claude Code.',
    }));
    writeFileSync(trackerPath, JSON.stringify({ version: '4.9.8', shownAt: new Date().toISOString() }));

    const { stdout } = runLauncher();

    expect(existsSync(noticePath)).toBe(false);
    expect(existsSync(trackerPath)).toBe(false);
    expect(stdout).toMatch(/moflo: cleared post-install restart notice/);
  });

  it('deletes restart-pending.json when running version is newer than the notice (stale file)', () => {
    const noticePath = join(root, '.moflo', 'restart-pending.json');
    writeFileSync(noticePath, JSON.stringify({
      version: '4.9.0',
      writtenAt: new Date().toISOString(),
      message: 'old message',
    }));

    const { stdout } = runLauncher();

    expect(existsSync(noticePath)).toBe(false);
    // Pure-stale branch is silent — no per-line message re-emit.
    expect(stdout).not.toMatch(/MoFlo 4\.9\.0 installed/);
  });

  it('keeps restart-pending.json AND re-emits message when running version is older', () => {
    const noticePath = join(root, '.moflo', 'restart-pending.json');
    // Notice is for a future version (4.9.9) — running bits are 4.9.8.
    writeFileSync(noticePath, JSON.stringify({
      version: '4.9.9',
      writtenAt: new Date().toISOString(),
      message: 'MoFlo 4.9.9 installed.\n\nPlease restart Claude Code.',
    }));

    const { stdout } = runLauncher();

    expect(existsSync(noticePath)).toBe(true);
    expect(stdout).toMatch(/moflo: MoFlo 4\.9\.9 installed\./);
    expect(stdout).toMatch(/moflo: Please restart Claude Code\./);
  });

  it('removes a malformed restart-pending.json silently rather than leaving it forever', () => {
    const noticePath = join(root, '.moflo', 'restart-pending.json');
    writeFileSync(noticePath, '{ this is not json');

    runLauncher();

    expect(existsSync(noticePath)).toBe(false);
  });

  it('reconciles an orphan last-install-banner.json (no notice file)', () => {
    const trackerPath = join(root, '.moflo', 'last-install-banner.json');
    writeFileSync(trackerPath, JSON.stringify({ version: '4.9.7', shownAt: new Date().toISOString() }));

    runLauncher();

    expect(existsSync(trackerPath)).toBe(false);
  });

  it('is silent on the fast path (no notice files present)', () => {
    const { stdout } = runLauncher();
    expect(stdout).not.toMatch(/cleared post-install restart notice/);
  });
});
