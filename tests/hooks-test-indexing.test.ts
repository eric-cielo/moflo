/**
 * Tests for hooks.mjs indexing integration (guidance, code-map, tests)
 *
 * Verifies:
 * - All three background indexer functions exist
 * - All are spawned during session-start
 * - All respect their auto_index flags from moflo.yaml
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const HOOKS_FILE = resolve(__dirname, '../bin/hooks.mjs');

describe('hooks.mjs indexing integration', () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(HOOKS_FILE, 'utf-8');
  });

  // ── Test indexer ──────────────────────────────────────────────────

  it('defines runTestIndexBackground function', () => {
    expect(content).toContain('function runTestIndexBackground()');
  });

  it('calls runTestIndexBackground in session-start', () => {
    const sessionStart = content.substring(
      content.indexOf("case 'session-start':"),
      content.indexOf("case 'session-restore':")
    );
    expect(sessionStart).toContain('runTestIndexBackground()');
  });

  it('checks auto_index.tests flag in moflo.yaml', () => {
    expect(content).toContain('auto_index.tests');
  });

  it('resolves index-tests.mjs via resolveBinOrLocal', () => {
    expect(content).toContain("resolveBinOrLocal('flo-testmap', 'index-tests.mjs')");
  });

  it('uses spawnWindowless for background test execution', () => {
    const fn = content.substring(
      content.indexOf('function runTestIndexBackground'),
      content.indexOf('function runBackgroundTraining')
    );
    expect(fn).toContain('spawnWindowless');
  });

  // ── Guidance indexer ──────────────────────────────────────────────

  it('checks auto_index.guidance flag in runIndexGuidanceBackground', () => {
    const fn = content.substring(
      content.indexOf('function runIndexGuidanceBackground'),
      content.indexOf('function runCodeMapBackground')
    );
    expect(fn).toContain('auto_index.guidance');
    expect(fn).toContain("match[1] === 'false'");
  });

  it('only gates full guidance indexing, not per-file calls', () => {
    const fn = content.substring(
      content.indexOf('function runIndexGuidanceBackground'),
      content.indexOf('function runCodeMapBackground')
    );
    // The flag check should be inside an if (!specificFile) block
    expect(fn).toContain('if (!specificFile)');
  });

  // ── Code map indexer ──────────────────────────────────────────────

  it('checks auto_index.code_map flag in runCodeMapBackground', () => {
    const fn = content.substring(
      content.indexOf('function runCodeMapBackground'),
      content.indexOf('function runTestIndexBackground')
    );
    expect(fn).toContain('auto_index.code_map');
    expect(fn).toContain("match[1] === 'false'");
  });
});
