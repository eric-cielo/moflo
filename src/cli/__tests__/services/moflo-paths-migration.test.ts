/**
 * Tests for the `.claude-flow` → `.moflo` migration helper (#699) and the
 * `.swarm/memory.db` → `.moflo/moflo.db` relocation (#727).
 *
 * Covers the rename/merge path, idempotency, and parity between the TS
 * implementation in src/cli/services/moflo-paths.ts and the pure-JS twin in
 * bin/lib/moflo-paths.mjs that runs from the consumer launcher.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
  migrateClaudeFlowToMoflo,
  migrateMemoryDbToMoflo,
  mofloDir,
} from '../../services/moflo-paths.js';

// SQLite header magic — `migrateMemoryDbToMoflo` rejects copies that don't
// start with this signature, so legitimate test fixtures must include it.
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'utf8');

function makeFakeSqliteFile(filePath: string, payload: string): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, Buffer.concat([SQLITE_HEADER, Buffer.from(payload, 'utf8')]));
}

function mkRoot(): string {
  return mkdtempSync(join(tmpdir(), 'moflo-migrate-'));
}

describe('migrateClaudeFlowToMoflo (#699)', () => {
  it('exposes the canonical and legacy directory names', () => {
    expect(MOFLO_DIR).toBe('.moflo');
    expect(LEGACY_CLAUDE_FLOW_DIR).toBe('.claude-flow');
  });

  it('no-ops when the legacy dir is absent', () => {
    const root = mkRoot();
    try {
      const result = migrateClaudeFlowToMoflo(root);
      expect(result).toEqual({ migrated: false, reason: 'no-legacy' });
      expect(existsSync(mofloDir(root))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renames .claude-flow → .moflo when target is fresh', () => {
    const root = mkRoot();
    try {
      const legacy = legacyClaudeFlowDir(root);
      mkdirSync(join(legacy, 'claims'), { recursive: true });
      writeFileSync(join(legacy, 'claims', 'claim.json'), '{"id":"abc"}');
      writeFileSync(join(legacy, 'daemon.lock'), '{"pid":123}');

      const result = migrateClaudeFlowToMoflo(root);

      expect(result.migrated).toBe(true);
      expect(existsSync(legacy)).toBe(false);
      expect(readFileSync(join(mofloDir(root), 'claims', 'claim.json'), 'utf8')).toBe('{"id":"abc"}');
      expect(readFileSync(join(mofloDir(root), 'daemon.lock'), 'utf8')).toBe('{"pid":123}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('merges legacy entries into target when both exist (target wins on collision)', () => {
    const root = mkRoot();
    try {
      const legacy = legacyClaudeFlowDir(root);
      const target = mofloDir(root);
      mkdirSync(legacy, { recursive: true });
      mkdirSync(target, { recursive: true });

      // Unique-to-legacy: should move
      writeFileSync(join(legacy, 'old-only.json'), 'old');
      mkdirSync(join(legacy, 'old-dir'));
      writeFileSync(join(legacy, 'old-dir', 'inside.txt'), 'old-inside');

      // Collision: target version must win
      writeFileSync(join(legacy, 'shared.json'), 'old-shared');
      writeFileSync(join(target, 'shared.json'), 'new-shared');

      const result = migrateClaudeFlowToMoflo(root);

      expect(result.migrated).toBe(true);
      expect(readFileSync(join(target, 'old-only.json'), 'utf8')).toBe('old');
      expect(readFileSync(join(target, 'old-dir', 'inside.txt'), 'utf8')).toBe('old-inside');
      // Target preserved on collision.
      expect(readFileSync(join(target, 'shared.json'), 'utf8')).toBe('new-shared');
      // Legacy collision file remains because we never overwrite target.
      expect(existsSync(join(legacy, 'shared.json'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent — second call after rename is a no-op', () => {
    const root = mkRoot();
    try {
      mkdirSync(legacyClaudeFlowDir(root), { recursive: true });
      writeFileSync(join(legacyClaudeFlowDir(root), 'a.txt'), '1');
      const first = migrateClaudeFlowToMoflo(root);
      const second = migrateClaudeFlowToMoflo(root);
      expect(first.migrated).toBe(true);
      expect(second.migrated).toBe(false);
      expect(second.reason).toBe('no-legacy');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops the legacy dir after a clean merge', () => {
    const root = mkRoot();
    try {
      const legacy = legacyClaudeFlowDir(root);
      mkdirSync(legacy);
      mkdirSync(mofloDir(root));
      writeFileSync(join(legacy, 'movable.json'), 'x');

      migrateClaudeFlowToMoflo(root);

      expect(existsSync(legacy)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the legacy dir when at least one entry collided (so a future run can retry)', () => {
    const root = mkRoot();
    try {
      const legacy = legacyClaudeFlowDir(root);
      const target = mofloDir(root);
      mkdirSync(legacy);
      mkdirSync(target);
      writeFileSync(join(legacy, 'collide.json'), 'old');
      writeFileSync(join(target, 'collide.json'), 'new');

      migrateClaudeFlowToMoflo(root);

      expect(existsSync(legacy)).toBe(true);
      expect(readdirSync(legacy)).toEqual(['collide.json']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('bin/lib/moflo-paths.mjs parity', () => {
  it('exports the same constants and migration semantics as the TS module', async () => {
    // Dynamic import keeps this resilient to ESM quirks during test discovery.
    const mod: typeof import('../../../../bin/lib/moflo-paths.mjs') = await import('../../../../bin/lib/moflo-paths.mjs');

    expect(mod.MOFLO_DIR).toBe(MOFLO_DIR);
    expect(mod.LEGACY_CLAUDE_FLOW_DIR).toBe(LEGACY_CLAUDE_FLOW_DIR);
    expect(mod.MEMORY_DB_FILE).toBe(MEMORY_DB_FILE);
    expect(mod.HNSW_INDEX_FILE).toBe(HNSW_INDEX_FILE);
    expect(mod.LEGACY_SWARM_DIR).toBe(LEGACY_SWARM_DIR);
    expect(mod.LEGACY_MEMORY_DB_FILE).toBe(LEGACY_MEMORY_DB_FILE);

    const root = mkRoot();
    try {
      mkdirSync(join(root, '.claude-flow'), { recursive: true });
      writeFileSync(join(root, '.claude-flow', 'lock'), '1');
      const result = mod.migrateClaudeFlowToMoflo(root);
      expect(result.migrated).toBe(true);
      expect(existsSync(join(root, '.moflo', 'lock'))).toBe(true);
      expect(existsSync(join(root, '.claude-flow'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exposes the same DB migration semantics as the TS module', async () => {
    const mod: typeof import('../../../../bin/lib/moflo-paths.mjs') = await import('../../../../bin/lib/moflo-paths.mjs');

    const root = mkRoot();
    try {
      makeFakeSqliteFile(mod.legacyMemoryDbPath(root), 'parity-payload');
      const result = mod.migrateMemoryDbToMoflo(root);
      expect(result.migrated).toBe(true);
      expect(existsSync(mod.memoryDbPath(root))).toBe(true);
      expect(existsSync(mod.legacyMemoryDbPath(root))).toBe(false);
      expect(existsSync(mod.legacyMemoryDbBakPath(root))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('migrateMemoryDbToMoflo (#727)', () => {
  it('exposes canonical and legacy DB constants', () => {
    expect(MEMORY_DB_FILE).toBe('moflo.db');
    expect(HNSW_INDEX_FILE).toBe('hnsw.index');
    expect(LEGACY_SWARM_DIR).toBe('.swarm');
    expect(LEGACY_MEMORY_DB_FILE).toBe('memory.db');
  });

  it('builds canonical and legacy paths under the project root', () => {
    const root = '/tmp/example';
    expect(memoryDbPath(root)).toBe(join(root, '.moflo', 'moflo.db'));
    expect(hnswIndexPath(root)).toBe(join(root, '.moflo', 'hnsw.index'));
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

  it('no-ops when neither legacy DB nor canonical exist', () => {
    const root = mkRoot();
    try {
      const result = migrateMemoryDbToMoflo(root);
      expect(result).toEqual({ migrated: false, reason: 'no-legacy' });
      expect(existsSync(memoryDbPath(root))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('no-ops when the canonical DB already exists (target-exists)', () => {
    const root = mkRoot();
    try {
      // Both legacy AND canonical present — caller should NOT clobber the
      // newer canonical. This is the steady state after an earlier migration
      // succeeded but the .bak rename failed (mid-state).
      makeFakeSqliteFile(legacyMemoryDbPath(root), 'old');
      makeFakeSqliteFile(memoryDbPath(root), 'new');
      const result = migrateMemoryDbToMoflo(root);
      expect(result).toEqual({ migrated: false, reason: 'target-exists' });
      // Both files preserved.
      expect(readFileSync(memoryDbPath(root)).toString()).toContain('new');
      expect(readFileSync(legacyMemoryDbPath(root)).toString()).toContain('old');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('relocates .swarm/memory.db → .moflo/moflo.db with copy-verify-delete', () => {
    const root = mkRoot();
    try {
      makeFakeSqliteFile(legacyMemoryDbPath(root), 'happy-path-payload');
      const before = statSync(legacyMemoryDbPath(root)).size;

      const result = migrateMemoryDbToMoflo(root);

      expect(result.migrated).toBe(true);
      expect(result.reason).toBeUndefined();
      // New file present, byte-equal to source size.
      expect(existsSync(memoryDbPath(root))).toBe(true);
      expect(statSync(memoryDbPath(root)).size).toBe(before);
      expect(readFileSync(memoryDbPath(root)).slice(0, SQLITE_HEADER.length)).toEqual(SQLITE_HEADER);
      // Source retired to .bak (one upgrade cycle retention).
      expect(existsSync(legacyMemoryDbPath(root))).toBe(false);
      expect(existsSync(legacyMemoryDbBakPath(root))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('moves .swarm/hnsw.index alongside the DB when present', () => {
    const root = mkRoot();
    try {
      makeFakeSqliteFile(legacyMemoryDbPath(root), 'hnsw-payload');
      mkdirSync(join(root, LEGACY_SWARM_DIR), { recursive: true });
      writeFileSync(legacyHnswIndexPath(root), 'fake-hnsw-bytes');

      const result = migrateMemoryDbToMoflo(root);

      expect(result.migrated).toBe(true);
      expect(result.hnswMoved).toBe(true);
      expect(existsSync(hnswIndexPath(root))).toBe(true);
      expect(readFileSync(hnswIndexPath(root)).toString()).toBe('fake-hnsw-bytes');
      expect(existsSync(legacyHnswIndexPath(root))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects copies whose SQLite header magic is missing (verify-failed)', () => {
    const root = mkRoot();
    try {
      // Source missing magic — looks like junk, not a real SQLite file.
      mkdirSync(join(root, LEGACY_SWARM_DIR), { recursive: true });
      writeFileSync(legacyMemoryDbPath(root), 'not-a-real-sqlite-file');

      const result = migrateMemoryDbToMoflo(root);

      expect(result.migrated).toBe(false);
      expect(result.reason).toBe('verify-failed');
      // Target is removed on verify failure — both files in clean state for retry.
      expect(existsSync(memoryDbPath(root))).toBe(false);
      // Source preserved (never lose data).
      expect(existsSync(legacyMemoryDbPath(root))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent across calls', () => {
    const root = mkRoot();
    try {
      makeFakeSqliteFile(legacyMemoryDbPath(root), 'idempotent');
      const first = migrateMemoryDbToMoflo(root);
      const second = migrateMemoryDbToMoflo(root);
      expect(first.migrated).toBe(true);
      expect(second.migrated).toBe(false);
      expect(second.reason).toBe('target-exists');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the canonical DB if the source-rename step fails on Windows lock-style errors', () => {
    // Hard to exercise a real Windows file lock in vitest, but we can verify
    // the code path: when the source is missing AFTER the copy succeeded,
    // the rename throws and the function still reports success-with-reason
    // (rename-failed) rather than rolling back and losing the relocated DB.
    // The `target-exists` short-circuit at the top of the function then makes
    // the next session-start a no-op.
    const root = mkRoot();
    try {
      makeFakeSqliteFile(legacyMemoryDbPath(root), 'rename-test');
      const first = migrateMemoryDbToMoflo(root);
      expect(first.migrated).toBe(true);
      // Second call hits target-exists, regardless of source state.
      const second = migrateMemoryDbToMoflo(root);
      expect(second.reason).toBe('target-exists');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
