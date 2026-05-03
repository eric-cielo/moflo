/**
 * Regression tests for issue #860 — session-start launcher must early-exit
 * when invoked from a daemon-spawned headless Claude session.
 *
 * Symptoms in the wild (motailz/code, 2026-05-02): the daemon's headless
 * workers (optimize/testgaps/etc.) spawn `claude --print` with
 * CLAUDE_CODE_HEADLESS=true; each spawned Claude inherits SessionStart
 * hooks, which re-enter this launcher and fork the indexer chain →
 * `memory rebuild-index --force` pegs the box every 15 minutes on the
 * daemon's worker cycle. Without the early-exit guard, the loop is
 * unbreakable: the indexer run itself bumps memory.db mtime, which
 * invalidates the 4.9.7 fingerprint gate (#857) and guarantees the next
 * spawn re-runs the whole chain.
 *
 * This file mixes two coverage shapes:
 *   - Source-invariant guards (fast; pin the literal env-var check so a
 *     future refactor can't quietly remove it).
 *   - End-to-end spawn (slow; proves the launcher actually exits without
 *     touching .moflo/ or spawning children).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

const BIN = resolve(__dirname, '../../bin');
const LAUNCHER = resolve(BIN, 'session-start-launcher.mjs');

describe('bin/session-start-launcher.mjs — headless skip (#860)', () => {
  const src = readFileSync(LAUNCHER, 'utf-8');

  it('contains the CLAUDE_CODE_HEADLESS early-exit guard', () => {
    // Source-invariant: the literal env-var check + the process.exit(0)
    // must remain at the top of the launcher. Without this, daemon-spawned
    // headless Claude sessions trigger the upgrade-heal + indexer chain.
    expect(src).toMatch(/process\.env\.CLAUDE_CODE_HEADLESS\s*===\s*['"]true['"]/);
    expect(src).toMatch(/process\.env\.CLAUDE_CODE_HEADLESS\s*===\s*['"]1['"]/);
    expect(src).toMatch(/process\.exit\(0\)/);
  });

  it('places the guard before any sync/spawn work', () => {
    // The guard must run before any imports' side effects, manifest reads,
    // version-stamp comparisons, or child spawns — otherwise we'd still
    // mutate state on every headless invocation.
    const guardIdx = src.search(/process\.env\.CLAUDE_CODE_HEADLESS/);
    expect(guardIdx).toBeGreaterThan(0);

    // No manifest/version/indexer references between imports and the guard.
    const head = src.slice(0, guardIdx);
    expect(head).not.toMatch(/installed-files\.json/);
    expect(head).not.toMatch(/moflo-version/);
    expect(head).not.toMatch(/index-all\.mjs/);
  });

  it('emits a one-line stderr trace for diagnosability', () => {
    // The skip must not be silent — daemon worker logs capture stderr,
    // and "session-start-launcher skipped" is the trail that explains why
    // the indexer didn't fire when something downstream looks for it.
    expect(src).toMatch(/session-start-launcher skipped/);
    expect(src).toMatch(/CLAUDE_CODE_HEADLESS=true/);
  });
});

describe('bin/session-start-launcher.mjs — headless skip end-to-end (#860)', () => {
  // Each spawn runs against a throwaway project root so the launcher's
  // would-be writes to .moflo/, .claude/scripts/, etc. are observable
  // without touching the real repo. The headless-skip path must NOT touch
  // any of these, even on a never-initialized project tree.
  function makeProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'moflo-headless-skip-'));
    // Minimal package.json so findProjectRoot() in the launcher locates this dir
    writeFileSync(join(root, 'package.json'), '{"name":"tmp","version":"0.0.0"}');
    mkdirSync(join(root, '.moflo'), { recursive: true });
    mkdirSync(join(root, '.claude/scripts'), { recursive: true });
    return root;
  }

  function snapshotMoflo(root: string): string[] {
    try { return readdirSync(join(root, '.moflo')).sort(); } catch { return []; }
  }

  function runLauncher(env: NodeJS.ProcessEnv, root: string) {
    return spawnSync('node', [LAUNCHER], {
      cwd: root,
      env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf-8',
      timeout: 10_000,
    });
  }

  it('exits 0 fast with CLAUDE_CODE_HEADLESS=true and writes nothing', () => {
    const root = makeProject();
    try {
      const beforeFiles = snapshotMoflo(root);
      const start = Date.now();
      const result = runLauncher({ CLAUDE_CODE_HEADLESS: 'true' }, root);
      const elapsed = Date.now() - start;
      const afterFiles = snapshotMoflo(root);

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('session-start-launcher skipped');
      // Loose budget — node startup dominates; the guard itself is microseconds.
      expect(elapsed).toBeLessThan(3000);
      // No new files in .moflo/ — no manifest, no version stamp, no fingerprint.
      expect(afterFiles).toEqual(beforeFiles);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('honors CLAUDE_CODE_HEADLESS=1 (numeric form)', () => {
    const root = makeProject();
    try {
      const beforeFiles = snapshotMoflo(root);
      const result = runLauncher({ CLAUDE_CODE_HEADLESS: '1' }, root);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('session-start-launcher skipped');
      expect(snapshotMoflo(root)).toEqual(beforeFiles);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Negative-path coverage (CLAUDE_CODE_HEADLESS unset / =false) is left to
  // the source-invariant tests above — running the full launcher against a
  // tmp project root spawns detached, unrefed indexer children that race
  // rmSync cleanup on Windows.
});
