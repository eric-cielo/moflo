/**
 * Tests for session-start indexing integration.
 *
 * Verifies:
 * - session-start delegates to index-all.mjs (sequential chain)
 * - index-all.mjs runs all indexers + HNSW rebuild in correct order
 * - index-all.mjs respects auto_index flags from moflo.yaml
 * - runIndexGuidanceBackground still exists for post-edit per-file use
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const HOOKS_FILE = resolve(__dirname, '../bin/hooks.mjs');
const INDEX_ALL_FILE = resolve(__dirname, '../bin/index-all.mjs');

describe('hooks.mjs indexing integration', () => {
  let hooksContent: string;
  let indexAllContent: string;

  beforeAll(() => {
    hooksContent = readFileSync(HOOKS_FILE, 'utf-8');
    indexAllContent = readFileSync(INDEX_ALL_FILE, 'utf-8');
  });

  // ── Session-start delegates to index-all.mjs ─────────────────────

  it('session-start spawns index-all.mjs as sequential indexing chain', () => {
    const sessionStart = hooksContent.substring(
      hooksContent.indexOf("case 'session-start':"),
      hooksContent.indexOf("case 'session-restore':")
    );
    expect(sessionStart).toContain('index-all.mjs');
    expect(sessionStart).toContain('sequential indexing chain');
  });

  // ── index-all.mjs runs all indexers sequentially ──────────────────

  it('index-all.mjs runs guidance indexer', () => {
    expect(indexAllContent).toContain("resolveBin('flo-index', 'index-guidance.mjs')");
    expect(indexAllContent).toContain("runStep('guidance-index'");
  });

  it('index-all.mjs runs code map generator', () => {
    expect(indexAllContent).toContain("resolveBin('flo-codemap', 'generate-code-map.mjs')");
    expect(indexAllContent).toContain("runStep('code-map'");
  });

  it('index-all.mjs runs test indexer', () => {
    expect(indexAllContent).toContain("resolveBin('flo-testmap', 'index-tests.mjs')");
    expect(indexAllContent).toContain("runStep('test-index'");
  });

  it('index-all.mjs runs patterns indexer', () => {
    expect(indexAllContent).toContain("resolveBin('flo-patterns', 'index-patterns.mjs')");
    expect(indexAllContent).toContain("runStep('patterns-index'");
  });

  it('index-all.mjs runs pretrain', () => {
    expect(indexAllContent).toContain("runStep('pretrain'");
  });

  it('index-all.mjs runs HNSW rebuild as final step', () => {
    expect(indexAllContent).toContain("runStep('hnsw-rebuild'");
    // HNSW rebuild must appear after all other runStep calls
    const lastIndexer = indexAllContent.lastIndexOf("runStep('pretrain'");
    const hnswRebuild = indexAllContent.indexOf("runStep('hnsw-rebuild'");
    expect(hnswRebuild).toBeGreaterThan(lastIndexer);
  });

  // ── auto_index flag support ───────────────────────────────────────

  it('index-all.mjs checks auto_index flags via isIndexEnabled', () => {
    expect(indexAllContent).toContain("isIndexEnabled('guidance')");
    expect(indexAllContent).toContain("isIndexEnabled('code_map')");
    expect(indexAllContent).toContain("isIndexEnabled('tests')");
    expect(indexAllContent).toContain("isIndexEnabled('patterns')");
  });

  it('isIndexEnabled reads moflo.yaml and respects false flag', () => {
    expect(indexAllContent).toContain('moflo.yaml');
    expect(indexAllContent).toContain("'false'");
  });

  // ── Guidance indexer still available for post-edit ─────────────────

  it('runIndexGuidanceBackground still exists for per-file indexing', () => {
    expect(hooksContent).toContain('function runIndexGuidanceBackground');
  });

  it('guidance indexer gates full indexing but not per-file calls', () => {
    const fn = hooksContent.substring(
      hooksContent.indexOf('function runIndexGuidanceBackground'),
      hooksContent.indexOf('function runIndexGuidanceBackground') + 1000
    );
    expect(fn).toContain('if (!specificFile)');
  });
});
