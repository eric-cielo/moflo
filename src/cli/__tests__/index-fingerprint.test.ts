/**
 * Per-step fingerprint gate tests for the session-start indexer chain (#858).
 *
 * The 4.9.7 global gate fixed the CPU peg only when nothing changed. As soon
 * as memory.db mtime bumped (every memory_store call) the entire chain re-ran
 * — including pretrain + HNSW rebuild — even though only build-embeddings had
 * actual work. Per-step gates fix that: each step gates on its own inputs.
 *
 * Tests construct a synthetic consumer tree and assert each gate decision in
 * isolation. Step computers that depend on `git ls-files` stub git by setting
 * a non-repo cwd — the helper returns null, which the gate treats as
 * "input changed" (safe fallback).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findRepoRoot } from './_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);

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
  guidanceFile: string;
  hnswSidecar: string;
  packageLock: string;
}

function makeConsumer(): ConsumerTree {
  const root = mkdtempSync(join(tmpdir(), 'moflo-fp-step-'));

  const memoryDb = join(root, '.moflo/moflo.db');
  const mofloPkg = join(root, 'node_modules/moflo/package.json');
  const guidanceFile = join(root, '.claude/guidance/sample.md');
  const hnswSidecar = join(root, '.moflo/hnsw.index');
  const packageLock = join(root, 'package-lock.json');

  mkdirSync(join(root, '.moflo'), { recursive: true });
  mkdirSync(join(root, 'node_modules/moflo'), { recursive: true });
  mkdirSync(join(root, '.claude/guidance'), { recursive: true });

  writeFileSync(memoryDb, 'fake-sqlite');
  writeFileSync(mofloPkg, JSON.stringify({ name: 'moflo', version: '4.9.7' }));
  writeFileSync(guidanceFile, '# sample\n');
  // Lockfile drives the reference-index gate (library-docs grounding, #1184).
  writeFileSync(packageLock, JSON.stringify({ name: 'consumer', lockfileVersion: 3 }));

  return { root, memoryDb, mofloPkg, guidanceFile, hnswSidecar, packageLock };
}

function bumpMtime(path: string, secondsAhead = 5) {
  const future = new Date(Date.now() + secondsAhead * 1000);
  utimesSync(path, future, future);
}

// Steps whose fingerprint depends only on the filesystem, not on git ls-files.
// We can drive these deterministically in a temp dir.
const FS_ONLY_STEPS = ['guidance-index', 'reference-index', 'build-embeddings', 'hnsw-rebuild'] as const;

// Steps backed by git ls-files. In a fresh tmpdir the git call returns null,
// so the fingerprint object is `{ <key>: null }`. The gate still works:
// equality comparisons of the same null fingerprint match → skip.
const GIT_BACKED_STEPS = ['code-map', 'test-index', 'patterns-index', 'pretrain'] as const;

describe('index-fingerprint — per-step gate (#858)', () => {
  let tree: ConsumerTree;

  beforeEach(() => {
    tree = makeConsumer();
  });

  afterEach(() => {
    rmSync(tree.root, { recursive: true, force: true });
  });

  it('STEP_NAMES covers every computer registered (no orphans)', async () => {
    const { STEP_NAMES, computeStepFingerprint } = await loadGate();
    expect(STEP_NAMES).toEqual([
      'guidance-index', 'code-map', 'test-index', 'patterns-index',
      'reference-index', 'pretrain', 'build-embeddings', 'hnsw-rebuild',
    ]);
    // Every name resolves to a working computer (no missing entries).
    for (const name of STEP_NAMES) {
      expect(() => computeStepFingerprint(name, tree.root)).not.toThrow();
    }
  });

  it('rejects unknown step names with a clear error', async () => {
    const { computeStepFingerprint } = await loadGate();
    expect(() => computeStepFingerprint('not-a-step', tree.root)).toThrow(/Unknown step/);
  });

  describe.each(FS_ONLY_STEPS)('%s — fresh / unchanged / changed', (stepName) => {
    it(`runs on a fresh consumer (no saved fingerprint)`, async () => {
      const { decideStepGate } = await loadGate();
      const decision = decideStepGate(stepName, tree.root, {});
      expect(decision.skip).toBe(false);
      expect(decision.reason).toBe('no-saved-fingerprint');
    });

    it(`skips when fingerprint matches`, async () => {
      const { decideStepGate, computeStepFingerprint, saveStepFingerprint } = await loadGate();
      const fp = computeStepFingerprint(stepName, tree.root);
      saveStepFingerprint(stepName, tree.root, fp);
      const decision = decideStepGate(stepName, tree.root, {});
      expect(decision.skip).toBe(true);
      expect(decision.reason).toBe('unchanged');
    });

    it(`runs when FLO_FORCE_INDEX is set`, async () => {
      const { decideStepGate, computeStepFingerprint, saveStepFingerprint } = await loadGate();
      const fp = computeStepFingerprint(stepName, tree.root);
      saveStepFingerprint(stepName, tree.root, fp);
      const decision = decideStepGate(stepName, tree.root, { FLO_FORCE_INDEX: '1' });
      expect(decision.skip).toBe(false);
      expect(decision.reason).toBe('forced');
    });
  });

  it('guidance-index runs when .claude/guidance/* is touched', async () => {
    const { decideStepGate, computeStepFingerprint, saveStepFingerprint } = await loadGate();
    saveStepFingerprint('guidance-index', tree.root, computeStepFingerprint('guidance-index', tree.root));
    bumpMtime(tree.guidanceFile);
    const decision = decideStepGate('guidance-index', tree.root, {});
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe('inputs-changed');
  });

  it('guidance-index runs after a moflo upgrade (package.json bump)', async () => {
    const { decideStepGate, computeStepFingerprint, saveStepFingerprint } = await loadGate();
    saveStepFingerprint('guidance-index', tree.root, computeStepFingerprint('guidance-index', tree.root));
    bumpMtime(tree.mofloPkg);
    const decision = decideStepGate('guidance-index', tree.root, {});
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe('inputs-changed');
  });

  it('build-embeddings runs when memory.db mtime bumps', async () => {
    const { decideStepGate, computeStepFingerprint, saveStepFingerprint } = await loadGate();
    saveStepFingerprint('build-embeddings', tree.root, computeStepFingerprint('build-embeddings', tree.root));
    bumpMtime(tree.memoryDb);
    const decision = decideStepGate('build-embeddings', tree.root, {});
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe('inputs-changed');
  });

  it('build-embeddings does NOT run on guidance edits — the key #858 win', async () => {
    const { decideStepGate, computeStepFingerprint, saveStepFingerprint } = await loadGate();
    saveStepFingerprint('build-embeddings', tree.root, computeStepFingerprint('build-embeddings', tree.root));
    bumpMtime(tree.guidanceFile);
    const decision = decideStepGate('build-embeddings', tree.root, {});
    expect(decision.skip).toBe(true);
  });

  it('reference-index runs when the lockfile changes (a dep install/upgrade)', async () => {
    const { decideStepGate, computeStepFingerprint, saveStepFingerprint } = await loadGate();
    saveStepFingerprint('reference-index', tree.root, computeStepFingerprint('reference-index', tree.root));
    bumpMtime(tree.packageLock);
    const decision = decideStepGate('reference-index', tree.root, {});
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe('inputs-changed');
  });

  it('reference-index does NOT run on memory writes or guidance edits', async () => {
    const { decideStepGate, computeStepFingerprint, saveStepFingerprint } = await loadGate();
    saveStepFingerprint('reference-index', tree.root, computeStepFingerprint('reference-index', tree.root));
    bumpMtime(tree.memoryDb);
    bumpMtime(tree.guidanceFile);
    const decision = decideStepGate('reference-index', tree.root, {});
    expect(decision.skip).toBe(true);
  });

  it('guidance-index does NOT run on memory writes — the other #858 win', async () => {
    const { decideStepGate, computeStepFingerprint, saveStepFingerprint } = await loadGate();
    saveStepFingerprint('guidance-index', tree.root, computeStepFingerprint('guidance-index', tree.root));
    bumpMtime(tree.memoryDb);
    const decision = decideStepGate('guidance-index', tree.root, {});
    expect(decision.skip).toBe(true);
  });

  it('hnsw-rebuild runs when sidecar is missing', async () => {
    const { decideStepGate, computeStepFingerprint, saveStepFingerprint } = await loadGate();
    // Simulate a successful prior run with the sidecar present, then delete it.
    writeFileSync(tree.hnswSidecar, 'fake-sidecar');
    saveStepFingerprint('hnsw-rebuild', tree.root, computeStepFingerprint('hnsw-rebuild', tree.root));
    rmSync(tree.hnswSidecar);
    const decision = decideStepGate('hnsw-rebuild', tree.root, {});
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe('inputs-changed');
  });

  it('hnsw-rebuild runs when memory.db is newer than the sidecar', async () => {
    const { decideStepGate, computeStepFingerprint, saveStepFingerprint } = await loadGate();
    writeFileSync(tree.hnswSidecar, 'fake-sidecar');
    saveStepFingerprint('hnsw-rebuild', tree.root, computeStepFingerprint('hnsw-rebuild', tree.root));
    bumpMtime(tree.memoryDb);
    const decision = decideStepGate('hnsw-rebuild', tree.root, {});
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe('inputs-changed');
  });

  it('saved fingerprints persist per-step in a single file (round-trip)', async () => {
    const {
      computeStepFingerprint,
      saveStepFingerprint,
      readSavedStepFingerprint,
      FINGERPRINT_FILE_REL,
      FINGERPRINT_VERSION,
    } = await loadGate();

    const fp1 = computeStepFingerprint('guidance-index', tree.root);
    const fp2 = computeStepFingerprint('build-embeddings', tree.root);
    expect(saveStepFingerprint('guidance-index', tree.root, fp1)).toBe(true);
    expect(saveStepFingerprint('build-embeddings', tree.root, fp2)).toBe(true);

    expect(readSavedStepFingerprint('guidance-index', tree.root)).toEqual(fp1);
    expect(readSavedStepFingerprint('build-embeddings', tree.root)).toEqual(fp2);

    const fpFile = join(tree.root, FINGERPRINT_FILE_REL);
    const payload = JSON.parse(readFileSync(fpFile, 'utf8'));
    expect(payload.version).toBe(FINGERPRINT_VERSION);
    expect(Object.keys(payload.steps).sort()).toEqual(['build-embeddings', 'guidance-index']);
  });

  it('returns no-saved-fingerprint when payload is corrupt JSON', async () => {
    const { decideStepGate, FINGERPRINT_FILE_REL } = await loadGate();
    writeFileSync(join(tree.root, FINGERPRINT_FILE_REL), '{not valid json');
    const decision = decideStepGate('guidance-index', tree.root, {});
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe('no-saved-fingerprint');
  });

  it('returns no-saved-fingerprint when version doesn\'t match', async () => {
    const { decideStepGate, FINGERPRINT_FILE_REL, FINGERPRINT_VERSION } = await loadGate();
    writeFileSync(
      join(tree.root, FINGERPRINT_FILE_REL),
      JSON.stringify({ version: FINGERPRINT_VERSION - 1, steps: { 'guidance-index': {} } }),
    );
    const decision = decideStepGate('guidance-index', tree.root, {});
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe('no-saved-fingerprint');
  });

  it('returns no-saved-fingerprint for a step missing from the saved payload', async () => {
    const { decideStepGate, computeStepFingerprint, saveStepFingerprint } = await loadGate();
    // Save guidance but not build-embeddings
    saveStepFingerprint('guidance-index', tree.root, computeStepFingerprint('guidance-index', tree.root));
    const decision = decideStepGate('build-embeddings', tree.root, {});
    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe('no-saved-fingerprint');
  });

  it('cleanupLegacyFingerprint removes the v1 file from 4.9.7', async () => {
    const { cleanupLegacyFingerprint, LEGACY_FINGERPRINT_FILE_REL } = await loadGate();
    const legacy = join(tree.root, LEGACY_FINGERPRINT_FILE_REL);
    writeFileSync(legacy, '{"version":1}');
    expect(existsSync(legacy)).toBe(true);
    cleanupLegacyFingerprint(tree.root);
    expect(existsSync(legacy)).toBe(false);
  });

  it('cleanupLegacyFingerprint is a no-op when the file is absent', async () => {
    const { cleanupLegacyFingerprint } = await loadGate();
    expect(() => cleanupLegacyFingerprint(tree.root)).not.toThrow();
  });

  it('git-backed steps return a deterministic fingerprint when git is unavailable', async () => {
    const { computeStepFingerprint } = await loadGate();
    // tmpdir is not a git repo → git ls-files fails → null hash
    for (const stepName of GIT_BACKED_STEPS) {
      const fp = computeStepFingerprint(stepName, tree.root);
      const values = Object.values(fp);
      expect(values).toHaveLength(1);
      expect(values[0]).toBeNull();
    }
  });

  it('git-backed steps skip when null fingerprint round-trips', async () => {
    const { decideStepGate, computeStepFingerprint, saveStepFingerprint } = await loadGate();
    // Even with null hashes, equality of the same null pair → skip. This
    // matters in tmpdirs / non-repo consumers where git is absent: we don't
    // want to thrash the chain on a tree that genuinely has nothing to scan.
    saveStepFingerprint('code-map', tree.root, computeStepFingerprint('code-map', tree.root));
    const decision = decideStepGate('code-map', tree.root, {});
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe('unchanged');
  });
});
