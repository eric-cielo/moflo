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

  // ── index-all.mjs registers all indexers via consider() ──────────────
  // After #862 each step is registered through `consider(name, cfgKey,
  // scriptName, binName, args, ...)` and dispatched through a single
  // `runStep(step.name, ...)` call inside the plan loop. These tests pin
  // the registration shape rather than the dispatcher call site.

  it('index-all.mjs registers guidance indexer', () => {
    expect(indexAllContent).toMatch(
      /consider\(\s*'guidance-index'\s*,\s*'guidance'\s*,\s*'index-guidance\.mjs'\s*,\s*'flo-index'/,
    );
  });

  it('index-all.mjs registers code map generator', () => {
    expect(indexAllContent).toMatch(
      /consider\(\s*'code-map'\s*,\s*'code_map'\s*,\s*'generate-code-map\.mjs'\s*,\s*'flo-codemap'/,
    );
  });

  it('index-all.mjs registers test indexer', () => {
    expect(indexAllContent).toMatch(
      /consider\(\s*'test-index'\s*,\s*'tests'\s*,\s*'index-tests\.mjs'\s*,\s*'flo-testmap'/,
    );
  });

  it('index-all.mjs registers patterns indexer', () => {
    expect(indexAllContent).toMatch(
      /consider\(\s*'patterns-index'\s*,\s*'patterns'\s*,\s*'index-patterns\.mjs'\s*,\s*'flo-patterns'/,
    );
  });

  it('index-all.mjs registers pretrain step', () => {
    expect(indexAllContent).toMatch(/name:\s*'pretrain'/);
    expect(indexAllContent).toContain("'hooks', 'pretrain'");
  });

  it('index-all.mjs registers HNSW rebuild as final step', () => {
    expect(indexAllContent).toMatch(/name:\s*'hnsw-rebuild'/);
    // HNSW rebuild's plan entry must appear after every other `consider(`
    // call so the sequential loop runs it last.
    const lastConsider = indexAllContent.lastIndexOf('consider(');
    const hnswRebuild = indexAllContent.indexOf("name: 'hnsw-rebuild'");
    expect(hnswRebuild).toBeGreaterThan(lastConsider);
  });

  // ── auto_index flag support ───────────────────────────────────────
  // `consider()` consults `isIndexEnabled(cfgKey)` for steps that take a
  // moflo.yaml flag. Pin the helper + the four registered keys.

  it('index-all.mjs gates registration via isIndexEnabled', () => {
    expect(indexAllContent).toMatch(/isIndexEnabled\(\s*cfgKey\s*\)/);
  });

  it('index-all.mjs registers all four auto_index keys', () => {
    // The cfgKey arg of each consider() call.
    const keys = ['guidance', 'code_map', 'tests', 'patterns'];
    for (const k of keys) {
      expect(indexAllContent).toMatch(
        new RegExp(`consider\\(\\s*'[^']+'\\s*,\\s*'${k}'`),
      );
    }
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
