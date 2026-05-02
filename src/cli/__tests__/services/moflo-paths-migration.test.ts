/**
 * Tests for the moflo runtime-state path constants + helpers in
 * `cli/services/moflo-paths.ts` and the pure-JS twin at
 * `bin/lib/moflo-paths.mjs`.
 *
 * Story #851 retired the launcher's automatic `.claude-flow/` rename and
 * `.swarm/memory.db` byte-copy migrations — those legacy paths are now
 * read-only sources for the cherry-pick (see
 * `cherry-pick-learnings.test.ts`). All this file checks now is that the
 * path constants stay aligned across the TS module and the JS twin.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import {
  HNSW_INDEX_FILE,
  LEGACY_CLAUDE_FLOW_DIR,
  LEGACY_MEMORY_DB_FILE,
  LEGACY_SWARM_DIR,
  MEMORY_DB_FILE,
  MOFLO_DIR,
  hnswIndexPath,
  legacyClaudeFlowDir,
  legacyHnswIndexPath,
  legacyMemoryDbBakPath,
  legacyMemoryDbPath,
  memoryDbCandidatePaths,
  memoryDbPath,
  mofloDir,
} from '../../services/moflo-paths.js';

describe('moflo-paths constants', () => {
  it('exposes the canonical + legacy directory and filename constants', () => {
    expect(MOFLO_DIR).toBe('.moflo');
    expect(MEMORY_DB_FILE).toBe('moflo.db');
    expect(HNSW_INDEX_FILE).toBe('hnsw.index');
    expect(LEGACY_CLAUDE_FLOW_DIR).toBe('.claude-flow');
    expect(LEGACY_SWARM_DIR).toBe('.swarm');
    expect(LEGACY_MEMORY_DB_FILE).toBe('memory.db');
  });

  it('builds canonical and legacy paths under the project root', () => {
    const root = '/tmp/example';
    expect(mofloDir(root)).toBe(join(root, '.moflo'));
    expect(memoryDbPath(root)).toBe(join(root, '.moflo', 'moflo.db'));
    expect(hnswIndexPath(root)).toBe(join(root, '.moflo', 'hnsw.index'));
    expect(legacyClaudeFlowDir(root)).toBe(join(root, '.claude-flow'));
    expect(legacyMemoryDbPath(root)).toBe(join(root, '.swarm', 'memory.db'));
    expect(legacyHnswIndexPath(root)).toBe(join(root, '.swarm', 'hnsw.index'));
    expect(legacyMemoryDbBakPath(root)).toBe(join(root, '.swarm', 'memory.db.bak'));
  });

  it('memoryDbCandidatePaths leads with canonical, falls back to legacy', () => {
    const root = '/tmp/example';
    const paths = memoryDbCandidatePaths(root);
    expect(paths[0]).toBe(memoryDbPath(root));
    expect(paths[1]).toBe(legacyMemoryDbPath(root));
    expect(paths.length).toBeGreaterThanOrEqual(2);
  });
});

describe('bin/lib/moflo-paths.mjs parity', () => {
  it('exports the same constants and helpers as the TS module', async () => {
    // Dynamic import keeps this resilient to ESM quirks during test discovery.
    const mod: typeof import('../../../../bin/lib/moflo-paths.mjs') = await import(
      '../../../../bin/lib/moflo-paths.mjs'
    );

    expect(mod.MOFLO_DIR).toBe(MOFLO_DIR);
    expect(mod.LEGACY_CLAUDE_FLOW_DIR).toBe(LEGACY_CLAUDE_FLOW_DIR);
    expect(mod.MEMORY_DB_FILE).toBe(MEMORY_DB_FILE);
    expect(mod.HNSW_INDEX_FILE).toBe(HNSW_INDEX_FILE);
    expect(mod.LEGACY_SWARM_DIR).toBe(LEGACY_SWARM_DIR);
    expect(mod.LEGACY_MEMORY_DB_FILE).toBe(LEGACY_MEMORY_DB_FILE);

    const root = '/tmp/parity';
    expect(mod.mofloDir(root)).toBe(mofloDir(root));
    expect(mod.memoryDbPath(root)).toBe(memoryDbPath(root));
    expect(mod.legacyMemoryDbPath(root)).toBe(legacyMemoryDbPath(root));
    expect(mod.legacyMemoryDbBakPath(root)).toBe(legacyMemoryDbBakPath(root));
    expect(mod.memoryDbCandidatePaths(root)).toEqual(memoryDbCandidatePaths(root));
  });
});
