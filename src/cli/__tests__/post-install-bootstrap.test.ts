/**
 * Postinstall bootstrap stuck-state simulation (#857).
 *
 * Recreates the failure scenario this script exists to fix:
 *   1. Consumer with `<root>/.claude/scripts/session-start-launcher.mjs`
 *      from a pre-#854 build (silent-catch sync, can't self-replace).
 *   2. Consumer with `<root>/.claude/helpers/gate.cjs` from a stale build.
 *
 * After bootstrap runs (driven by npm at install time, NOT by the broken
 * launcher), the mirror should match the shipped `bin/` content exactly.
 *
 * Also validates:
 *   - Skips silently when consumer has no `.claude/` (first-time install).
 *   - No-op when invoked against the moflo repo itself (avoid copying
 *     bin/ files onto themselves).
 *   - Surfaces transient-error failures via the stderr log.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { findRepoRoot } from './_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const BIN_DIR = join(REPO_ROOT, 'bin');

async function loadBootstrap() {
  const url = new URL(
    `file:///${join(REPO_ROOT, 'scripts/post-install-bootstrap.mjs').replace(/\\/g, '/').replace(/^\/+/, '')}`,
  ).href;
  return import(/* @vite-ignore */ url);
}

function makeTempConsumer(): string {
  return mkdtempSync(join(tmpdir(), 'moflo-bootstrap-'));
}

describe('post-install-bootstrap (#857) — stuck-state recovery', () => {
  let TMP: string;
  const STALE_LAUNCHER = '// STALE PRE-#854 LAUNCHER (silent-catch sync)\n';
  const STALE_GATE = '// STALE GATE\n';

  beforeAll(() => {
    TMP = makeTempConsumer();
    const scripts = join(TMP, '.claude/scripts');
    const helpers = join(TMP, '.claude/helpers');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(helpers, { recursive: true });
    writeFileSync(join(scripts, 'session-start-launcher.mjs'), STALE_LAUNCHER);
    writeFileSync(join(helpers, 'gate.cjs'), STALE_GATE);
  });

  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('replaces stale launcher with shipped one', async () => {
    const { runBootstrap } = await loadBootstrap();
    const result = await runBootstrap({ projectRoot: TMP, mofloRoot: REPO_ROOT, log: () => {} });
    expect(result.ran).toBe(true);
    expect(result.failed).toBe(0);

    const consumerLauncher = readFileSync(
      join(TMP, '.claude/scripts/session-start-launcher.mjs'),
      'utf-8',
    );
    const shipped = readFileSync(join(BIN_DIR, 'session-start-launcher.mjs'), 'utf-8');
    expect(consumerLauncher).toBe(shipped);
    expect(consumerLauncher).not.toContain('STALE PRE-#854');
  });

  it('replaces stale gate.cjs with shipped one', () => {
    const consumerGate = readFileSync(join(TMP, '.claude/helpers/gate.cjs'), 'utf-8');
    const shipped = readFileSync(join(BIN_DIR, 'gate.cjs'), 'utf-8');
    expect(consumerGate).toBe(shipped);
    expect(consumerGate).not.toContain('STALE GATE');
  });

  it('lands lib/process-manager.mjs in mirror (recursive copy)', () => {
    expect(existsSync(join(TMP, '.claude/scripts/lib/process-manager.mjs'))).toBe(true);
  });

  it('lands source-only helpers (.claude/helpers/) in mirror', () => {
    expect(existsSync(join(TMP, '.claude/helpers/auto-memory-hook.mjs'))).toBe(true);
    expect(existsSync(join(TMP, '.claude/helpers/statusline.cjs'))).toBe(true);
    expect(existsSync(join(TMP, '.claude/helpers/intelligence.cjs'))).toBe(true);
  });

  it('lands migrations subtree if present', () => {
    // bin/migrations/lib/markers.mjs is a known recursive entry — proves the
    // recursive walk works (#777 regression).
    const expected = join(TMP, '.claude/scripts/migrations/lib/markers.mjs');
    if (existsSync(join(BIN_DIR, 'migrations/lib/markers.mjs'))) {
      expect(existsSync(expected)).toBe(true);
    }
  });
});

describe('post-install-bootstrap (#975) — resilient copy + sentinel', () => {
  it('hash-skip: byte-identical dest is not rewritten', async () => {
    const tmp = makeTempConsumer();
    try {
      const scripts = join(tmp, '.claude/scripts');
      mkdirSync(scripts, { recursive: true });
      // Pre-populate launcher dest with EXACT shipped content so the bootstrap's
      // hash-equal check should short-circuit the write entirely.
      const shipped = readFileSync(join(BIN_DIR, 'session-start-launcher.mjs'), 'utf-8');
      const destPath = join(scripts, 'session-start-launcher.mjs');
      writeFileSync(destPath, shipped);
      // Capture mtime, sleep enough to detect a write, then run.
      const beforeMtime = statSync(destPath).mtimeMs;
      await new Promise((r) => setTimeout(r, 25));
      const { runBootstrap } = await loadBootstrap();
      const result = await runBootstrap({ projectRoot: tmp, mofloRoot: REPO_ROOT, log: () => {} });
      expect(result.ran).toBe(true);
      const afterMtime = statSync(destPath).mtimeMs;
      // If hash-skip is working, mtime is unchanged. If the launcher was
      // rewritten despite identical content, mtime would advance.
      expect(afterMtime).toBe(beforeMtime);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does NOT write sentinel when bootstrap completes with zero failures', async () => {
    const tmp = makeTempConsumer();
    try {
      mkdirSync(join(tmp, '.claude/scripts'), { recursive: true });
      mkdirSync(join(tmp, '.claude/helpers'), { recursive: true });
      const { runBootstrap } = await loadBootstrap();
      const result = await runBootstrap({ projectRoot: tmp, mofloRoot: REPO_ROOT, log: () => {} });
      expect(result.failed).toBe(0);
      expect(existsSync(join(tmp, '.moflo/bootstrap-failed.json'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('writes sentinel with expected shape when a copy fails', async () => {
    const tmp = makeTempConsumer();
    try {
      mkdirSync(join(tmp, '.claude/scripts'), { recursive: true });
      mkdirSync(join(tmp, '.claude/helpers'), { recursive: true });
      // Force one copy to fail by pre-creating gate.cjs's destination as a
      // DIRECTORY — atomicCopy's rename(tmp, dest) cannot replace a directory
      // with a file on any platform. Other files still copy fine, so we get a
      // partial-failure scenario which is exactly what the sentinel exists for.
      mkdirSync(join(tmp, '.claude/helpers/gate.cjs'));
      const { runBootstrap } = await loadBootstrap();
      const result = await runBootstrap({ projectRoot: tmp, mofloRoot: REPO_ROOT, log: () => {} });
      expect(result.ran).toBe(true);
      expect(result.failed).toBeGreaterThan(0);

      const sentinelPath = join(tmp, '.moflo/bootstrap-failed.json');
      expect(existsSync(sentinelPath)).toBe(true);
      const sentinel = JSON.parse(readFileSync(sentinelPath, 'utf-8'));
      expect(typeof sentinel.timestamp).toBe('string');
      expect(typeof sentinel.mofloVersion).toBe('string');
      expect(Array.isArray(sentinel.failures)).toBe(true);
      expect(sentinel.failures.length).toBeGreaterThan(0);
      // Each failure entry includes enough info for session-start to verify.
      for (const f of sentinel.failures) {
        expect(typeof f.key).toBe('string');
        expect(typeof f.message).toBe('string');
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('post-install-bootstrap (#857) — gating', () => {
  it('skips silently when consumer has no .claude/ directory', async () => {
    const tmp = makeTempConsumer();
    try {
      const { runBootstrap } = await loadBootstrap();
      const result = await runBootstrap({ projectRoot: tmp, mofloRoot: REPO_ROOT, log: () => {} });
      expect(result.ran).toBe(false);
      expect(result.reason).toBe('no-claude-dir');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('no-ops on moflo self-install (does not copy bin/ files onto themselves)', async () => {
    const { runBootstrap } = await loadBootstrap();
    const result = await runBootstrap({ projectRoot: REPO_ROOT, mofloRoot: REPO_ROOT, log: () => {} });
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('moflo-self-install');
  });

  it('skips silently when bin/ is missing from mofloRoot', async () => {
    const tmp = makeTempConsumer();
    try {
      const { runBootstrap } = await loadBootstrap();
      mkdirSync(join(tmp, '.claude'), { recursive: true });
      // Point mofloRoot at a dir with no bin/
      const fakeMofloRoot = mkdtempSync(join(tmpdir(), 'moflo-fake-'));
      try {
        const result = await runBootstrap({
          projectRoot: tmp,
          mofloRoot: fakeMofloRoot,
          log: () => {},
        });
        expect(result.ran).toBe(false);
        expect(result.reason).toBe('no-bin-dir');
      } finally {
        rmSync(fakeMofloRoot, { recursive: true, force: true });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
