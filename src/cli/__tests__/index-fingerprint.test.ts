/**
 * Fingerprint gate tests for the session-start indexer chain.
 *
 * The chain pegs CPU when run unconditionally on every session-start (the
 * "full reindex on every login" antipattern). The gate prevents that by
 * skipping when none of the load-bearing inputs have changed.
 *
 * These tests construct synthetic consumer trees and assert each scenario:
 *   - Fresh install (no fingerprint)        → run
 *   - Unchanged                              → skip
 *   - memory.db touched                      → run
 *   - .claude/guidance/ file edited          → run
 *   - moflo upgrade (node_modules pkg)       → run
 *   - moflo.yaml edited                      → run
 *   - FLO_FORCE_INDEX env override           → run
 *   - Corrupt fingerprint file               → run (safe fallback)
 *   - Saved fingerprint version mismatch     → run (graceful invalidation)
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findRepoRoot } from './_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);

// Dynamic import — the module is .mjs in bin/lib/, vitest can resolve it
// via file URL.
async function loadGate() {
  const url = new URL(
    `file:///${join(REPO_ROOT, 'bin/lib/index-fingerprint.mjs').replace(/\\/g, '/').replace(/^\/+/, '')}`,
  ).href;
  return import(/* @vite-ignore */ url);
}

interface ConsumerTree {
  root: string;
  memoryDb: string;
  mofloPkg: string;
  mofloYaml: string;
  guidanceFile: string;
}

function makeConsumer(): ConsumerTree {
  const root = mkdtempSync(join(tmpdir(), 'moflo-fp-'));

  const memoryDb = join(root, '.moflo/moflo.db');
  const mofloPkg = join(root, 'node_modules/moflo/package.json');
  const mofloYaml = join(root, 'moflo.yaml');
  const guidanceFile = join(root, '.claude/guidance/sample.md');

  mkdirSync(join(root, '.moflo'), { recursive: true });
  mkdirSync(join(root, 'node_modules/moflo'), { recursive: true });
  mkdirSync(join(root, '.claude/guidance'), { recursive: true });

  writeFileSync(memoryDb, 'fake-sqlite');
  writeFileSync(mofloPkg, JSON.stringify({ name: 'moflo', version: '4.9.6' }));
  writeFileSync(mofloYaml, 'auto_index:\n  guidance: true\n');
  writeFileSync(guidanceFile, '# sample\n');

  return { root, memoryDb, mofloPkg, mofloYaml, guidanceFile };
}

function bumpMtime(path: string, secondsAhead = 5) {
  const future = new Date(Date.now() + secondsAhead * 1000);
  utimesSync(path, future, future);
}

describe('index-fingerprint — session-start gate', () => {
  let tree: ConsumerTree;

  beforeEach(() => {
    tree = makeConsumer();
  });

  afterEach(() => {
    rmSync(tree.root, { recursive: true, force: true });
  });

  it('runs the chain on a fresh consumer (no saved fingerprint)', async () => {
    const { decideIndexGate } = await loadGate();
    const decision = decideIndexGate(tree.root, {});
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe('no-saved-fingerprint');
    expect(decision.current).toBeDefined();
  });

  it('skips when fingerprint matches (back-to-back runs)', async () => {
    const { decideIndexGate, saveFingerprint } = await loadGate();
    const first = decideIndexGate(tree.root, {});
    saveFingerprint(tree.root, first.current);

    const second = decideIndexGate(tree.root, {});
    expect(second.skip).toBe(true);
    expect(second.reason).toBe('unchanged');
  });

  it('runs when memory.db mtime changes', async () => {
    const { decideIndexGate, saveFingerprint } = await loadGate();
    const first = decideIndexGate(tree.root, {});
    saveFingerprint(tree.root, first.current);

    bumpMtime(tree.memoryDb);

    const decision = decideIndexGate(tree.root, {});
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe('inputs-changed');
  });

  it('runs when a .claude/guidance/ file is edited', async () => {
    const { decideIndexGate, saveFingerprint } = await loadGate();
    const first = decideIndexGate(tree.root, {});
    saveFingerprint(tree.root, first.current);

    bumpMtime(tree.guidanceFile);

    const decision = decideIndexGate(tree.root, {});
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe('inputs-changed');
  });

  it('runs when node_modules/moflo/package.json bumps (upgrade)', async () => {
    const { decideIndexGate, saveFingerprint } = await loadGate();
    const first = decideIndexGate(tree.root, {});
    saveFingerprint(tree.root, first.current);

    bumpMtime(tree.mofloPkg);

    const decision = decideIndexGate(tree.root, {});
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe('inputs-changed');
  });

  it('runs when moflo.yaml is edited', async () => {
    const { decideIndexGate, saveFingerprint } = await loadGate();
    const first = decideIndexGate(tree.root, {});
    saveFingerprint(tree.root, first.current);

    bumpMtime(tree.mofloYaml);

    const decision = decideIndexGate(tree.root, {});
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe('inputs-changed');
  });

  it('runs when FLO_FORCE_INDEX env is set, even with matching fingerprint', async () => {
    const { decideIndexGate, saveFingerprint } = await loadGate();
    const first = decideIndexGate(tree.root, {});
    saveFingerprint(tree.root, first.current);

    const decision = decideIndexGate(tree.root, { FLO_FORCE_INDEX: '1' });
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe('forced');
  });

  it('runs (safe fallback) when fingerprint file is corrupt JSON', async () => {
    const { decideIndexGate } = await loadGate();
    writeFileSync(join(tree.root, '.moflo/index-all-fingerprint.json'), '{not valid json');
    const decision = decideIndexGate(tree.root, {});
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe('no-saved-fingerprint');
  });

  it('runs when saved fingerprint version is older than current FINGERPRINT_VERSION', async () => {
    const { decideIndexGate, FINGERPRINT_VERSION } = await loadGate();
    writeFileSync(
      join(tree.root, '.moflo/index-all-fingerprint.json'),
      JSON.stringify({ version: FINGERPRINT_VERSION - 1, savedAt: '', fingerprint: {} }),
    );
    const decision = decideIndexGate(tree.root, {});
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe('no-saved-fingerprint');
  });

  it('saveFingerprint persists a versioned payload that round-trips', async () => {
    const { computeFingerprint, saveFingerprint, readSavedFingerprint, FINGERPRINT_VERSION } = await loadGate();
    const fp = computeFingerprint(tree.root);
    expect(saveFingerprint(tree.root, fp)).toBe(true);
    const round = readSavedFingerprint(tree.root);
    expect(round).toEqual(fp);

    // Corrupted version → null
    writeFileSync(
      join(tree.root, '.moflo/index-all-fingerprint.json'),
      JSON.stringify({ version: FINGERPRINT_VERSION + 1, fingerprint: fp }),
    );
    expect(readSavedFingerprint(tree.root)).toBeNull();
  });

  it('fingerprintsEqual returns false on null inputs (forces a run)', async () => {
    const { fingerprintsEqual, computeFingerprint } = await loadGate();
    const fp = computeFingerprint(tree.root);
    expect(fingerprintsEqual(null, fp)).toBe(false);
    expect(fingerprintsEqual(fp, null)).toBe(false);
    expect(fingerprintsEqual(null, null)).toBe(false);
  });
});
